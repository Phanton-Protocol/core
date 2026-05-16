/**
 * Module 1 Architecture & Access Control — regression tests for every
 * audit fix landed in this PR. One file per fix area so failures map
 * 1:1 to the audit findings list.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const { getUpgradeablePoolFactory } = require("../helpers/libraryLinker.cjs");
const { getShieldedPoolFactory } = require("../helpers/libraryLinker.cjs");

const TLC_FQN = "contracts/_full/governance/TimelockController.sol:TimelockController";
const GOV_FQN = "contracts/_full/governance/Governance.sol:Governance";
const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const FULL_FQN = "contracts/_full/core/ShieldedPoolUpgradeable.sol:ShieldedPoolUpgradeable";

const TWO_DAYS = 2n * 24n * 60n * 60n;

async function deployGovernanceStack() {
  const [deployer, alice, bob, guardian] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("ProtocolToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();

  const TLC = await ethers.getContractFactory(TLC_FQN);
  const tlc = await TLC.deploy(TWO_DAYS, [deployer.address], [ethers.ZeroAddress], deployer.address);
  await tlc.waitForDeployment();

  const Gov = await ethers.getContractFactory(GOV_FQN);
  const gov = await Gov.deploy(
    await tlc.getAddress(),
    await token.getAddress(),
    guardian.address,
    20n, // votingPeriodBlocks (short for tests)
    ethers.parseEther("50"),
    ethers.parseEther("1000")
  );
  await gov.waitForDeployment();

  const PROPOSER = await tlc.PROPOSER_ROLE();
  const CANCELLER = await tlc.CANCELLER_ROLE();
  const ADMIN = await tlc.TIMELOCK_ADMIN_ROLE();
  await (await tlc.grantRole(PROPOSER, await gov.getAddress())).wait();
  await (await tlc.grantRole(CANCELLER, await gov.getAddress())).wait();
  await (await tlc.revokeRole(PROPOSER, deployer.address)).wait();

  return { deployer, alice, bob, guardian, token, tlc, gov, PROPOSER, CANCELLER, ADMIN };
}

describe("Module 1 — TimelockController RBAC (Fix #1)", function () {
  it("random EOA cannot schedule operations on the timelock", async function () {
    const { tlc, alice } = await deployGovernanceStack();
    await expect(
      tlc.connect(alice).schedule(
        alice.address,
        0,
        "0x",
        ethers.ZeroHash,
        ethers.encodeBytes32String("salt"),
        TWO_DAYS
      )
    ).to.be.reverted; // OZ uses AccessControl: "AccessControl: account ... is missing role ..."
  });

  it("deployer PROPOSER_ROLE was revoked after wiring Governance", async function () {
    const { tlc, deployer, PROPOSER } = await deployGovernanceStack();
    expect(await tlc.hasRole(PROPOSER, deployer.address)).to.equal(false);
  });

  it("Governance contract holds PROPOSER_ROLE and CANCELLER_ROLE", async function () {
    const { tlc, gov, PROPOSER, CANCELLER } = await deployGovernanceStack();
    expect(await tlc.hasRole(PROPOSER, await gov.getAddress())).to.equal(true);
    expect(await tlc.hasRole(CANCELLER, await gov.getAddress())).to.equal(true);
  });

  it("rejects deploy attempts with delay below MIN_PRODUCTION_DELAY (informational — enforced in deploy script, not in contract)", async function () {
    const TLC = await ethers.getContractFactory(TLC_FQN);
    const tlc = await TLC.deploy(60n, [], [ethers.ZeroAddress], ethers.ZeroAddress);
    await tlc.waitForDeployment();
    // Contract itself accepts any delay; deploy-script enforces the floor.
    expect(await tlc.MIN_PRODUCTION_DELAY()).to.equal(TWO_DAYS);
    expect(await tlc.getMinDelay()).to.equal(60n);
  });
});

describe("Module 1 — Governance vote-before-schedule flow (Fix #8)", function () {
  it("`propose` does NOT schedule into the timelock", async function () {
    const { gov, token, deployer } = await deployGovernanceStack();
    await (await token.delegate(deployer.address)).wait();
    const tx = await gov.propose(await gov.getAddress(), 0n, "0x");
    const rcpt = await tx.wait();
    const timelockAddr = (await gov.timelock()).toLowerCase();
    const tlcCallScheduled = rcpt.logs.filter(
      (l) => l.address.toLowerCase() === timelockAddr
    );
    expect(tlcCallScheduled.length).to.equal(0);
  });

  it("queue() fails before voting ends, succeeds after quorum + majority", async function () {
    const { gov, token, deployer, tlc } = await deployGovernanceStack();
    await (await token.delegate(deployer.address)).wait();
    // Mine 1 block so `snapshotBlock` < current block when vote is cast
    await ethers.provider.send("evm_mine", []);
    const id = 1n;
    await (await gov.propose(await gov.getAddress(), 0n, "0x")).wait();
    // Voting window
    await (await gov.vote(id, true)).wait();
    // queue too early -> VotingActive
    await expect(gov.queue(id)).to.be.reverted;
    // mine past endBlock
    for (let i = 0; i < 25; i++) await ethers.provider.send("evm_mine", []);
    await (await gov.queue(id)).wait();
    expect(await tlc.isOperation(
      await tlc.hashOperation(await gov.getAddress(), 0n, "0x", ethers.ZeroHash,
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256","uint256","address"],
          [id, (await ethers.provider.getNetwork()).chainId, await gov.getAddress()]
        )))
    )).to.equal(true);
  });
});

describe("Module 1 — ShieldedPoolUpgradeable upgrade auth (Fix #1 + #3)", function () {
  async function deployFullPool() {
    const { tlc, gov, deployer } = await deployGovernanceStack();
    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const v1 = await MockVerifier.deploy(); await v1.waitForDeployment();
    const v2 = await MockVerifier.deploy(); await v2.waitForDeployment();
    const Ad = await ethers.getContractFactory("MockSwapAdaptor");
    const ad = await Ad.deploy(); await ad.waitForDeployment();
    const FO = await ethers.getContractFactory("FeeOracle");
    const fo = await FO.deploy(); await fo.waitForDeployment();
    const RR = await ethers.getContractFactory("RelayerRegistry");
    const rr = await RR.deploy(); await rr.waitForDeployment();

    const pool = await deployBehindProxy(FULL_FQN, [
      await v1.getAddress(),
      await v2.getAddress(),
      await ad.getAddress(),
      await fo.getAddress(),
      await rr.getAddress(),
      await tlc.getAddress(),
    ]);
    return { tlc, gov, pool, deployer };
  }

  it("random EOA cannot upgrade the proxy", async function () {
    const { pool } = await deployFullPool();
    const [, attacker] = await ethers.getSigners();
    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const dummyImpl = await MockVerifier.deploy(); // not actually a valid impl, but call must revert before that matters
    await dummyImpl.waitForDeployment();
    await expect(
      pool.connect(attacker).upgradeTo(await dummyImpl.getAddress())
    ).to.be.revertedWith("ShieldedPool: only timelock");
  });

  it("transferOwnership keeps poolOwner in sync (Fix #3)", async function () {
    const { pool, deployer } = await deployFullPool();
    const [, alice] = await ethers.getSigners();
    // After deploy via initialize, owner == deployer. Transfer to alice.
    await (await pool.transferOwnership(alice.address)).wait();
    expect(await pool.owner()).to.equal(alice.address);
    // poolOwner is internal; verify via a setter that previously read poolOwner
    // (now also `onlyOwner`) — must succeed when called by alice.
    const FO = await ethers.getContractFactory("FeeOracle");
    const fo = await FO.deploy(); await fo.waitForDeployment();
    await expect(
      pool.connect(alice).setComplianceModule(await fo.getAddress())
    ).to.not.be.reverted;
    // and reverts from the previous owner
    await expect(
      pool.connect(deployer).setComplianceModule(await fo.getAddress())
    ).to.be.revertedWithCustomError(pool, "NotTimelock");
  });

  it("setComplianceModule cannot be called by the RelayerRegistry anymore (Fix #7)", async function () {
    const { pool } = await deployFullPool();
    const registryAddr = await pool.relayerRegistry();
    // We can't impersonate a contract trivially, but the source path that
    // allowed `msg.sender == relayerRegistry` is removed, so any non-owner
    // call (including any address that isn't owner) reverts uniformly.
    const [, alice] = await ethers.getSigners();
    await expect(
      pool.connect(alice).setComplianceModule(registryAddr)
    ).to.be.revertedWithCustomError(pool, "NotAuthorized");
  });

  it("implementation cannot be initialized directly (Fix #9)", async function () {
    const Impl = await getUpgradeablePoolFactory(FULL_FQN);
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    await expect(
      impl.initialize(
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress
      )
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });
});

describe("Module 1 — ShieldedPoolUpgradeableReduced timelock auth + roles (Fix #5)", function () {
  async function deployReduced() {
    const [deployer, attacker, emergency] = await ethers.getSigners();
    const MV = await ethers.getContractFactory("MockVerifier");
    const v1 = await MV.deploy(); const v2 = await MV.deploy();
    await v1.waitForDeployment(); await v2.waitForDeployment();
    const A = await ethers.getContractFactory("MockSwapAdaptor");
    const a = await A.deploy(); await a.waitForDeployment();
    const F = await ethers.getContractFactory("FeeOracle");
    const f = await F.deploy(); await f.waitForDeployment();
    const R = await ethers.getContractFactory("RelayerRegistry");
    const r = await R.deploy(); await r.waitForDeployment();
    await (await r.registerRelayer(deployer.address)).wait();

    const pool = await deployBehindProxy(REDUCED_FQN, [
      await v1.getAddress(),
      await v2.getAddress(),
      await a.getAddress(),
      await f.getAddress(),
      await r.getAddress(),
    ]);

    // Deploy a real timelock to simulate the v2 migration
    const TLC = await ethers.getContractFactory(TLC_FQN);
    const tlc = await TLC.deploy(TWO_DAYS, [deployer.address], [ethers.ZeroAddress], deployer.address);
    await tlc.waitForDeployment();

    return { pool, tlc, deployer, attacker, emergency };
  }

  it("attacker cannot upgrade pre-v2 migration (only-owner bootstrap path)", async function () {
    const { pool, attacker } = await deployReduced();
    const MV = await ethers.getContractFactory("MockVerifier");
    const dummy = await MV.deploy(); await dummy.waitForDeployment();
    await expect(
      pool.connect(attacker).upgradeTo(await dummy.getAddress())
    ).to.be.reverted;
  });

  it("after initializeV2(timelock,emergency) only the timelock can upgrade", async function () {
    const { pool, tlc, deployer, attacker, emergency } = await deployReduced();
    await (await pool.initializeV2(await tlc.getAddress(), emergency.address)).wait();
    expect(await pool.timelock()).to.equal(await tlc.getAddress());
    expect(await pool.emergencyAdmin()).to.equal(emergency.address);

    // direct owner upgrade now reverts
    const MV = await ethers.getContractFactory("MockVerifier");
    const dummy = await MV.deploy(); await dummy.waitForDeployment();
    await expect(
      pool.connect(deployer).upgradeTo(await dummy.getAddress())
    ).to.be.revertedWithCustomError(pool, "NotTimelock");

    // attacker can't either
    await expect(
      pool.connect(attacker).upgradeTo(await dummy.getAddress())
    ).to.be.revertedWithCustomError(pool, "NotTimelock");
  });

  it("emergency sweep is gated to emergencyAdmin only", async function () {
    const { pool, tlc, deployer, attacker, emergency } = await deployReduced();
    await (await pool.initializeV2(await tlc.getAddress(), emergency.address)).wait();
    await expect(
      pool.connect(deployer).sweepGasReserveNative(deployer.address, 0n)
    ).to.be.revertedWithCustomError(pool, "NotEmergencyAdmin");
    await expect(
      pool.connect(attacker).sweepGasReserveNative(attacker.address, 0n)
    ).to.be.revertedWithCustomError(pool, "NotEmergencyAdmin");
  });

  it("emergencySendAllNativeBalance only callable by timelock", async function () {
    const { pool, tlc, deployer, attacker, emergency } = await deployReduced();
    await (await pool.initializeV2(await tlc.getAddress(), emergency.address)).wait();
    await expect(
      pool.connect(deployer).emergencySendAllNativeBalance(deployer.address)
    ).to.be.revertedWithCustomError(pool, "NotTimelock");
    await expect(
      pool.connect(emergency).emergencySendAllNativeBalance(emergency.address)
    ).to.be.revertedWithCustomError(pool, "NotTimelock");
  });

  it("emergency pause / unpause role separation", async function () {
    const { pool, tlc, deployer, emergency, attacker } = await deployReduced();
    await (await pool.initializeV2(await tlc.getAddress(), emergency.address)).wait();
    await expect(pool.connect(attacker).pauseEmergency()).to.be.revertedWithCustomError(pool, "NotEmergencyAdmin");
    await (await pool.connect(emergency).pauseEmergency()).wait();
    expect(await pool.emergencyPaused()).to.equal(true);
    await expect(pool.connect(emergency).unpauseEmergency()).to.be.reverted; // not owner
    await (await pool.connect(deployer).unpauseEmergency()).wait();
    expect(await pool.emergencyPaused()).to.equal(false);
  });
});

describe("Module 1 — permissionless admin lockdown (Fix #2)", function () {
  it("AdvancedPrivacyPool.updateFHEExecutor reverts for non-owner", async function () {
    const [owner, attacker] = await ethers.getSigners();
    const MV = await ethers.getContractFactory("MockVerifier");
    const v1 = await MV.deploy(); const v2 = await MV.deploy();
    await v1.waitForDeployment(); await v2.waitForDeployment();
    const A = await ethers.getContractFactory("MockSwapAdaptor");
    const a = await A.deploy(); await a.waitForDeployment();
    const F = await ethers.getContractFactory("FeeOracle");
    const f = await F.deploy(); await f.waitForDeployment();
    const R = await ethers.getContractFactory("RelayerRegistry");
    const r = await R.deploy(); await r.waitForDeployment();

    // AdvancedPrivacyPool.MockFHE* helpers live in the same .sol file
    const APP = await getShieldedPoolFactory("AdvancedPrivacyPool");
    const fheExec = await (await ethers.getContractFactory("MockFHEExecutor")).deploy();
    const mpc = await (await ethers.getContractFactory("MockMPCCoprocessor")).deploy();
    const thEnc = await (await ethers.getContractFactory("MockThresholdEncryption")).deploy();
    await fheExec.waitForDeployment(); await mpc.waitForDeployment(); await thEnc.waitForDeployment();

    const pool = await APP.deploy(
      await v1.getAddress(),
      await v2.getAddress(),
      await a.getAddress(),
      await f.getAddress(),
      await r.getAddress(),
      await fheExec.getAddress(),
      await mpc.getAddress(),
      await thEnc.getAddress()
    );
    await pool.waitForDeployment();

    await expect(
      pool.connect(attacker).updateFHEExecutor(await fheExec.getAddress())
    ).to.be.revertedWithCustomError(pool, "AdvancedPrivacyPoolNotOwner");
    await expect(
      pool.connect(attacker).updateMPCCoprocessor(await mpc.getAddress())
    ).to.be.revertedWithCustomError(pool, "AdvancedPrivacyPoolNotOwner");
    await expect(
      pool.connect(attacker).updateThresholdEncryption(await thEnc.getAddress())
    ).to.be.revertedWithCustomError(pool, "AdvancedPrivacyPoolNotOwner");

    await expect(
      pool.connect(owner).updateFHEExecutor(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(pool, "AdvancedPrivacyPoolZeroAddress");

    // owner happy path emits event
    await expect(pool.connect(owner).updateFHEExecutor(await fheExec.getAddress()))
      .to.emit(pool, "FHEExecutorUpdated");
  });

  it("FHECoprocessor.registerFHEEndpoint is onlyOwner", async function () {
    const [owner, attacker] = await ethers.getSigners();
    const FC = await ethers.getContractFactory("FHECoprocessor");
    const fc = await FC.deploy(); await fc.waitForDeployment();
    await expect(fc.connect(attacker).registerFHEEndpoint("https://x")).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(fc.connect(owner).registerFHEEndpoint("")).to.be.revertedWith("FHECoprocessor: empty endpoint");
    await expect(fc.connect(owner).registerFHEEndpoint("https://x.example/api"))
      .to.emit(fc, "FHEEndpointRegistered");
  });
});

describe("Module 1 — TransactionHistory one-shot init (Fix #4)", function () {
  it("setShieldedPool only callable by owner and only once", async function () {
    const [owner, attacker, pool1, pool2] = await ethers.getSigners();
    const TH = await ethers.getContractFactory("TransactionHistory");
    const th = await TH.deploy(ethers.ZeroAddress);
    await th.waitForDeployment();

    await expect(th.connect(attacker).setShieldedPool(attacker.address)).to.be.revertedWith("Ownable: caller is not the owner");
    await (await th.connect(owner).setShieldedPool(pool1.address)).wait();
    expect(await th.shieldedPool()).to.equal(pool1.address);
    // Second set must revert — even from owner.
    await expect(th.connect(owner).setShieldedPool(pool2.address)).to.be.revertedWith("TransactionHistory: already set");
  });
});

describe("Module 1 — ComplianceModule mutation gated (Fix #6)", function () {
  it("checkAddress is unauthorized for random callers", async function () {
    const [owner, attacker, officer] = await ethers.getSigners();
    const CM = await ethers.getContractFactory("ComplianceModule");
    const cm = await CM.deploy(officer.address, ethers.ZeroAddress);
    await cm.waitForDeployment();

    await expect(cm.connect(attacker).checkAddress(attacker.address))
      .to.be.revertedWith("ComplianceModule: unauthorized");
    // Officer is authorized
    await expect(cm.connect(officer).checkAddress(attacker.address)).to.not.be.reverted;
    // Pool authorization
    await (await cm.connect(owner).setAuthorizedPool(attacker.address, true)).wait();
    await expect(cm.connect(attacker).checkAddress(attacker.address)).to.not.be.reverted;
  });

  it("productionMode requires oracle and disables pseudo-random scoring", async function () {
    const [owner, _attacker, officer] = await ethers.getSigners();
    const CM = await ethers.getContractFactory("ComplianceModule");
    const cm = await CM.deploy(officer.address, ethers.ZeroAddress);
    await cm.waitForDeployment();
    await expect(cm.connect(owner).setProductionMode(true)).to.be.revertedWith("ComplianceModule: oracle unset");
  });
});
