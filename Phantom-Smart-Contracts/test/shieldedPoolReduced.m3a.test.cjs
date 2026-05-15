const { expect } = require("chai");
const { ethers } = require("hardhat");
const { merkleProofForFirstLeaf, totalJoinSplitFeeBnb } = require("./helpers/poolFixtures.cjs");
const { joinSplitSwapDataDummyAttestation } = require("./helpers/relayerSwapAttestation.cjs");
const { deployBehindProxy } = require("./helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
} = require("./helpers/reducedProduction.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const MOCK_SWAP_SUB1_FQN = "contracts/_full/mocks/MockSwapAdaptorSubtractWei.sol:MockSwapAdaptorSubtractWei";
const MOCK_SWAP_FQN = "contracts/_full/mocks/MockSwapAdaptor.sol:MockSwapAdaptor";

/**
 * Reduced pool + dual MockVerifier + FeeOracle + registry; optional subtract-wei swap adaptor.
 */
async function deployReducedForM3a(useSubtractWeiAdaptor) {
  const [deployer] = await ethers.getSigners();
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const joinV = await MockVerifier.deploy();
  const threshV = await MockVerifier.deploy();
  await joinV.waitForDeployment();
  await threshV.waitForDeployment();

  const AdaptorF = useSubtractWeiAdaptor ? MOCK_SWAP_SUB1_FQN : MOCK_SWAP_FQN;
  const MockSwapAdaptor = await ethers.getContractFactory(AdaptorF);
  const swapAdaptor = await MockSwapAdaptor.deploy();
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
    await joinV.getAddress(),
    await threshV.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);

  return { deployer, pool, feeOracle, swapAdaptor };
}

async function joinSplitTx(pool, relayerSigner, publicInputs, outTokenAddr) {
  const tx = await buildReducedJoinSplitTx(pool, relayerSigner, publicInputs, outTokenAddr);
  return pool.connect(relayerSigner).shieldedSwapJoinSplit(tx);
}

describe("ShieldedPoolUpgradeableReduced — M3a join-split conservation + DEX binding", function () {
  it("reverts shieldedSwapJoinSplit when join-split conservation breaks", async function () {
    const { deployer, pool } = await deployReducedForM3a(false);

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("m3a-conservation-leaf"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("2"), c1, 0n, {
      value: ethers.parseEther("2"),
    });
    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);
    expect(root).to.equal(await pool.merkleRoot());

    const swapAmt = ethers.parseEther("1");
    const changeAmt = ethers.parseEther("1");
    const publicInputs = {
      nullifier: ethers.ZeroHash,
      inputCommitment: c1,
      outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("swap-cm")),
      outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("chg-cm")),
      merkleRoot: root,
      inputAssetID: 0n,
      outputAssetIDSwap: 1n,
      outputAssetIDChange: 0n,
      inputAmount: ethers.parseEther("99"),
      swapAmount: swapAmt,
      changeAmount: changeAmt,
      outputAmountSwap: swapAmt,
      minOutputAmountSwap: 0n,
      gasRefund: 0n,
      protocolFee: 0n,
      merklePath: path,
      merklePathIndices: indices,
    };

    await expect(joinSplitTx(pool, deployer, publicInputs, outAddr)).to.be.revertedWith("SP:cvs");
  });

  it("reverts shieldedSwapJoinSplit when DEX output is below minOutputAmountSwap", async function () {
    const { deployer, pool, feeOracle } = await deployReducedForM3a(true);

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out2", "O2", 18);
    await outTok.waitForDeployment();
    const outAddr = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("m3a-binding-leaf"));
    const inputAmount = ethers.parseEther("100");
    const swapAmt = ethers.parseEther("2");
    const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
    const changeAmt = inputAmount - swapAmt - totalPf;

    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, {
      value: inputAmount,
    });
    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);

    const publicInputs = {
      nullifier: ethers.ZeroHash,
      inputCommitment: c1,
      outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("swap-cm2")),
      outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("chg-cm2")),
      merkleRoot: root,
      inputAssetID: 0n,
      outputAssetIDSwap: 1n,
      outputAssetIDChange: 0n,
      inputAmount,
      swapAmount: swapAmt,
      changeAmount: changeAmt,
      outputAmountSwap: swapAmt,
      minOutputAmountSwap: swapAmt,
      gasRefund: 0n,
      protocolFee: totalPf,
      merklePath: path,
      merklePathIndices: indices,
    };

    await expect(joinSplitTx(pool, deployer, publicInputs, outAddr)).to.be.revertedWithCustomError(pool, "SP");
  });

  it("reverts shieldedWithdraw when join-split conservation breaks", async function () {
    const { deployer, pool } = await deployReducedForM3a(false);

    const WithdrawHandler = await ethers.getContractFactory("WithdrawHandler");
    const wh = await WithdrawHandler.deploy(
      await pool.getAddress(),
      await pool.verifier(),
      await pool.thresholdVerifier(),
      await pool.feeOracle(),
      await pool.relayerRegistry()
    );
    await wh.waitForDeployment();
    await (await pool.connect(deployer).setWithdrawHandler(await wh.getAddress())).wait();

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("m3a-wd-leaf"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("4"), c1, 0n, {
      value: ethers.parseEther("4"),
    });
    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);

    const swapAmt = ethers.parseEther("2");
    const changeAmt = ethers.parseEther("1");
    const publicInputs = {
      nullifier: ethers.ZeroHash,
      inputCommitment: c1,
      outputCommitmentSwap: ethers.ZeroHash,
      outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("wd-chg")),
      merkleRoot: root,
      inputAssetID: 0n,
      outputAssetIDSwap: 0n,
      outputAssetIDChange: 0n,
      inputAmount: ethers.parseEther("100"),
      swapAmount: swapAmt,
      changeAmount: changeAmt,
      outputAmountSwap: 0n,
      minOutputAmountSwap: 0n,
      gasRefund: 0n,
      protocolFee: 0n,
      merklePath: path,
      merklePathIndices: indices,
    };

    const wd = {
      proof: { a: "0x", b: "0x", c: "0x" },
      publicInputs,
      recipient: deployer.address,
      relayer: ethers.ZeroAddress,
      encryptedPayload: "0x",
    };

    await expect(pool.connect(deployer).shieldedWithdraw(wd)).to.be.revertedWith("SP:cvs");
  });
});
