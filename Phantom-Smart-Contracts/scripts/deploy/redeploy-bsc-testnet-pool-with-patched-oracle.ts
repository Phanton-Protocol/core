import hre from "hardhat";
import { deploymentTxHash, loadDeployment, saveDeployment } from "./deploymentRecord";

const { ethers, network } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const prev = loadDeployment(network.name);

  const joinSplit = prev.contracts.joinSplitVerifier;
  const threshold = prev.contracts.thresholdVerifier;
  let swapAdaptor = prev.contracts.swapAdaptor;
  const relayerRegistry = prev.contracts.relayerRegistry;
  if (!joinSplit || !threshold || !swapAdaptor || !relayerRegistry) {
    throw new Error("deployments entry missing one of joinSplitVerifier/thresholdVerifier/swapAdaptor/relayerRegistry");
  }

  console.log("[redeploy] network:", network.name, "chainId:", chainId.toString());
  console.log("[redeploy] deployer:", deployer.address);
  console.log("[redeploy] previous pool:", prev.contracts.shieldedPool);
  console.log("[redeploy] previous feeOracle:", prev.contracts.feeOracle);

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  const feeOracleAddr = await feeOracle.getAddress();
  console.log("[redeploy] new FeeOracle:", feeOracleAddr);

  const offchainOracle = String(process.env.OFFCHAIN_ORACLE_ADDRESS || "").trim();
  if (offchainOracle) {
    await (await feeOracle.setOffchainOracle(offchainOracle)).wait();
    console.log("[redeploy] FeeOracle.offchainOracle set:", offchainOracle);
  }
  const bnbUsdFeed = String(process.env.BNB_USD_FEED || "").trim();
  if (bnbUsdFeed) {
    await (await feeOracle.setPriceFeed(ethers.ZeroAddress, bnbUsdFeed)).wait();
    console.log("[redeploy] FeeOracle BNB/USD feed set:", bnbUsdFeed);
  }

  const deployRealSwapAdaptor = String(process.env.DEPLOY_REAL_SWAP_ADAPTOR || "").trim().toLowerCase() === "true";
  if (deployRealSwapAdaptor) {
    const router = String(process.env.PANCAKE_ROUTER || "").trim();
    const wbnb = String(process.env.WBNB_ADDRESS || "").trim();
    if (!router || !wbnb) {
      throw new Error("DEPLOY_REAL_SWAP_ADAPTOR=true requires PANCAKE_ROUTER and WBNB_ADDRESS");
    }
    const PancakeSwapAdaptor = await ethers.getContractFactory("PancakeSwapAdaptor");
    const realAdaptor = await PancakeSwapAdaptor.deploy(router, wbnb);
    await realAdaptor.waitForDeployment();
    swapAdaptor = await realAdaptor.getAddress();
    console.log("[redeploy] new real PancakeSwapAdaptor:", swapAdaptor);
  } else {
    console.log("[redeploy] reusing existing swapAdaptor:", swapAdaptor);
  }

  const InternalMatchIntentLib = await ethers.getContractFactory("InternalMatchIntentLib");
  const internalMatchIntentLib = await InternalMatchIntentLib.deploy();
  await internalMatchIntentLib.waitForDeployment();
  const ShieldedPool = await ethers.getContractFactory("ShieldedPool", {
    libraries: { InternalMatchIntentLib: await internalMatchIntentLib.getAddress() },
  });
  const pool = await ShieldedPool.deploy(joinSplit, joinSplit, threshold, swapAdaptor, feeOracleAddr, relayerRegistry);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("[redeploy] new ShieldedPool:", poolAddr);

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(poolAddr, feeOracleAddr, relayerRegistry);
  await depositHandler.waitForDeployment();
  const depositHandlerAddr = await depositHandler.getAddress();
  console.log("[redeploy] new DepositHandler:", depositHandlerAddr);

  const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
  const txHistory = await TransactionHistory.deploy(poolAddr);
  await txHistory.waitForDeployment();
  const txHistoryAddr = await txHistory.getAddress();
  console.log("[redeploy] new TransactionHistory:", txHistoryAddr);

  await (await pool.setDepositHandler(depositHandlerAddr)).wait();
  await (await pool.setTransactionHistory(txHistoryAddr)).wait();
  console.log("[redeploy] handlers wired");

  // Re-register assets from config to keep asset IDs consistent with backend mappings.
  const cfg = await import("../../config/bscTestnet.json");
  const assets = Array.isArray(cfg.assets) ? cfg.assets : [];
  for (const a of assets) {
    const id = Number(a.assetId);
    const addr = String(a.address || "").trim();
    if (!Number.isFinite(id) || id < 0) continue;
    if (id === 0) continue; // Native asset is implicit address(0) in pool.
    if (!addr) continue;
    await (await pool.registerAsset(BigInt(id), addr)).wait();
    console.log(`[redeploy] registerAsset assetId=${id} address=${addr}`);
  }

  const contracts: Record<string, string> = {
    ...prev.contracts,
    portfolioVerifier: joinSplit,
    swapAdaptor,
    feeOracle: feeOracleAddr,
    shieldedPool: poolAddr,
    depositHandler: depositHandlerAddr,
    transactionHistory: txHistoryAddr,
  };
  delete contracts.mockSwapAdaptor;
  delete contracts.mockVerifierJoinSplit;
  delete contracts.mockVerifierThreshold;
  const deploymentTxs: Record<string, string> = {
    ...(prev.deploymentTxs || {}),
    feeOracle: deploymentTxHash(feeOracle),
    shieldedPool: deploymentTxHash(pool),
    depositHandler: deploymentTxHash(depositHandler),
    transactionHistory: deploymentTxHash(txHistory),
  };

  const out = saveDeployment(network.name, chainId, deployer.address, "ShieldedPool", contracts, deploymentTxs);
  console.log("[redeploy] wrote deployment file:", out);
}

main().catch((e) => {
  console.error("[redeploy] failed:", e);
  process.exit(1);
});

