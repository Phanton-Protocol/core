/**
 * Test mirror of scripts/deploy/networkConfig.ts canonical constants.
 */
const BSC_TESTNET = {
  chainId: 97,
  bnbUsdFeed: "0x1A26d803C2e796601794f8C5609549643832702C",
};

const BSC_MAINNET = { chainId: 56 };

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
  BSC_TESTNET,
};
