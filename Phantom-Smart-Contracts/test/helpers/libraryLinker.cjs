const { ethers } = require("hardhat");

let cachedAddress = null;
let cachedNetworkKey = null;

/**
 * Phase 7: ShieldedPool now delegates EIP-712 + signature verification work
 * into InternalMatchIntentLib. Tests and deploy scripts must deploy the
 * library once and pass its address to `getContractFactory` for ShieldedPool
 * (and any contract that inherits it). This helper deploys the library on
 * first use per network and returns a `libraries` object suitable for
 * Hardhat's `getContractFactory(name, { libraries })`.
 */
async function getShieldedPoolLibraries() {
  const network = await ethers.provider.getNetwork();
  const key = `${network.chainId.toString()}`;
  if (!cachedAddress || cachedNetworkKey !== key) {
    const Factory = await ethers.getContractFactory("InternalMatchIntentLib");
    const lib = await Factory.deploy();
    await lib.waitForDeployment();
    cachedAddress = await lib.getAddress();
    cachedNetworkKey = key;
  }
  return { InternalMatchIntentLib: cachedAddress };
}

async function getShieldedPoolFactory(name = "ShieldedPool") {
  const libraries = await getShieldedPoolLibraries();
  return ethers.getContractFactory(name, { libraries });
}

module.exports = { getShieldedPoolLibraries, getShieldedPoolFactory };
