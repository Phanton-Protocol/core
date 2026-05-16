/**
 * Per-network address book + fail-fast assertions for Path-B deploy scripts (Module 6).
 */
import { ethers } from "hardhat";

export type NetworkAddresses = {
  chainId: number;
  bnbUsdFeed: string;
  pancakeRouter: string;
  wbnb: string;
};

const BSC_TESTNET: NetworkAddresses = {
  chainId: 97,
  bnbUsdFeed: "0x1A26d803C2e796601794f8C5609549643832702C",
  pancakeRouter: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
  wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
};

const BSC_MAINNET: NetworkAddresses = {
  chainId: 56,
  bnbUsdFeed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  pancakeRouter: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
};

const HARDHAT_LOCAL: NetworkAddresses = {
  chainId: 31337,
  bnbUsdFeed: "",
  pancakeRouter: "",
  wbnb: "",
};

const BY_CHAIN_ID: Record<number, NetworkAddresses> = {
  [BSC_TESTNET.chainId]: BSC_TESTNET,
  [BSC_MAINNET.chainId]: BSC_MAINNET,
  [HARDHAT_LOCAL.chainId]: HARDHAT_LOCAL,
};

export function getNetworkAddresses(chainId: number): NetworkAddresses | undefined {
  return BY_CHAIN_ID[chainId];
}

export function assertExpectedChainId(actualChainId: bigint | number, expectedChainId: number): void {
  const actual = Number(actualChainId);
  if (actual !== expectedChainId) {
    throw new Error(
      `ChainId mismatch: connected network is ${actual}, script expects ${expectedChainId}. ` +
        `Refusing to deploy with wrong network configuration.`
    );
  }
}

