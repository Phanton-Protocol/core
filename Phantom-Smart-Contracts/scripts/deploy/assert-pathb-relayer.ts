/**
 * Verify Path-B relayer wiring: pool.relayerRegistry is RelayerStaking (not bare RelayerRegistry).
 *
 * Env: REDUCED_POOL_ADDRESS, REDUCED_RELAYER_REGISTRY_ADDRESS (optional; defaults to pool.relayerRegistry())
 */
import hre from "hardhat";
import { assertProductionRelayerRegistry } from "./networkConfig";

const { ethers, network } = hre;

async function main() {
  const poolAddr = String(process.env.REDUCED_POOL_ADDRESS || "").trim();
  if (!poolAddr) {
    throw new Error("REDUCED_POOL_ADDRESS is required");
  }

  let registryAddr = String(process.env.REDUCED_RELAYER_REGISTRY_ADDRESS || "").trim();
  const pool = await ethers.getContractAt("ShieldedPoolUpgradeableReduced", poolAddr);
  if (!registryAddr) {
    registryAddr = await pool.relayerRegistry();
  }

  await assertProductionRelayerRegistry(registryAddr, ethers.provider);
  const onPool = await pool.relayerRegistry();
  if (ethers.getAddress(onPool) !== ethers.getAddress(registryAddr)) {
    throw new Error(`pool.relayerRegistry ${onPool} != env registry ${registryAddr}`);
  }

  console.log("[assert-pathb-relayer] OK", {
    network: network.name,
    pool: poolAddr,
    relayerStaking: registryAddr,
  });
}

main().catch((err) => {
  console.error("[assert-pathb-relayer] failed:", err);
  process.exit(1);
});
