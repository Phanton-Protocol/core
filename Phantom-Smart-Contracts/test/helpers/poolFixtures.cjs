const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./libraryLinker.cjs");

const TREE_DEPTH = 10n;

/**
 * Merkle path for the first leaf (index 0) in a depth-10 tree — matches IncrementalMerkleTree + ShieldedPool.
 */
async function merkleProofForFirstLeaf(commitment) {
  const Harness = await ethers.getContractFactory("LibraryTestHarness");
  const h = await Harness.deploy();
  await h.waitForDeployment();
  await (await h.treeInit(TREE_DEPTH)).wait();
  await (await h.treeInsert(commitment)).wait();
  const root = await h.treeRoot();
  const path = [];
  for (let i = 0; i < 10; i++) {
    path.push(BigInt(await h.treeZero(i)));
  }
  return { root, path, indices: Array(10).fill(0n) };
}

function emptyProof() {
  return { a: "0x", b: "0x", c: "0x" };
}

/**
 * Deploy ShieldedPool + mocks + DepositHandler + TransactionHistory; register deployer as relayer.
 */
async function deployPoolFixture() {
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
  const poolAddr = await shieldedPool.getAddress();

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(poolAddr, feeOracleAddr, relayerRegistryAddr);
  await depositHandler.waitForDeployment();
  const depositHandlerAddr = await depositHandler.getAddress();

  const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
  const txHistory = await TransactionHistory.deploy(poolAddr);
  await txHistory.waitForDeployment();
  const txHistoryAddr = await txHistory.getAddress();

  const pool = await ethers.getContractAt("ShieldedPool", poolAddr);
  await (await pool.setDepositHandler(depositHandlerAddr)).wait();
  await (await pool.setTransactionHistory(txHistoryAddr)).wait();

  return {
    deployer,
    pool,
    poolAddr,
    feeOracle: await ethers.getContractAt("FeeOracle", feeOracleAddr),
    feeOracleAddr,
    swapAdaptorAddr,
    relayerRegistryAddr,
  };
}

/**
 * Protocol + swap fee as computed on-chain for join-split (matches ShieldedPool).
 */
async function totalJoinSplitFeeBnb(feeOracle, inputAmount) {
  const protocolPart = await feeOracle.calculateFee.staticCall(ethers.ZeroAddress, inputAmount);
  const swapFee = (inputAmount * 10n) / 10000n; // 10 bps — matches `DexSwapFee` / SwapHandler
  return protocolPart + swapFee;
}

/** Register commit-reveal state required by ShieldedPool._verifyMEVProtection before join-split swap. */
async function commitJoinSplitMevProtection(pool, signer, tag = "mev-commit") {
  const { time } = require("@nomicfoundation/hardhat-network-helpers");
  const commitment = ethers.keccak256(ethers.toUtf8Bytes(tag));
  const deadline = BigInt(await time.latest()) + 3500n;
  await pool.connect(signer).commitSwap(commitment, deadline);
  return { commitment, deadline, nonce: 1n };
}

module.exports = {
  merkleProofForFirstLeaf,
  emptyProof,
  deployPoolFixture,
  totalJoinSplitFeeBnb,
  commitJoinSplitMevProtection,
  TREE_DEPTH,
};
