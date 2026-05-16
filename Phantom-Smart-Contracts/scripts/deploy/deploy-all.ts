/**
 * Single-run deploy: core + handlers (local hardhat: one process).
 *
 * Prerequisite: HH_FULL=1 npm run compile
 *
 * DEPLOY_PROFILE=dev|staging|production — see deploy-core.ts
 */
import hre from "hardhat";
import { deployVerifiersAndSwapAdaptor } from "./deployInfrastructure";
import { deploymentTxHash, saveDeployment } from "./deploymentRecord";
import {
  assertExperimentalDeployBlocked,
  assertOffchainOraclePolicy,
  requireBnbUsdFeedForChain,
} from "./networkConfig";

const { ethers, network } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("Network:", network.name, "chainId:", chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("DEPLOY_PROFILE:", process.env.DEPLOY_PROFILE || "dev");

  const profile = (process.env.DEPLOY_PROFILE || "dev").toLowerCase();
  assertExperimentalDeployBlocked();
  const infra = await deployVerifiersAndSwapAdaptor();
  if (profile === "staging" || profile === "production") {
    if (infra.mockJoinSplit || infra.mockThreshold || infra.mockSwapAdaptor) {
      throw new Error(
        "Module 7 invariant: staging/production deploy must not record mock verifier/adaptor addresses."
      );
    }
    if (!infra.groth16Verifier) {
      throw new Error("Module 7 invariant: staging/production must deploy real Groth16 verifier.");
    }
  }

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  const feeOracleAddr = await feeOracle.getAddress();
  const offchainOracle = String(process.env.OFFCHAIN_ORACLE_ADDRESS || "").trim();
  assertOffchainOraclePolicy(Number(chainId), offchainOracle);
  if (offchainOracle) {
    await (await feeOracle.setOffchainOracle(offchainOracle)).wait();
    console.log("FeeOracle.offchainOracle:", offchainOracle);
  }
  const bnbUsdFeed = requireBnbUsdFeedForChain(Number(chainId));
  await (await feeOracle.setPriceFeed(ethers.ZeroAddress, bnbUsdFeed)).wait();
  console.log("FeeOracle BNB/USD feed:", bnbUsdFeed);

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  const relayerRegistryAddr = await relayerRegistry.getAddress();

  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const InternalMatchIntentLib = await ethers.getContractFactory("InternalMatchIntentLib");
  const internalMatchIntentLib = await InternalMatchIntentLib.deploy();
  await internalMatchIntentLib.waitForDeployment();
  const internalMatchIntentLibAddr = await internalMatchIntentLib.getAddress();

  const ShieldedPool = await ethers.getContractFactory("ShieldedPool", {
    libraries: { InternalMatchIntentLib: internalMatchIntentLibAddr },
  });
  const shieldedPool = await ShieldedPool.deploy(
    infra.joinSplit,
    infra.portfolio,
    infra.threshold,
    infra.swapAdaptor,
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

  const contracts: Record<string, string> = {
    joinSplitVerifier: infra.joinSplit,
    portfolioVerifier: infra.portfolio,
    thresholdVerifier: infra.threshold,
    swapAdaptor: infra.swapAdaptor,
    feeOracle: feeOracleAddr,
    relayerRegistry: relayerRegistryAddr,
    shieldedPool: shieldedPoolAddr,
    depositHandler: depositHandlerAddr,
    transactionHistory: txHistoryAddr,
  };
  const deploymentTxs: Record<string, string> = {
    ...infra.deploymentTxs,
    feeOracle: deploymentTxHash(feeOracle),
    relayerRegistry: deploymentTxHash(relayerRegistry),
    shieldedPool: deploymentTxHash(shieldedPool),
    depositHandler: deploymentTxHash(depositHandler),
    transactionHistory: deploymentTxHash(txHistory),
  };
  if (infra.groth16Verifier) {
    contracts.groth16Verifier = infra.groth16Verifier;
  }
  if (infra.mockJoinSplit) {
    contracts.mockVerifierJoinSplit = infra.mockJoinSplit;
    contracts.mockVerifierThreshold = infra.mockThreshold!;
    contracts.mockSwapAdaptor = infra.mockSwapAdaptor!;
    deploymentTxs.mockVerifierJoinSplit = deploymentTxs.joinSplitVerifier;
    deploymentTxs.mockVerifierThreshold = deploymentTxs.thresholdVerifier;
    deploymentTxs.mockSwapAdaptor = deploymentTxs.swapAdaptor;
  }

  const out = saveDeployment(
    network.name,
    chainId,
    deployer.address,
    "ShieldedPool",
    contracts,
    deploymentTxs
  );
  console.log("Wrote", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
