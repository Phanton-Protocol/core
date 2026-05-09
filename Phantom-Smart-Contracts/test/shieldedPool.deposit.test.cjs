const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./helpers/libraryLinker.cjs");

/**
 * Minimal integration: deploy pool + DepositHandler (same order as scripts/deploy/deploy-all.ts), BNB deposit.
 */
describe("ShieldedPool deposit path", function () {
  it("deposit native BNB with zero extra fee updates merkle root", async function () {
    const [deployer] = await ethers.getSigners();

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

    const rootBefore = await pool.merkleRoot();
    const amount = ethers.parseEther("1");
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("test-commitment"));

    await expect(
      pool.connect(deployer).deposit(ethers.ZeroAddress, amount, commitment, 0n, { value: amount })
    ).to.emit(pool, "Deposit");

    const rootAfter = await pool.merkleRoot();
    expect(rootAfter).to.not.equal(rootBefore);
    expect(await pool.commitmentCount()).to.equal(1n);
  });
});
