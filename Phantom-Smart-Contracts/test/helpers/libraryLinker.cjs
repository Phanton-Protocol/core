const { ethers } = require("hardhat");

const JOIN_SPLIT_FEE_LIB_FQN =
  "contracts/_full/libraries/JoinSplitFeeValidation.sol:JoinSplitFeeValidation";
const MEV_COMMIT_LIB_FQN = "contracts/_full/libraries/MevCommitReveal.sol:MevCommitReveal";

let cachedIntentLib = null;
let cachedJoinSplitFeeLib = null;
let cachedNetworkKey = null;

async function networkKey() {
  const network = await ethers.provider.getNetwork();
  return network.chainId.toString();
}

/**
 * Phase 7: ShieldedPool delegates EIP-712 work to InternalMatchIntentLib.
 * Upgradeable pools link JoinSplitFeeValidation for bytecode-sized fee gates.
 */
async function getShieldedPoolLibraries() {
  const key = await networkKey();
  if (!cachedIntentLib || cachedNetworkKey !== key) {
    const Factory = await ethers.getContractFactory("InternalMatchIntentLib");
    const lib = await Factory.deploy();
    await lib.waitForDeployment();
    cachedIntentLib = await lib.getAddress();
    cachedJoinSplitFeeLib = null;
    cachedNetworkKey = key;
  }
  return { InternalMatchIntentLib: cachedIntentLib };
}

async function getJoinSplitFeeValidationLibraries() {
  const key = await networkKey();
  if (!cachedJoinSplitFeeLib || cachedNetworkKey !== key) {
    const Factory = await ethers.getContractFactory(JOIN_SPLIT_FEE_LIB_FQN);
    const lib = await Factory.deploy();
    await lib.waitForDeployment();
    cachedJoinSplitFeeLib = await lib.getAddress();
    cachedNetworkKey = key;
  }
  return { JoinSplitFeeValidation: cachedJoinSplitFeeLib };
}

let cachedMevLib = null;
async function getMevCommitRevealLibraries() {
  const key = await networkKey();
  if (!cachedMevLib || cachedNetworkKey !== key) {
    const Factory = await ethers.getContractFactory(MEV_COMMIT_LIB_FQN);
    const lib = await Factory.deploy();
    await lib.waitForDeployment();
    cachedMevLib = await lib.getAddress();
    cachedNetworkKey = key;
  }
  return { MevCommitReveal: cachedMevLib };
}

async function getUpgradeablePoolLibraries(fqn) {
  const libs = { ...(await getJoinSplitFeeValidationLibraries()) };
  if (fqn.includes("ShieldedPoolUpgradeableReduced")) {
    Object.assign(libs, await getMevCommitRevealLibraries());
  }
  return libs;
}

async function getShieldedPoolFactory(name = "ShieldedPool") {
  const libraries = await getShieldedPoolLibraries();
  return ethers.getContractFactory(name, { libraries });
}

async function getUpgradeablePoolFactory(fqn) {
  const libraries = await getUpgradeablePoolLibraries(fqn);
  return ethers.getContractFactory(fqn, { libraries });
}

module.exports = {
  getShieldedPoolLibraries,
  getJoinSplitFeeValidationLibraries,
  getUpgradeablePoolLibraries,
  getShieldedPoolFactory,
  getUpgradeablePoolFactory,
};
