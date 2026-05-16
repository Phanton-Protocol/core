/**
 * Test mirror of scripts/deploy/networkConfig.ts canonical constants.
 */
const BSC_TESTNET = {
  chainId: 97,
  bnbUsdFeed: "0x1A26d803C2e796601794f8C5609549643832702C",
};

const BSC_MAINNET = { chainId: 56 };

const PATH_B_CANONICAL_POOL_CONTRACT = "ShieldedPoolUpgradeableReduced";
const PATH_B_ALTERNATE_POOL_CONTRACTS = ["ShieldedPool", "ShieldedPoolUpgradeable"];

function assertPathBCanonicalPoolContract(contractName) {
  if (contractName !== PATH_B_CANONICAL_POOL_CONTRACT) {
    throw new Error(
      `Production Path-B pool must be ${PATH_B_CANONICAL_POOL_CONTRACT}, got ${contractName}`
    );
  }
}

async function assertProductionRelayerRegistry(registryAddress, provider) {
  const { ethers } = require("hardhat");
  if (!registryAddress || !ethers.isAddress(registryAddress)) {
    throw new Error(`Invalid RELAYER_REGISTRY: ${registryAddress || "(empty)"}`);
  }
  const iface = new ethers.Interface(["function totalStaked() view returns (uint256)"]);
  const data = iface.encodeFunctionData("totalStaked", []);
  try {
    await provider.call({ to: registryAddress, data });
  } catch {
    throw new Error(
      `Relayer registry ${registryAddress} is not RelayerStaking (totalStaked probe failed)`
    );
  }
}

async function assertGovernanceMigrationComplete(targets, provider) {
  const { ethers } = require("hardhat");
  const { poolAddress, timelockAddress, feeOracleAddress } = targets;
  const pool = await ethers.getContractAt(PATH_B_CANONICAL_POOL_CONTRACT, poolAddress);
  const poolTimelock = await pool.timelock();
  const poolEmergency = await pool.emergencyAdmin();
  if (!poolTimelock || poolTimelock === ethers.ZeroAddress) {
    throw new Error(`Pool ${poolAddress}: timelock unset — call initializeV2(timelock, emergencyAdmin)`);
  }
  if (ethers.getAddress(poolTimelock) !== ethers.getAddress(timelockAddress)) {
    throw new Error(`Pool timelock ${poolTimelock} != expected ${timelockAddress}`);
  }
  if (targets.emergencyAdminAddress) {
    if (ethers.getAddress(poolEmergency) !== ethers.getAddress(targets.emergencyAdminAddress)) {
      throw new Error(`Pool emergencyAdmin ${poolEmergency} != expected ${targets.emergencyAdminAddress}`);
    }
  } else if (!poolEmergency || poolEmergency === ethers.ZeroAddress) {
    throw new Error(`Pool ${poolAddress}: emergencyAdmin unset`);
  }

  const feeOracle = await ethers.getContractAt("FeeOracle", feeOracleAddress);
  const foTimelock = await feeOracle.timelock();
  if (!foTimelock || foTimelock === ethers.ZeroAddress) {
    throw new Error(`FeeOracle ${feeOracleAddress}: timelock unset`);
  }
  if (ethers.getAddress(foTimelock) !== ethers.getAddress(timelockAddress)) {
    throw new Error(`FeeOracle timelock ${foTimelock} != expected ${timelockAddress}`);
  }

  if (targets.complianceModuleAddress) {
    const cm = await ethers.getContractAt("ComplianceModule", targets.complianceModuleAddress);
    const cmTimelock = await cm.timelock();
    if (!cmTimelock || cmTimelock === ethers.ZeroAddress) {
      throw new Error(`ComplianceModule ${targets.complianceModuleAddress}: timelock unset`);
    }
    if (ethers.getAddress(cmTimelock) !== ethers.getAddress(timelockAddress)) {
      throw new Error(`ComplianceModule timelock ${cmTimelock} != expected ${timelockAddress}`);
    }
  }

  if (targets.relayerRegistryAddress) {
    await assertProductionRelayerRegistry(targets.relayerRegistryAddress, provider);
  }
}

function assertExpectedChainId(actual, expected) {
  if (Number(actual) !== Number(expected)) {
    throw new Error(`ChainId mismatch: connected network is ${actual}, script expects ${expected}`);
  }
}

function requireBnbUsdFeedForChain(chainId) {
  if (chainId === BSC_TESTNET.chainId) {
    return BSC_TESTNET.bnbUsdFeed;
  }
  const fromEnv = String(process.env.BNB_USD_FEED || "").trim();
  if (!fromEnv) {
    throw new Error(`BNB_USD_FEED is required for chainId ${chainId}`);
  }
  return fromEnv;
}

function assertOffchainOraclePolicy(chainId, offchainOracle) {
  if (offchainOracle && chainId === BSC_MAINNET.chainId) {
    throw new Error("OFFCHAIN_ORACLE_ADDRESS must not be set on BSC mainnet (chainId 56)");
  }
}

function assertProductionNetworkBinding(actualChainId, deployProfile) {
  const profile = String(deployProfile || "dev").toLowerCase();
  if (profile !== "staging" && profile !== "production") return;
  const expectedRaw = String(process.env.EXPECTED_CHAIN_ID || "").trim();
  if (!expectedRaw) {
    throw new Error(`EXPECTED_CHAIN_ID is required when DEPLOY_PROFILE is ${profile}`);
  }
  assertExpectedChainId(actualChainId, Number(expectedRaw));
}

const EXPERIMENTAL_DEPLOY_ENV_FLAGS = [
  "DEPLOY_EXPERIMENTAL",
  "DEPLOY_ADVANCED_PRIVACY_POOL",
  "DEPLOY_FHE_ENCRYPTED_POOL",
  "DEPLOY_INTERNAL_MATCHING_POOL",
  "DEPLOY_DARK_POOL",
];

function assertExperimentalDeployBlocked(env = process.env) {
  const profile = String(env.DEPLOY_PROFILE || "dev").toLowerCase();
  const productionProfile = profile === "staging" || profile === "production";
  const realInfraDev =
    profile === "dev" &&
    env.FORCE_MOCK_INFRASTRUCTURE !== undefined &&
    env.FORCE_MOCK_INFRASTRUCTURE !== "true";
  if (!productionProfile && !realInfraDev) return;
  for (const flag of EXPERIMENTAL_DEPLOY_ENV_FLAGS) {
    const v = String(env[flag] || "").trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") {
      throw new Error(`${flag}=true forbidden when DEPLOY_PROFILE=${profile}`);
    }
  }
}

module.exports = {
  assertExpectedChainId,
  requireBnbUsdFeedForChain,
  assertOffchainOraclePolicy,
  assertProductionNetworkBinding,
  assertExperimentalDeployBlocked,
  assertPathBCanonicalPoolContract,
  assertProductionRelayerRegistry,
  assertGovernanceMigrationComplete,
  PATH_B_CANONICAL_POOL_CONTRACT,
  PATH_B_ALTERNATE_POOL_CONTRACTS,
  BSC_TESTNET,
  BSC_MAINNET,
};
