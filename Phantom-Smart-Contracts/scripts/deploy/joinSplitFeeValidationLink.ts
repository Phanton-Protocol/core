import hre from "hardhat";

const { ethers } = hre;

const JOIN_SPLIT_FEE_LIB_FQN =
  "contracts/_full/libraries/JoinSplitFeeValidation.sol:JoinSplitFeeValidation";
const MEV_COMMIT_LIB_FQN = "contracts/_full/libraries/MevCommitReveal.sol:MevCommitReveal";
const POOL_HELPERS_LIB_FQN = "contracts/_full/libraries/PoolHelpersLib.sol:PoolHelpersLib";

/** Deploy external libraries required to link Reduced / Upgradeable pool impls. */
export async function deployUpgradeablePoolLibraries() {
  const FeeLib = await ethers.getContractFactory(JOIN_SPLIT_FEE_LIB_FQN);
  const feeLib = await FeeLib.deploy();
  await feeLib.waitForDeployment();
  const MevLib = await ethers.getContractFactory(MEV_COMMIT_LIB_FQN);
  const mevLib = await MevLib.deploy();
  await mevLib.waitForDeployment();
  // Path-B: the Reduced pool links a small helper library
  // ({PoolHelpersLib}) that holds `_checkCompliance`, `_distributeProtocolFee`,
  // and the deposit-fee branch of `_finalizeDepositLogic` to keep the impl
  // under EIP-170.
  const Helpers = await ethers.getContractFactory(POOL_HELPERS_LIB_FQN);
  const helpers = await Helpers.deploy();
  await helpers.waitForDeployment();
  return {
    JoinSplitFeeValidation: await feeLib.getAddress(),
    MevCommitReveal: await mevLib.getAddress(),
    PoolHelpersLib: await helpers.getAddress(),
  };
}

/** `getContractFactory` for ShieldedPoolUpgradeableReduced with production libraries linked. */
export async function getReducedPoolFactory(signer?: { address: string }) {
  const libraries = await deployUpgradeablePoolLibraries();
  const factory = await ethers.getContractFactory("ShieldedPoolUpgradeableReduced", { libraries });
  return signer ? factory.connect(signer) : factory;
}

export {
  assertCanonicalAddress,
  assertExpectedChainId,
  assertOffchainOraclePolicy,
  getNetworkAddresses,
  requireBnbUsdFeedForChain,
  resolveProductionOracleAndDex,
} from "./networkConfig";
