import hre from "hardhat";
import { getReducedPoolFactory } from "./joinSplitFeeValidationLink";

const { ethers } = hre;

async function main() {
  const verifier = String(process.env.VERIFIER || "").trim();
  const thresholdVerifier = String(process.env.THRESHOLD_VERIFIER || "").trim();
  const swapAdaptor = String(process.env.SWAP_ADAPTOR || "").trim();
  const feeOracle = String(process.env.FEE_ORACLE || "").trim();
  const relayerRegistry = String(process.env.RELAYER_REGISTRY || "").trim();
  if (!verifier || !thresholdVerifier || !swapAdaptor || !feeOracle || !relayerRegistry) {
    throw new Error("Set VERIFIER, THRESHOLD_VERIFIER, SWAP_ADAPTOR, FEE_ORACLE, RELAYER_REGISTRY");
  }

  const [deployer] = await ethers.getSigners();
  console.log("[path-b] adapter-pool deployer:", deployer.address);

  const ReducedPool = await getReducedPoolFactory(deployer);
  const pool = await ReducedPool.deploy();
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("[path-b] pool:", poolAddr);

  await (await pool.initialize(verifier, thresholdVerifier, swapAdaptor, feeOracle, relayerRegistry)).wait();
  console.log("[path-b] pool initialized");

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const handler = await DepositHandler.deploy(poolAddr, feeOracle, relayerRegistry);
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  await (await pool.setDepositHandler(handlerAddr)).wait();
  console.log("[path-b] depositHandler:", handlerAddr);
}

main().catch((e) => {
  console.error("[path-b] failed:", e);
  process.exit(1);
});

