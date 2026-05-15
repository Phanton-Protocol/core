import hre from "hardhat";
import { getReducedPoolFactory } from "./joinSplitFeeValidationLink";

const { ethers } = hre;

async function main() {
  const joinVerifier = String(process.env.JOIN_VERIFIER || "").trim();
  const swapAdaptor = String(process.env.SWAP_ADAPTOR || "").trim();
  const feeOracle = String(process.env.FEE_ORACLE || "").trim();
  const relayerRegistry = String(process.env.RELAYER_REGISTRY || "").trim();
  if (!joinVerifier || !swapAdaptor || !feeOracle || !relayerRegistry) {
    throw new Error("Set JOIN_VERIFIER, SWAP_ADAPTOR, FEE_ORACLE, RELAYER_REGISTRY");
  }

  const [deployer] = await ethers.getSigners();
  console.log("[path-b] redeploy pool deployer:", deployer.address);

  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const thresholdMock = await MockVerifier.deploy();
  await thresholdMock.waitForDeployment();
  const thresholdAddr = await thresholdMock.getAddress();
  console.log("[path-b] threshold mock:", thresholdAddr);

  const ReducedPool = await getReducedPoolFactory(deployer);
  const pool = await ReducedPool.deploy();
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("[path-b] new pool:", poolAddr);

  await (
    await pool.initialize(joinVerifier, thresholdAddr, swapAdaptor, feeOracle, relayerRegistry)
  ).wait();
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

