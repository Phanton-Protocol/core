const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./helpers/libraryLinker.cjs");
const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

/**
 * Relayer calls `depositFor` for ERC20 with BNB `msg.value` for the $2-class deposit fee (E-paper / M3b).
 */
describe("depositFor ERC20 (relayer + BNB fee for $2 policy)", function () {
  it("depositFor succeeds when user approved pool and relayer is registered", async function () {
    const [deployer, user] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const joinSplitVerifier = await MockVerifier.deploy();
    await joinSplitVerifier.waitForDeployment();
    const joinSplitAddr = await joinSplitVerifier.getAddress();

    const thresholdVerifier = await MockVerifier.deploy();
    await thresholdVerifier.waitForDeployment();
    const thresholdAddr = await thresholdVerifier.getAddress();

    const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
    const swapAdaptor = await MockSwapAdaptor.deploy();
    await swapAdaptor.waitForDeployment();
    const swapAdaptorAddr = await swapAdaptor.getAddress();

    const FeeOracle = await ethers.getContractFactory("FeeOracle");
    const feeOracle = await FeeOracle.deploy();
    await feeOracle.waitForDeployment();
    const feeOracleAddr = await feeOracle.getAddress();

    const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
    const relayerRegistry = await RelayerRegistry.deploy();
    await relayerRegistry.waitForDeployment();
    const relayerRegistryAddr = await relayerRegistry.getAddress();

    await (await relayerRegistry.registerRelayer(deployer.address)).wait();

    const ShieldedPool = await getShieldedPoolFactory("ShieldedPool");
    const shieldedPool = await ShieldedPool.deploy(
      joinSplitAddr,
      joinSplitAddr,
      thresholdAddr,
      swapAdaptorAddr,
      feeOracleAddr,
      relayerRegistryAddr
    );
    await shieldedPool.waitForDeployment();
    const shieldedPoolAddr = await shieldedPool.getAddress();

    const DepositHandler = await ethers.getContractFactory("DepositHandler");
    const depositHandler = await DepositHandler.deploy(shieldedPoolAddr, feeOracleAddr, relayerRegistryAddr);
    await depositHandler.waitForDeployment();
    const depositHandlerAddr = await depositHandler.getAddress();

    const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
    const txHistory = await TransactionHistory.deploy(shieldedPoolAddr);
    await txHistory.waitForDeployment();
    const txHistoryAddr = await txHistory.getAddress();

    const pool = await ethers.getContractAt("ShieldedPool", shieldedPoolAddr);
    await (await pool.setDepositHandler(depositHandlerAddr)).wait();
    await (await pool.setTransactionHistory(txHistoryAddr)).wait();

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

    const assetId = 1n;
    await (await pool.registerAsset(assetId, tokenAddr)).wait();

    const amount = ethers.parseEther("10");
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("m4-deposit-for"));

    await (await token.mint(user.address, amount)).wait();
    await (await token.connect(user).approve(shieldedPoolAddr, amount)).wait();

    const depositFeeBnb = ethers.parseEther("0.02");

    await expect(
      pool.connect(deployer).depositFor(user.address, tokenAddr, amount, commitment, assetId, {
        value: depositFeeBnb,
      })
    ).to.emit(pool, "Deposit");

    expect(await pool.commitmentCount()).to.equal(1n);
  });
});
