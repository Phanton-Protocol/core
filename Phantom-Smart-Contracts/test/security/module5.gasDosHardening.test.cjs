/**
 * Module 5 — Gas / DoS hardening regression tests.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
  authorizeTestFeeDistributor,
} = require("../helpers/reducedProduction.cjs");
const {
  commitJoinSplitMevProtection,
  merkleProofForFirstLeaf,
  totalJoinSplitFeeBnb,
  withdrawProtocolFee,
  emptyProof,
} = require("../helpers/poolFixtures.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const MEV_LIB_FQN = "contracts/_full/libraries/MevCommitReveal.sol:MevCommitReveal";

async function deployReducedStack() {
  const [deployer, other] = await ethers.getSigners();
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

  const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
  const shdwToken = await MockERC20.deploy("SHDW", "SHDW", 18);
  await shdwToken.waitForDeployment();
  const RS = await ethers.getContractFactory("RelayerStaking");
  const relayerStaking = await RS.deploy(await shdwToken.getAddress(), ethers.parseEther("1"));
  await relayerStaking.waitForDeployment();
  await authorizeTestFeeDistributor(relayerStaking, deployer.address, deployer);

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await v1.getAddress(),
    await v2.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerStaking.getAddress(),
  ]);

  const shdw = await ethers.getContractAt(MOCK_ERC20_FQN, await shdwToken.getAddress());
  await (await shdw.mint(deployer.address, ethers.parseEther("1000"))).wait();
  await (await shdw.connect(deployer).approve(await relayerStaking.getAddress(), ethers.MaxUint256)).wait();
  await (await relayerStaking.connect(deployer).stake(ethers.parseEther("10"))).wait();

  await (await shdw.mint(other.address, ethers.parseEther("100"))).wait();
  await (await shdw.connect(other).approve(await relayerStaking.getAddress(), ethers.MaxUint256)).wait();
  await (await relayerStaking.connect(other).stake(ethers.parseEther("10"))).wait();

  const WithdrawHandler = await ethers.getContractFactory("WithdrawHandler");
  const wh = await WithdrawHandler.deploy(
    await pool.getAddress(),
    await v1.getAddress(),
    await v2.getAddress(),
    await feeOracle.getAddress(),
    await relayerStaking.getAddress()
  );
  await wh.waitForDeployment();
  await (await pool.setWithdrawHandler(await wh.getAddress())).wait();

  return { deployer, other, pool, feeOracle, swapAdaptor, relayerStaking, shdw };
}

describe("Module 5 — gas / DoS hardening", function () {
  describe("RelayerStaking — reward token bloat", function () {
    it("rejects distributeFee from unauthorized caller", async function () {
      const [a, attacker] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), ethers.parseEther("1"));
      await rs.waitForDeployment();

      await expect(
        rs.connect(attacker).distributeFee(ethers.ZeroAddress, 1n, { value: 1n })
      ).to.be.revertedWith("RelayerStaking: not fee distributor");
    });

    it("allows owner-authorized distributor and caps reward token list", async function () {
      const [a] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), ethers.parseEther("1"));
      await rs.waitForDeployment();
      await authorizeTestFeeDistributor(rs, a.address, a);

      for (let i = 0; i < 20; i++) {
        const junk = await MockERC20.deploy(`J${i}`, `J${i}`, 18);
        await junk.waitForDeployment();
        const junkAddr = await junk.getAddress();
        await (await junk.mint(a.address, 1000n)).wait();
        await (await junk.connect(a).approve(await rs.getAddress(), 1000n)).wait();
        await rs.connect(a).distributeFee(junkAddr, 1n);
      }
      const extra = await MockERC20.deploy("X", "X", 18);
      await extra.waitForDeployment();
      const extraAddr = await extra.getAddress();
      await (await extra.mint(a.address, 1n)).wait();
      await (await extra.connect(a).approve(await rs.getAddress(), 1n)).wait();
      await expect(rs.connect(a).distributeFee(extraAddr, 1n)).to.be.revertedWith(
        "RelayerStaking: max reward tokens reached"
      );
    });
  });

  describe("MevCommitReveal — commit squatting", function () {
    it("rejects join-split when commit was made by another relayer", async function () {
      const { pool, deployer, other } = await deployReducedStack();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("O", "O", 18);
      const out = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);
      const { root, path, indices } = await merkleProofForFirstLeaf(ethers.keccak256(ethers.toUtf8Bytes("m5-squat")));
      const inputAmt = ethers.parseEther("10");
      const swapAmt = ethers.parseEther("1");
      const feeOracle = await ethers.getContractAt("FeeOracle", await pool.feeOracle());
      const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmt);
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("m5-nf")),
        inputCommitment: ethers.keccak256(ethers.toUtf8Bytes("m5-ic")),
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("m5-os")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m5-oc")),
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
      const tag = "m5-shared-commit";
      const commitment = ethers.keccak256(ethers.toUtf8Bytes(tag));
      const deadline = BigInt(await time.latest()) + 3500n;
      await pool.connect(deployer).commitSwap(commitment, deadline);

      const tx = await buildReducedJoinSplitTx(pool, other, publicInputs, out);
      tx.commitment = commitment;
      tx.deadline = deadline;
      const MevLib = await ethers.getContractFactory(MEV_LIB_FQN);
      await expect(pool.connect(other).shieldedSwapJoinSplit(tx)).to.be.revertedWithCustomError(
        MevLib,
        "MevInvalid"
      );
    });

    it("rejects double commit of same hash", async function () {
      const { pool, deployer, other } = await deployReducedStack();
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m5-double"));
      const deadline = BigInt(await time.latest()) + 3500n;
      await pool.connect(deployer).commitSwap(commitment, deadline);
      const MevLib = await ethers.getContractFactory(MEV_LIB_FQN);
      await expect(pool.connect(other).commitSwap(commitment, deadline)).to.be.revertedWithCustomError(
        MevLib,
        "MevInvalid"
      );
    });
  });

  describe("Native withdraw — recipient revert", function () {
    it("reverts with RecipientRejectedNativePayout for rejecting contract", async function () {
      const { pool, deployer, feeOracle } = await deployReducedStack();
      const Reject = await ethers.getContractFactory(
        "contracts/_full/mocks/MockRejectingReceiver.sol:MockRejectingReceiver"
      );
      const rejector = await Reject.deploy();
      await rejector.waitForDeployment();

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m5-wd-reject"));
      const inputAmount = ethers.parseEther("3");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      });

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const withdrawAmount = ethers.parseEther("0.5");
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);
      const changeAmount = inputAmount - withdrawAmount - protocolFee;
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("m5-wd-nf")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m5-wd-ch")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: withdrawAmount,
        changeAmount,
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund: 0n,
        protocolFee,
        merklePath: path,
        merklePathIndices: indices,
      };

      const withdrawData = {
        proof: emptyProof(),
        publicInputs,
        recipient: await rejector.getAddress(),
        relayer: deployer.address,
        encryptedPayload: "0x",
      };

      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.be.revertedWithCustomError(pool, "SP");
      expect(await pool.nullifiers(publicInputs.nullifier)).to.equal(false);
    });
  });

  describe("Relayer gas refund — call not transfer", function () {
    it("pays gas refund to contract relayer via call", async function () {
      const { pool, deployer, feeOracle } = await deployReducedStack();
      const Relayer = await ethers.getContractFactory(
        "contracts/_full/mocks/MockGasRefundRelayer.sol:MockGasRefundRelayer"
      );
      const relayerContract = await Relayer.deploy();
      await relayerContract.waitForDeployment();
      const relayerAddr = await relayerContract.getAddress();

      const balBefore = await ethers.provider.getBalance(relayerAddr);
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m5-refund"));
      const inputAmount = ethers.parseEther("4");
      const gasRefund = 4_000_000_000_000n; // ProtocolFeeMath.maxGasRefundWei()
      const depositFee = ethers.parseEther("0.05");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount + depositFee,
      });
      expect(await pool.gasReserve()).to.be.gte(gasRefund);

      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const withdrawAmount = ethers.parseEther("0.5");
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);
      const changeAmount = inputAmount - withdrawAmount - protocolFee - gasRefund;
      const publicInputs = {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("m5-gr-nf")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m5-gr-ch")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: withdrawAmount,
        changeAmount,
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund,
        protocolFee,
        merklePath: path,
        merklePathIndices: indices,
      };

      const [, recipient] = await ethers.getSigners();
      await expect(
        pool.connect(deployer).shieldedWithdraw({
          proof: emptyProof(),
          publicInputs,
          recipient: recipient.address,
          relayer: relayerAddr,
          encryptedPayload: "0x",
        })
      ).to.emit(pool, "GasRefunded");

      expect(await ethers.provider.getBalance(relayerAddr)).to.be.gt(balBefore);
    });
  });

  describe("PancakeSwapAdaptor — path length", function () {
    it("reverts when decoded path exceeds MAX_SWAP_PATH_LENGTH", async function () {
      const Pancake = await ethers.getContractFactory("PancakeSwapAdaptor");
      const MockRouter = await ethers.getContractFactory("MockPancakeRouterV2Minimal");
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const router = await MockRouter.deploy();
      await router.waitForDeployment();
      const wbnb = await MockERC20.deploy("WBNB", "WBNB", 18);
      await wbnb.waitForDeployment();
      const wbnbAddr = await wbnb.getAddress();
      const adaptor = await Pancake.deploy(await router.getAddress(), wbnbAddr);
      await adaptor.waitForDeployment();

      const longPath = [wbnbAddr, wbnbAddr, wbnbAddr, wbnbAddr];
      const swapParams = {
        tokenIn: ethers.ZeroAddress,
        tokenOut: wbnbAddr,
        amountIn: ethers.parseEther("1"),
        minAmountOut: 1n,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [longPath]),
      };

      await expect(adaptor.executeSwap(swapParams, { value: swapParams.amountIn })).to.be.revertedWith(
        "PancakeSwapAdaptor: invalid path length"
      );
    });
  });

  describe("Merkle tree capacity", function () {
    it("exposes capacity views and reverts MerkleTreeFull when exhausted", async function () {
      const { pool, deployer } = await deployReducedStack();
      const cap = 1024;
      expect(await pool.commitmentCount()).to.equal(0n);
      for (let i = 0; i < cap; i++) {
        const c = ethers.keccak256(ethers.toUtf8Bytes(`fill-${i}`));
        await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("0.001"), c, 0n, {
          value: ethers.parseEther("0.001"),
        });
      }
      expect(await pool.commitmentCount()).to.equal(1024n);
      await expect(
        pool.connect(deployer).deposit(ethers.ZeroAddress, 1n, ethers.keccak256(ethers.toUtf8Bytes("overflow")), 0n, {
          value: 1n,
        })
      ).to.be.reverted;
    });
  }).timeout(180000);

  describe("Experimental caps", function () {
    it("ComplianceModule.batchCheckAddresses rejects oversized batch", async function () {
      const [deployer] = await ethers.getSigners();
      const CM = await ethers.getContractFactory("ComplianceModule");
      const cm = await CM.deploy(deployer.address, ethers.ZeroAddress);
      await cm.waitForDeployment();
      const addrs = Array(51).fill(ethers.ZeroAddress);
      await expect(cm.connect(deployer).batchCheckAddresses(addrs)).to.be.revertedWith(
        "ComplianceModule: batch too large"
      );
    });

    it("ThresholdVerifier.submitValidations rejects too many signatures", async function () {
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), 1n);
      await rs.waitForDeployment();
      const TV = await ethers.getContractFactory("ThresholdVerifier");
      const tv = await TV.deploy(await rs.getAddress(), 6600n);
      await tv.waitForDeployment();

      const sigs = Array(33).fill({
        validator: ethers.ZeroAddress,
        votingPower: 0n,
        signature: "0x",
        timestamp: 0n,
      });
      await expect(
        tv.submitValidations({ a: "0x", b: "0x", c: "0x" }, Array(9).fill(0n), sigs, true)
      ).to.be.revertedWith("ThresholdVerifier: too many signatures");
    });
  });
});
