/**
 * Module 2 follow-up — CEI ordering, strict ERC20 accounting, upgradeable deposit pull.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("../helpers/libraryLinker.cjs");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
} = require("../helpers/reducedProduction.cjs");
const { totalJoinSplitFeeBnb } = require("../helpers/poolFixtures.cjs");

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const TOKEN_ACCOUNTING_FQN = "contracts/_full/libraries/TokenAccounting.sol:TokenAccounting";

async function deployNonUpgradeablePool(deployer) {
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const v1 = await MockVerifier.deploy();
  const v2 = await MockVerifier.deploy();
  await v1.waitForDeployment();
  await v2.waitForDeployment();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
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

  const ShieldedPool = await getShieldedPoolFactory("ShieldedPool");
  const pool = await ShieldedPool.deploy(
    await v1.getAddress(),
    await v1.getAddress(),
    await v2.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(
    poolAddr,
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await depositHandler.waitForDeployment();

  const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
  const txHistory = await TransactionHistory.deploy(poolAddr);
  await txHistory.waitForDeployment();

  const poolAt = await ethers.getContractAt("ShieldedPool", poolAddr);
  await (await poolAt.setDepositHandler(await depositHandler.getAddress())).wait();
  await (await poolAt.setTransactionHistory(await txHistory.getAddress())).wait();

  return { pool: poolAt, feeOracle };
}

async function deployReducedPool(deployer) {
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const v1 = await MockVerifier.deploy();
  const v2 = await MockVerifier.deploy();
  await v1.waitForDeployment();
  await v2.waitForDeployment();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
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
    await v1.getAddress(),
    await v2.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(
    await pool.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await depositHandler.waitForDeployment();
  await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();

  return { pool, feeOracle };
}

describe("Module 2 — token accounting & upgradeable deposit", function () {
  it("ShieldedPool: fee-on-transfer ERC20 deposit reverts (ERC20ReceivedMismatch)", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool } = await deployNonUpgradeablePool(deployer);

    const FoT = await ethers.getContractFactory("FeeOnTransferERC20");
    const token = await FoT.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    await (await pool.connect(deployer).registerAsset(1n, tokenAddr)).wait();

    const amount = ethers.parseEther("100");
    await (await token.mint(deployer.address, amount)).wait();
    await (await token.approve(await pool.getAddress(), amount)).wait();

    const TokenAccounting = await ethers.getContractFactory(TOKEN_ACCOUNTING_FQN);
    await expect(
      pool.connect(deployer).deposit(await token.getAddress(), amount, ethers.keccak256(ethers.toUtf8Bytes("fot-dep")), 1n, {
        value: ethers.parseEther("0.01"),
      })
    ).to.be.revertedWithCustomError(TokenAccounting, "ERC20ReceivedMismatch");
  });

  it("ShieldedPoolUpgradeableReduced: fee-on-transfer ERC20 rejected at registerAsset probe", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool } = await deployReducedPool(deployer);

    const FoT = await ethers.getContractFactory("FeeOnTransferERC20");
    const token = await FoT.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    const probe = ethers.parseEther("1");
    await (await token.mint(deployer.address, probe * 2n)).wait();
    await (await token.approve(await pool.getAddress(), probe * 2n)).wait();

    const TokenAccounting = await ethers.getContractFactory(TOKEN_ACCOUNTING_FQN);
    await expect(
      pool.connect(deployer).registerAssetWithProbe(1n, tokenAddr, probe)
    ).to.be.revertedWithCustomError(TokenAccounting, "ERC20ReceivedMismatch");
  });

  it("ShieldedPoolUpgradeableReduced: standard ERC20 deposit credits pool before finalize", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool, feeOracle } = await deployReducedPool(deployer);

    const MockAgg = await ethers.getContractFactory(
      "contracts/_full/mocks/MockChainlinkAggregator.sol:MockChainlinkAggregator"
    );
    const feed = await MockAgg.deploy(300 * 10 ** 8);
    await feed.waitForDeployment();
    await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const token = await MockERC20.deploy("T", "T", 18);
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    await allowlistAndRegisterAsset(pool, deployer, 1n, token);

    const amount = ethers.parseEther("50");
    const depositFeeBnb = ethers.parseEther("0.02");
    await (await token.mint(deployer.address, amount)).wait();
    await (await token.approve(await pool.getAddress(), amount)).wait();

    const commitment = ethers.keccak256(ethers.toUtf8Bytes("erc20-dep-pull"));
    const poolAddr = await pool.getAddress();
    const balBefore = await token.balanceOf(poolAddr);

    await expect(
      pool.connect(deployer).deposit(tokenAddr, amount, commitment, 1n, { value: depositFeeBnb })
    ).to.emit(pool, "Deposit");

    expect(await token.balanceOf(poolAddr)).to.equal(balBefore + amount);
    expect(await pool.commitmentCount()).to.equal(1n);
  });

  it("ShieldedPoolUpgradeableReduced: malicious swap adaptor cannot re-enter deposit during join-split", async function () {
    const [deployer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const v1 = await MockVerifier.deploy();
    const v2 = await MockVerifier.deploy();
    await v1.waitForDeployment();
    await v2.waitForDeployment();

    const ReAd = await ethers.getContractFactory("MockReentrantSwapAdaptor");
    const swapAdaptor = await ReAd.deploy();
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
    const poolAddr = await pool.getAddress();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("O", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await outTok.getAddress();
    await allowlistAndRegisterAsset(pool, deployer, 2n, outTok);

    const inputAmount = ethers.parseEther("10");
    const swapAmt = ethers.parseEther("4");
    const c1 = ethers.keccak256(ethers.toUtf8Bytes("js-re"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, { value: inputAmount });

    const inner = pool.interface.encodeFunctionData("deposit", [
      ethers.ZeroAddress,
      inputAmount,
      ethers.keccak256(ethers.toUtf8Bytes("re2")),
      0n,
    ]);
    await (await swapAdaptor.configureCallback(poolAddr, inner)).wait();

    const root = await pool.merkleRoot();
    const { merkleProofForFirstLeaf } = require("../helpers/poolFixtures.cjs");
    const { path, indices } = await merkleProofForFirstLeaf(c1);
    const protocolFee = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
    const changeAmt = inputAmount - swapAmt - protocolFee;

    const swapData = await buildReducedJoinSplitTx(
      pool,
      deployer,
      {
        nullifier: ethers.ZeroHash,
        inputCommitment: c1,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("swap-out")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("change-out")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 2n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: swapAmt,
        changeAmount: changeAmt,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee,
        merklePath: path,
        merklePathIndices: indices,
      },
      outAddr
    );

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.be.revertedWith(
      "ReentrancyGuard: reentrant call"
    );
  });
});
