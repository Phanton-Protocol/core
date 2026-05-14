/**
 * Module 2 — Reentrancy & fund-flow regression tests (production-style paths).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("../helpers/libraryLinker.cjs");

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

describe("Module 2 — reentrancy & SafeERC20 (production paths)", function () {
  it("PancakeSwapAdaptor: nested executeSwap reverts (nonReentrant)", async function () {
    const [deployer] = await ethers.getSigners();

    const Router = await ethers.getContractFactory("MockPancakeRouterV2Minimal");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const Adaptor = await ethers.getContractFactory("PancakeSwapAdaptor");
    const adaptor = await Adaptor.deploy(await router.getAddress(), deployer.address);
    await adaptor.waitForDeployment();

    const Out = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const tokenOut = await Out.deploy("Out", "OUT", 18);
    await tokenOut.waitForDeployment();
    await (await tokenOut.mint(await router.getAddress(), ethers.parseEther("1000000"))).wait();

    const Mal = await ethers.getContractFactory("MaliciousERC20Reentrant");
    const tokenIn = await Mal.deploy();
    await tokenIn.waitForDeployment();
    await (await tokenIn.mint(deployer.address, ethers.parseEther("1000"))).wait();
    await (await tokenIn.approve(await adaptor.getAddress(), ethers.MaxUint256)).wait();

    const amountIn = ethers.parseEther("10");
    const swapParams = {
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      amountIn,
      minAmountOut: 0n,
      fee: 0,
      sqrtPriceLimitX96: 0n,
      path: "0x",
    };

    const inner = adaptor.interface.encodeFunctionData("executeSwap", [swapParams]);
    await (await tokenIn.configureCallback(await adaptor.getAddress(), inner, true)).wait();

    await expect(adaptor.executeSwap(swapParams)).to.be.revertedWith("ReentrancyGuard: reentrant call");
  });

  it("PancakeSwapAdaptor: ERC20 transferFrom returning false reverts (SafeERC20)", async function () {
    const [deployer] = await ethers.getSigners();

    const Router = await ethers.getContractFactory("MockPancakeRouterV2Minimal");
    const router = await Router.deploy();
    await router.waitForDeployment();

    const Adaptor = await ethers.getContractFactory("PancakeSwapAdaptor");
    const adaptor = await Adaptor.deploy(await router.getAddress(), deployer.address);
    await adaptor.waitForDeployment();

    const Out = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const tokenOut = await Out.deploy("Out", "OUT", 18);
    await tokenOut.waitForDeployment();
    await (await tokenOut.mint(await router.getAddress(), ethers.parseEther("1000000"))).wait();

    const Bad = await ethers.getContractFactory("BadReturnERC20");
    const tokenIn = await Bad.deploy();
    await tokenIn.waitForDeployment();
    await (await tokenIn.mint(deployer.address, ethers.parseEther("1000"))).wait();
    await (await tokenIn.approve(await adaptor.getAddress(), ethers.MaxUint256)).wait();

    const swapParams = {
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      amountIn: ethers.parseEther("1"),
      minAmountOut: 0n,
      fee: 0,
      sqrtPriceLimitX96: 0n,
      path: "0x",
    };

    await expect(adaptor.executeSwap(swapParams)).to.be.reverted;
  });

  it("ShieldedPool deposit: ERC777-style hook cannot re-enter deposit (nonReentrant)", async function () {
    const [deployer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const joinSplitVerifier = await MockVerifier.deploy();
    await joinSplitVerifier.waitForDeployment();
    const thresholdVerifier = await MockVerifier.deploy();
    await thresholdVerifier.waitForDeployment();

    const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
    const swapAdaptor = await MockSwapAdaptor.deploy();
    await swapAdaptor.waitForDeployment();

    const FeeOracle = await ethers.getContractFactory("FeeOracle");
    const feeOracle = await FeeOracle.deploy();
    await feeOracle.waitForDeployment();

    const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
    const relayerRegistry = await RelayerRegistry.deploy();
    await relayerRegistry.waitForDeployment();
    await (await relayerRegistry.registerRelayer(deployer.address)).wait();

    const ShieldedPool = await getShieldedPoolFactory("ShieldedPool");
    const shieldedPool = await ShieldedPool.deploy(
      await joinSplitVerifier.getAddress(),
      await joinSplitVerifier.getAddress(),
      await thresholdVerifier.getAddress(),
      await swapAdaptor.getAddress(),
      await feeOracle.getAddress(),
      await relayerRegistry.getAddress()
    );
    await shieldedPool.waitForDeployment();
    const poolAddr = await shieldedPool.getAddress();

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

    const pool = await ethers.getContractAt("ShieldedPool", poolAddr);
    await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();
    await (await pool.setTransactionHistory(await txHistory.getAddress())).wait();

    const Mal = await ethers.getContractFactory("MaliciousERC20Reentrant");
    const token = await Mal.deploy();
    await token.waitForDeployment();

    await (await pool.connect(deployer).registerAsset(1n, await token.getAddress())).wait();

    const amount = ethers.parseEther("100");
    const fee = ethers.parseEther("0.01");
    await (await token.mint(deployer.address, amount)).wait();
    await (await token.approve(poolAddr, amount)).wait();

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("m2-c1"));
    const c2 = ethers.keccak256(ethers.toUtf8Bytes("m2-c2"));
    const inner = pool.interface.encodeFunctionData("deposit", [
      await token.getAddress(),
      amount,
      c2,
      1n,
    ]);
    await (await token.configureCallback(poolAddr, inner, true)).wait();

    await expect(pool.connect(deployer).deposit(await token.getAddress(), amount, c1, 1n, { value: fee })).to.be
      .revertedWith("ReentrancyGuard: reentrant call");
  });

  it("ShieldedPool deposit: BadReturn ERC20 safeTransferFrom reverts", async function () {
    const [deployer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const joinSplitVerifier = await MockVerifier.deploy();
    await joinSplitVerifier.waitForDeployment();
    const thresholdVerifier = await MockVerifier.deploy();
    await thresholdVerifier.waitForDeployment();

    const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
    const swapAdaptor = await MockSwapAdaptor.deploy();
    await swapAdaptor.waitForDeployment();

    const FeeOracle = await ethers.getContractFactory("FeeOracle");
    const feeOracle = await FeeOracle.deploy();
    await feeOracle.waitForDeployment();

    const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
    const relayerRegistry = await RelayerRegistry.deploy();
    await relayerRegistry.waitForDeployment();
    await (await relayerRegistry.registerRelayer(deployer.address)).wait();

    const ShieldedPool = await getShieldedPoolFactory("ShieldedPool");
    const shieldedPool = await ShieldedPool.deploy(
      await joinSplitVerifier.getAddress(),
      await joinSplitVerifier.getAddress(),
      await thresholdVerifier.getAddress(),
      await swapAdaptor.getAddress(),
      await feeOracle.getAddress(),
      await relayerRegistry.getAddress()
    );
    await shieldedPool.waitForDeployment();
    const poolAddr = await shieldedPool.getAddress();

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

    const pool = await ethers.getContractAt("ShieldedPool", poolAddr);
    await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();
    await (await pool.setTransactionHistory(await txHistory.getAddress())).wait();

    const Bad = await ethers.getContractFactory("BadReturnERC20");
    const token = await Bad.deploy();
    await token.waitForDeployment();

    await (await pool.connect(deployer).registerAsset(1n, await token.getAddress())).wait();

    const amount = ethers.parseEther("1");
    const fee = ethers.parseEther("0.01");
    await (await token.mint(deployer.address, amount)).wait();
    await (await token.approve(poolAddr, amount)).wait();

    await expect(
      pool.connect(deployer).deposit(await token.getAddress(), amount, ethers.keccak256("0x01"), 1n, { value: fee })
    ).to.be.reverted;
  });
});
