/**
 * Post-migration gate: pool initializeV2, FeeOracle/Compliance timelocks, optional RelayerStaking probe.
 *
 * Env:
 *   GOVERNANCE_TIMELOCK_ADDRESS (or TIMELOCK_ADDRESS)
 *   REDUCED_POOL_ADDRESS
 *   REDUCED_FEE_ORACLE_ADDRESS
 *   COMPLIANCE_MODULE_ADDRESS (optional)
 *   REDUCED_RELAYER_REGISTRY_ADDRESS (optional; must be RelayerStaking)
 *   EMERGENCY_ADMIN_ADDRESS (optional; else requires nonzero pool.emergencyAdmin)
 */
import hre from "hardhat";
import {
  assertGovernanceMigrationComplete,
  assertProductionNetworkBinding,
  requireGovernanceTimelockAddress,
} from "./networkConfig";

const { ethers, network } = hre;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const profile = (process.env.DEPLOY_PROFILE || "staging").toLowerCase();
  assertProductionNetworkBinding(chainId, profile);

  const timelockAddr = requireGovernanceTimelockAddress();
  const poolAddr = String(process.env.REDUCED_POOL_ADDRESS || "").trim();
  const feeOracleAddr = String(process.env.REDUCED_FEE_ORACLE_ADDRESS || "").trim();
  const complianceAddr = String(process.env.COMPLIANCE_MODULE_ADDRESS || "").trim();
  const relayerAddr = String(process.env.REDUCED_RELAYER_REGISTRY_ADDRESS || "").trim();
  const emergencyAdmin = String(process.env.EMERGENCY_ADMIN_ADDRESS || "").trim();

  if (!poolAddr || !feeOracleAddr) {
    throw new Error("REDUCED_POOL_ADDRESS and REDUCED_FEE_ORACLE_ADDRESS are required");
  }

  await assertGovernanceMigrationComplete(
    {
      poolAddress: poolAddr,
      timelockAddress: timelockAddr,
      feeOracleAddress: feeOracleAddr,
      complianceModuleAddress: complianceAddr || undefined,
      relayerRegistryAddress: relayerAddr || undefined,
      emergencyAdminAddress: emergencyAdmin || undefined,
    },
    ethers.provider
  );

  console.log("[assert-governance-migration] OK", {
    network: network.name,
    chainId,
    pool: poolAddr,
    timelock: timelockAddr,
    feeOracle: feeOracleAddr,
  });
}

main().catch((err) => {
  console.error("[assert-governance-migration] failed:", err);
  process.exit(1);
});