export function assertAddress(label: string, value: string): void {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Invalid ${label}: ${value || "(empty)"}`);
  }
}

/** Fail if env address does not match the canonical book for this chainId. */
export function assertCanonicalAddress(
  label: string,
  actual: string,
  expected: string,
  chainId: number
): void {
  assertAddress(label, actual);
  if (expected && ethers.getAddress(actual) !== ethers.getAddress(expected)) {
    throw new Error(
      `${label} mismatch on chainId ${chainId}: got ${actual}, expected canonical ${expected}`
    );
  }
}

/**
 * Resolve BNB/USD feed, Pancake router, and WBNB for staging/production deploys.
 * Uses env overrides when set, but validates against the canonical book when known.
 */
export function resolveProductionOracleAndDex(chainId: number): {
  bnbUsdFeed: string;
  pancakeRouter: string;
  wbnb: string;
} {
  const book = getNetworkAddresses(chainId);
  if (!book || book.chainId === HARDHAT_LOCAL.chainId) {
    throw new Error(
      `resolveProductionOracleAndDex: no canonical address book for chainId ${chainId}. ` +
        `Set PANCAKE_ROUTER, WBNB_ADDRESS, and BNB_USD_FEED explicitly for local dev.`
    );
  }

  const bnbUsdFeed = String(process.env.BNB_USD_FEED || book.bnbUsdFeed).trim();
  const pancakeRouter = String(process.env.PANCAKE_ROUTER || book.pancakeRouter).trim();
  const wbnb = String(process.env.WBNB_ADDRESS || book.wbnb).trim();

  assertCanonicalAddress("BNB_USD_FEED", bnbUsdFeed, book.bnbUsdFeed, chainId);
  assertCanonicalAddress("PANCAKE_ROUTER", pancakeRouter, book.pancakeRouter, chainId);
  assertCanonicalAddress("WBNB_ADDRESS", wbnb, book.wbnb, chainId);

  return { bnbUsdFeed, pancakeRouter, wbnb };
}

/** BNB/USD feed is mandatory on known networks; forbids silent mainnet feed on testnet. */
export function requireBnbUsdFeedForChain(chainId: number): string {
  const book = getNetworkAddresses(chainId);
  const fromEnv = String(process.env.BNB_USD_FEED || "").trim();

  if (book && book.chainId !== HARDHAT_LOCAL.chainId) {
    const feed = fromEnv || book.bnbUsdFeed;
    assertCanonicalAddress("BNB_USD_FEED", feed, book.bnbUsdFeed, chainId);
    return feed;
  }

  if (!fromEnv) {
    throw new Error(
      `BNB_USD_FEED is required for chainId ${chainId} (no silent mainnet default in FeeOracle constructor).`
    );
  }
  assertAddress("BNB_USD_FEED", fromEnv);
  return fromEnv;
}

/** Off-chain oracle is allowed on testnet only; production mainnet must use Chainlink. */
export function assertOffchainOraclePolicy(chainId: number, offchainOracle: string): void {
  if (!offchainOracle) return;
  assertAddress("OFFCHAIN_ORACLE_ADDRESS", offchainOracle);
  if (chainId === BSC_MAINNET.chainId) {
    throw new Error(
      "OFFCHAIN_ORACLE_ADDRESS must not be set on BSC mainnet (chainId 56). Use Chainlink feeds only."
    );
  }
}

/**
 * Staging/production deploy gate: EXPECTED_CHAIN_ID must be set and must match the RPC network.
 */
export function assertProductionNetworkBinding(
  actualChainId: bigint | number,
  deployProfile: string
): void {
  const profile = deployProfile.toLowerCase();
  if (profile !== "staging" && profile !== "production") return;

  const expectedRaw = String(process.env.EXPECTED_CHAIN_ID || "").trim();
  if (!expectedRaw) {
    throw new Error(
      `EXPECTED_CHAIN_ID is required when DEPLOY_PROFILE is ${profile} (refuses misconfigured RPC deploy).`
    );
  }
  const expected = Number(expectedRaw);
  assertExpectedChainId(actualChainId, expected);

  const hardhatNetwork = String(process.env.HARDHAT_NETWORK || "").trim();
  if (hardhatNetwork) {
    const book = getNetworkAddresses(expected);
    if (book && hardhatNetwork !== "hardhat" && hardhatNetwork !== "localhost") {
      const expectedNames: Record<number, string[]> = {
        56: ["bsc", "bscMainnet", "bsc-mainnet"],
        97: ["bscTestnet", "bsc-testnet", "chapel"],
      };
      const allowed = expectedNames[expected];
      if (allowed && !allowed.includes(hardhatNetwork)) {
        throw new Error(
          `HARDHAT_NETWORK=${hardhatNetwork} does not match EXPECTED_CHAIN_ID=${expected}. ` +
            `Use one of: ${allowed.join(", ")}`
        );
      }
    }
  }
}

/** Production compliance requires a deployed Chainalysis oracle contract. */
export async function assertChainalysisOracleDeployed(
  oracleAddress: string,
  provider: { getCode: (address: string) => Promise<string> }
): Promise<void> {
  assertAddress("CHAINALYSIS_ORACLE_ADDRESS", oracleAddress);
  const code = await provider.getCode(oracleAddress);
  if (!code || code === "0x") {
    throw new Error(
      `CHAINALYSIS_ORACLE_ADDRESS ${oracleAddress} has no contract code (refusing production compliance wiring).`
    );
  }
}

/** Path-B production pool (UUPS, EIP-170 sized). Canonical deploy target. */
export const PATH_B_CANONICAL_POOL_CONTRACT = "ShieldedPoolUpgradeableReduced" as const;

/** Lab / legacy pools — not Path-B production (see docs/PATH_B_PRODUCTION_RUNBOOK.md). */
export const PATH_B_ALTERNATE_POOL_CONTRACTS = ["ShieldedPool", "ShieldedPoolUpgradeable"] as const;

export function assertPathBCanonicalPoolContract(contractName: string): void {
  if (contractName !== PATH_B_CANONICAL_POOL_CONTRACT) {
    throw new Error(
      `Production Path-B pool must be ${PATH_B_CANONICAL_POOL_CONTRACT}, got ${contractName}. ` +
        `Alternate pools (${PATH_B_ALTERNATE_POOL_CONTRACTS.join(", ")}) are lab-only.`
    );
  }
}

const RELAYER_STAKING_PROBE_ABI = ["function totalStaked() view returns (uint256)"];

/**
 * Path-B production: pool.initialize(..., relayerRegistry) must point at **RelayerStaking**
 * (implements IRelayerRegistry). Bare RelayerRegistry is for local/tests only.
 */
export async function assertProductionRelayerRegistry(
  registryAddress: string,
  provider: { call: (tx: { to: string; data: string }) => Promise<string> }
): Promise<void> {
  assertAddress("RELAYER_REGISTRY", registryAddress);
  const iface = new ethers.Interface(RELAYER_STAKING_PROBE_ABI);
  const data = iface.encodeFunctionData("totalStaked", []);
  try {
    await provider.call({ to: registryAddress, data });
  } catch {
    throw new Error(
      `Relayer registry ${registryAddress} is not RelayerStaking (totalStaked probe failed). ` +
        `Path-B production deploys RelayerStaking at pool.relayerRegistry — see docs/PATH_B_PRODUCTION_RUNBOOK.md.`
    );
  }
}

export type GovernanceMigrationTargets = {
  poolAddress: string;
  timelockAddress: string;
  feeOracleAddress: string;
  complianceModuleAddress?: string;
  relayerRegistryAddress?: string;
  emergencyAdminAddress?: string;
};

/** Post-migration gate: pool V2, FeeOracle timelock, optional ComplianceModule timelock. */
export async function assertGovernanceMigrationComplete(
  targets: GovernanceMigrationTargets,
  provider: { call: (tx: { to: string; data: string }) => Promise<string> }
): Promise<void> {
  const { poolAddress, timelockAddress, feeOracleAddress } = targets;
  assertAddress("REDUCED_POOL_ADDRESS", poolAddress);
  assertAddress("GOVERNANCE_TIMELOCK_ADDRESS", timelockAddress);
  assertAddress("FEE_ORACLE_ADDRESS", feeOracleAddress);

  const pool = await ethers.getContractAt(PATH_B_CANONICAL_POOL_CONTRACT, poolAddress);
  const poolTimelock = await pool.timelock();
  const poolEmergency = await pool.emergencyAdmin();
  if (!poolTimelock || poolTimelock === ethers.ZeroAddress) {
    throw new Error(`Pool ${poolAddress}: timelock unset — call initializeV2(timelock, emergencyAdmin).`);
  }
  if (ethers.getAddress(poolTimelock) !== ethers.getAddress(timelockAddress)) {
    throw new Error(`Pool timelock ${poolTimelock} != expected ${timelockAddress}`);
  }
  if (targets.emergencyAdminAddress) {
    assertAddress("EMERGENCY_ADMIN_ADDRESS", targets.emergencyAdminAddress);
    if (ethers.getAddress(poolEmergency) !== ethers.getAddress(targets.emergencyAdminAddress)) {
      throw new Error(`Pool emergencyAdmin ${poolEmergency} != expected ${targets.emergencyAdminAddress}`);
    }
  } else if (!poolEmergency || poolEmergency === ethers.ZeroAddress) {
    throw new Error(`Pool ${poolAddress}: emergencyAdmin unset — call initializeV2(timelock, emergencyAdmin).`);
  }

  const feeOracle = await ethers.getContractAt("FeeOracle", feeOracleAddress);
  const foTimelock = await feeOracle.timelock();
  if (!foTimelock || foTimelock === ethers.ZeroAddress) {
    throw new Error(`FeeOracle ${feeOracleAddress}: timelock unset — call initializeTimelock(timelock).`);
  }
  if (ethers.getAddress(foTimelock) !== ethers.getAddress(timelockAddress)) {
    throw new Error(`FeeOracle timelock ${foTimelock} != expected ${timelockAddress}`);
  }

  if (targets.complianceModuleAddress) {
    const cm = await ethers.getContractAt("ComplianceModule", targets.complianceModuleAddress);
    const cmTimelock = await cm.timelock();
    if (!cmTimelock || cmTimelock === ethers.ZeroAddress) {
      throw new Error(
        `ComplianceModule ${targets.complianceModuleAddress}: timelock unset — call initializeTimelock(timelock).`
      );
    }
    if (ethers.getAddress(cmTimelock) !== ethers.getAddress(timelockAddress)) {
      throw new Error(`ComplianceModule timelock ${cmTimelock} != expected ${timelockAddress}`);
    }
  }

  if (targets.relayerRegistryAddress) {
    await assertProductionRelayerRegistry(targets.relayerRegistryAddress, provider);
  }
}

/** Research / oversized pool variants — never Path-B production deploy targets. */
export const EXPERIMENTAL_CONTRACT_NAMES = [
  "AdvancedPrivacyPool",
  "FHEEncryptedPool",
  "InternalMatchingPool",
  "DarkPool",
  "EncryptedPool",
  "PrivacyEnhancedPool",
  "HybridPrivacyPool",
  "PrivateSwapPool",
  "AntiAnalysisPool",
  "DynamicPoolFactory",
] as const;

/** Env flags that would opt into deploying an experimental pool (forbidden on production paths). */
export const EXPERIMENTAL_DEPLOY_ENV_FLAGS = [
  "DEPLOY_EXPERIMENTAL",
  "DEPLOY_ADVANCED_PRIVACY_POOL",
  "DEPLOY_FHE_ENCRYPTED_POOL",
  "DEPLOY_INTERNAL_MATCHING_POOL",
  "DEPLOY_DARK_POOL",
  "DEPLOY_ENCRYPTED_POOL",
  "DEPLOY_PRIVACY_ENHANCED_POOL",
  "DEPLOY_HYBRID_PRIVACY_POOL",
  "DEPLOY_PRIVATE_SWAP_POOL",
  "DEPLOY_DYNAMIC_POOL_FACTORY",
] as const;

/**
 * Production-like deploy: staging/production profile, or dev with real infra
 * (`FORCE_MOCK_INFRASTRUCTURE` not explicitly true). Refuses experimental pool flags.
 */
export function assertExperimentalDeployBlocked(): void {
  const profile = (process.env.DEPLOY_PROFILE || "dev").toLowerCase();
  const productionProfile = profile === "staging" || profile === "production";
  const realInfraDev =
    profile === "dev" &&
    process.env.FORCE_MOCK_INFRASTRUCTURE !== undefined &&
    process.env.FORCE_MOCK_INFRASTRUCTURE !== "true";

  if (!productionProfile && !realInfraDev) {
    return;
  }

  for (const flag of EXPERIMENTAL_DEPLOY_ENV_FLAGS) {
    const v = String(process.env[flag] || "").trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") {
      throw new Error(
        `${flag}=true is forbidden when DEPLOY_PROFILE=${profile} ` +
          `(experimental contracts: ${EXPERIMENTAL_CONTRACT_NAMES.join(", ")}). ` +
          `Path-B production uses ShieldedPoolUpgradeableReduced only.`
      );
    }
  }
}

export function requireGovernanceTimelockAddress(): string {
  const t = String(process.env.GOVERNANCE_TIMELOCK_ADDRESS || process.env.TIMELOCK_ADDRESS || "").trim();
  if (!t) {
    throw new Error(
      "GOVERNANCE_TIMELOCK_ADDRESS (or TIMELOCK_ADDRESS) is required to initialize oracle/compliance timelocks."
    );
  }
  assertAddress("GOVERNANCE_TIMELOCK_ADDRESS", t);
  return t;
}
