/**
 * CRIT-003 / governance safety: proposal threshold, vote checkpoints (snapshot),
 * queue → EXECUTION_DELAY → execute ordering, and flash-style vote weight.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

const GOV_FQ = "contracts/_full/core/Governance.sol:Governance";
const TWO_DAYS = 2n * 24n * 60n * 60n;

async function deployFixture() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  const Proto = await ethers.getContractFactory("ProtocolToken");
  const token = await Proto.deploy(deployer.address);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const votingPeriod = 20n;
  const quorum = ethers.parseEther("50");
  const minProposalThreshold = ethers.parseEther("1000");

  const Gov = await ethers.getContractFactory(GOV_FQ);
  const gov = await Gov.deploy(tokenAddr, votingPeriod, quorum, minProposalThreshold, deployer.address);
  await gov.waitForDeployment();

  return {
    deployer,
    alice,
    bob,
    carol,
    token,
    gov,
    tokenAddr,
    votingPeriod,
    quorum,
    minProposalThreshold,
  };
}

describe("Governance (CRIT-003 integration)", function () {
  let snapshot;
  beforeEach(async function () {
    snapshot = await takeSnapshot();
  });
  afterEach(async function () {
    await snapshot.restore();
  });

  it("reverts propose when balanceOf(proposer) < minProposalThreshold", async function () {
    const { carol, gov, token } = await deployFixture();
    await (await token.transfer(carol.address, ethers.parseEther("500"))).wait();
    await (await token.connect(carol).delegate(carol.address)).wait();

    await expect(
      gov.connect(carol).propose(ethers.ZeroAddress, 0, "0x")
    ).to.be.revertedWith("Governance: insufficient voting power at snapshot");
  });

  it("vote uses getPastVotes at snapshotBlock after proposer transfers all tokens away", async function () {
    const { deployer, alice, gov, token } = await deployFixture();
    const amount = ethers.parseEther("5000");
    await (await token.transfer(alice.address, amount)).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();

    const target = deployer.address;
    const tx = await gov.connect(alice).propose(target, 0, "0x");
    await tx.wait();
    const id = 1n;

    await (await token.connect(alice).transfer(deployer.address, await token.balanceOf(alice.address))).wait();
    expect(await token.balanceOf(alice.address)).to.equal(0n);

    await expect(gov.connect(alice).vote(id, true)).to.emit(gov, "Voted");
    const p = await gov.proposals(id);
    expect(p.forVotes).to.be.gt(0n);
  });

  it("execute reverts if never queue'd (after voting ended)", async function () {
    const { deployer, alice, gov, token, votingPeriod } = await deployFixture();
    await (await token.transfer(alice.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();

    await (await gov.connect(alice).propose(deployer.address, 0, "0x")).wait();
    const id = 1n;
    await (await gov.connect(alice).vote(id, true)).wait();

    await mine(votingPeriod + 5n);

    await expect(gov.execute(id)).to.be.revertedWith("Governance: not queued");
  });

  it("execute reverts when queue'd but block.timestamp < queuedAt + EXECUTION_DELAY", async function () {
    const { deployer, alice, gov, token, votingPeriod } = await deployFixture();
    await (await token.transfer(alice.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();

    await (await gov.connect(alice).propose(deployer.address, 0, "0x")).wait();
    const id = 1n;
    await (await gov.connect(alice).vote(id, true)).wait();
    await mine(votingPeriod + 5n);

    await (await gov.queue(id)).wait();
    await expect(gov.execute(id)).to.be.revertedWith("Governance: timelock active");
  });

  it("after queue + time.increase(2 days), execute succeeds", async function () {
    const { deployer, alice, gov, token, votingPeriod } = await deployFixture();
    await (await token.transfer(alice.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();

    await (await gov.connect(alice).propose(deployer.address, 0, "0x")).wait();
    const id = 1n;
    await (await gov.connect(alice).vote(id, true)).wait();
    await mine(votingPeriod + 5n);

    await (await gov.queue(id)).wait();
    await time.increase(TWO_DAYS);

    await expect(gov.execute(id)).to.emit(gov, "Executed").withArgs(id);
    const p = await gov.proposals(id);
    expect(p.executed).to.equal(true);
  });

  it("flash-style voter: tokens moved away before vote; weight still from snapshot", async function () {
    const { deployer, alice, bob, gov, token } = await deployFixture();
    await (await token.transfer(alice.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();

    await (await token.transfer(bob.address, ethers.parseEther("8000"))).wait();
    await (await token.connect(bob).delegate(bob.address)).wait();

    await (await gov.connect(alice).propose(deployer.address, 0, "0x")).wait();
    const id = 1n;

    await (await token.connect(bob).transfer(deployer.address, await token.balanceOf(bob.address))).wait();
    expect(await token.balanceOf(bob.address)).to.equal(0n);

    await expect(gov.connect(bob).vote(id, true)).to.emit(gov, "Voted");
    const p = await gov.proposals(id);
    expect(p.forVotes).to.equal(ethers.parseEther("8000"));
  });
});
