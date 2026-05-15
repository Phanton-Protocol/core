/**
 * Module 4 — DeFi-specific hardening regression tests.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
} = require("../helpers/reducedProduction.cjs");
const { commitJoinSplitMevProtection, merkleProofForFirstLeaf, totalJoinSplitFeeBnb } = require("../helpers/poolFixtures.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const H_GOVERNANCE_FQN = "contracts/_full/governance/Governance.sol:Governance";
const LEGACY_GOV_FQN = "contracts/_full/core/Governance.sol:Governance";

async function deployReducedStack() {
  const [deployer, attacker] = await ethers.getSigners();
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const v1 = await MockVerifier.deploy();
  const v2 = await MockVerifier.deploy();
  await v1.waitForDeployment();
  await v2.waitForDeployment();

  const MockSwap = await ethers.getContractFactory("MockSwapAdaptor");
  const swapAdaptor = await MockSwap.deploy();
  await swapAdaptor.waitForDeployment();

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  await initFeeOracleForTests(feeOracle, deployer);

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await v1.getAddress(),
    await v2.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);

  return {
    deployer,
    attacker,
    pool,
    feeOracle,
    swapAdaptor,
    relayerRegistry,
    poolAddr: await pool.getAddress(),
  };
}

describe("Module 4 — DeFi hardening", function () {
  describe("RelayerStaking reward sniping", function () {
    it("late staker does not receive rewards accrued before stake", async function () {
      const [a, b] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), ethers.parseEther("1"));
      await rs.waitForDeployment();

      await shdw.mint(a.address, ethers.parseEther("100"));
      await shdw.mint(b.address, ethers.parseEther("100"));
      await shdw.connect(a).approve(await rs.getAddress(), ethers.MaxUint256);
      await shdw.connect(b).approve(await rs.getAddress(), ethers.MaxUint256);

      await rs.connect(a).stake(ethers.parseEther("10"));
      await rs.connect(a).distributeFee(ethers.ZeroAddress, ethers.parseEther("5"), {
        value: ethers.parseEther("5"),
      });

      const accBefore = await rs.accRewardPerShare(ethers.ZeroAddress);
      expect(accBefore).to.be.gt(0n);

      await rs.connect(b).stake(ethers.parseEther("10"));
      const pendingB = await rs.pendingReward(b.address, ethers.ZeroAddress);
      expect(pendingB).to.equal(0n);

      await rs.connect(a).distributeFee(ethers.ZeroAddress, ethers.parseEther("2"), {
        value: ethers.parseEther("2"),
      });
      const pendingBAfter = await rs.pendingReward(b.address, ethers.ZeroAddress);
      expect(pendingBAfter).to.be.gt(0n);
    });
  });

  describe("Reduced pool — relayer + MEV", function () {
    it("reverts join-split from non-relayer", async function () {
      const { pool, attacker, deployer, feeOracle } = await deployReducedStack();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("O", "O", 18);
      const out = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);
      const { root, path, indices } = await merkleProofForFirstLeaf(ethers.keccak256(ethers.toUtf8Bytes("n1")));
      const swapAmt = ethers.parseEther("1");
      const totalPf2 = await totalJoinSplitFeeBnb(feeOracle, ethers.parseEther("10"));
      const inputAmt = ethers.parseEther("10");
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("nf")),
        inputCommitment: ethers.keccak256(ethers.toUtf8Bytes("ic")),
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount: inputAmt,
        swapAmount: swapAmt,
        changeAmount: inputAmt - swapAmt - totalPf2,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee: totalPf2,
        merklePath: path,
        merklePathIndices: indices,
      };
      const tx = await buildReducedJoinSplitTx(pool, deployer, publicInputs, out);
      await expect(pool.connect(attacker).shieldedSwapJoinSplit(tx)).to.be.revertedWithCustomError(pool, "SP");
    });

    it("reverts join-split without commitSwap", async function () {
      const { pool, deployer } = await deployReducedStack();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("O", "O", 18);
      const out = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);
      const { root, path, indices } = await merkleProofForFirstLeaf(ethers.keccak256(ethers.toUtf8Bytes("n2")));
      const swapAmt = ethers.parseEther("1");
      const feeOracle = await ethers.getContractAt("FeeOracle", await pool.feeOracle());
      const inputAmt = ethers.parseEther("10");
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmt);
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("nf2")),
        inputCommitment: ethers.keccak256(ethers.toUtf8Bytes("ic2")),
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os2")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc2")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount: inputAmt,
        swapAmount: swapAmt,
        changeAmount: inputAmt - swapAmt - totalPf,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee: totalPf,
        merklePath: path,
        merklePathIndices: indices,
      };
      const tx = await buildReducedJoinSplitTx(pool, deployer, publicInputs, out);
      tx.commitment = ethers.ZeroHash;
      const MevLib = await ethers.getContractFactory(
        "contracts/_full/libraries/MevCommitReveal.sol:MevCommitReveal"
      );
      await expect(pool.connect(deployer).shieldedSwapJoinSplit(tx)).to.be.revertedWithCustomError(
        MevLib,
        "MevInvalid"
      );
    });

    it("reverts when blacklisted relayer submits", async function () {
      const { pool, deployer } = await deployReducedStack();
      await (await pool.setRelayerBlacklisted(deployer.address, true)).wait();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("O", "O", 18);
      const out = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);
      const { root, path, indices } = await merkleProofForFirstLeaf(ethers.keccak256(ethers.toUtf8Bytes("n3")));
      const feeOracle = await ethers.getContractAt("FeeOracle", await pool.feeOracle());
      const inputAmt = ethers.parseEther("10");
      const swapAmt = ethers.parseEther("1");
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmt);
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("nf3")),
        inputCommitment: ethers.keccak256(ethers.toUtf8Bytes("ic3")),
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os3")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc3")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount: inputAmt,
        swapAmount: swapAmt,
        changeAmount: inputAmt - swapAmt - totalPf,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee: totalPf,
        merklePath: path,
        merklePathIndices: indices,
      };
      const tx = await buildReducedJoinSplitTx(pool, deployer, publicInputs, out);
      await expect(pool.connect(deployer).shieldedSwapJoinSplit(tx)).to.be.revertedWithCustomError(pool, "SP");
    });
  });

  describe("FeeOracle — no silent spot fallback", function () {
    it("calculateFee reverts when no price feed", async function () {
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const token = await MockERC20.deploy("X", "X", 18);
      await token.waitForDeployment();
      await expect(
        feeOracle.calculateFee.staticCall(await token.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });
  });

  describe("Token registration policy", function () {
    it("rejects ERC777 via supportsInterface at probe", async function () {
      const { pool, deployer } = await deployReducedStack();
      const E777 = await ethers.getContractFactory("contracts/_full/mocks/MockErc777.sol:MockErc777");
      const token = await E777.deploy();
      await token.waitForDeployment();
      const TokenRegistrationPolicy = await ethers.getContractFactory(
        "contracts/_full/libraries/TokenRegistrationPolicy.sol:TokenRegistrationPolicy"
      );
      await expect(
        pool.connect(deployer).registerAssetWithProbe(1n, await token.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(TokenRegistrationPolicy, "UnsupportedToken");
    });
  });

  describe("Governance — flash loan resistance", function () {
    it("hardened governance: propose requires snapshot votes not balanceOf", async function () {
      const [deployer, borrower] = await ethers.getSigners();
      const Proto = await ethers.getContractFactory("ProtocolToken");
      const token = await Proto.deploy(deployer.address);
      await token.waitForDeployment();
      const Timelock = await ethers.getContractFactory("contracts/_full/governance/TimelockController.sol:TimelockController");
      const timelock = await Timelock.deploy(48 * 3600, [deployer.address], [ethers.ZeroAddress], deployer.address);
      await timelock.waitForDeployment();
      const Gov = await ethers.getContractFactory(H_GOVERNANCE_FQN);
      const gov = await Gov.deploy(
        await timelock.getAddress(),
        await token.getAddress(),
        deployer.address,
        5,
        ethers.parseEther("1"),
        ethers.parseEther("1000")
      );
      await gov.waitForDeployment();

      const flashAmt = ethers.parseEther("2000");
      await (await token.transfer(borrower.address, flashAmt)).wait();
      await (await token.connect(borrower).delegate(borrower.address)).wait();
      await (await token.connect(borrower).transfer(deployer.address, flashAmt)).wait();

      await expect(
        gov.connect(borrower).propose(deployer.address, 0, "0x")
      ).to.be.revertedWithCustomError(gov, "InsufficientTokens");
    });

    it("legacy governance: propose uses getPastVotes at snapshot", async function () {
      const [deployer, borrower] = await ethers.getSigners();
      const Proto = await ethers.getContractFactory("ProtocolToken");
      const token = await Proto.deploy(deployer.address);
      await token.waitForDeployment();
      const Gov = await ethers.getContractFactory(LEGACY_GOV_FQN);
      const gov = await Gov.deploy(
        await token.getAddress(),
        5,
        ethers.parseEther("1"),
        ethers.parseEther("1000"),
        deployer.address
      );
      await gov.waitForDeployment();

      const flashAmt = ethers.parseEther("2000");
      await (await token.transfer(borrower.address, flashAmt)).wait();
      await (await token.connect(borrower).delegate(borrower.address)).wait();
      await (await token.connect(borrower).transfer(deployer.address, flashAmt)).wait();

      await expect(gov.connect(borrower).propose(deployer.address, 0, "0x")).to.be.revertedWith(
        "Governance: insufficient voting power at snapshot"
      );
    });
  });
});
