/**
 * Test-only helper that wraps an upgradeable implementation behind an
 * ERC1967Proxy and returns a typed instance pointing at the proxy address.
 *
 * Required after Module 1 audit fix: implementations now call
 * `_disableInitializers()` in their constructor, so the legacy pattern of
 * deploying the impl and calling `initialize` directly is intentionally
 * blocked (prevents impl-takeover attacks).
 */
const { ethers } = require("hardhat");
const { getUpgradeablePoolFactory, getShieldedPoolLibraries } = require("./libraryLinker.cjs");

const PROXY_FQN = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

/**
 * @param {string} fqn  Fully-qualified contract name (e.g. "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced")
 * @param {Array<any>} initArgs Arguments forwarded to `initialize(...)`.
 * @param {Object} [opts]
 * @param {string} [opts.initFn="initialize"] Name of the initializer function.
 */
async function deployBehindProxy(fqn, initArgs, opts = {}) {
  const initFn = opts.initFn || "initialize";

  const Impl = await getUpgradeablePoolFactory(fqn);
  // M3: ShieldedPoolUpgradeableReduced now takes the InternalMatchIntentLib
  // address as a constructor parameter (immutable in impl bytecode). Other
  // upgradeable contracts still use a parameterless constructor.
  let impl;
  if (fqn.includes("ShieldedPoolUpgradeableReduced")) {
    const { InternalMatchIntentLib: imlAddr } = await getShieldedPoolLibraries();
    impl = await Impl.deploy(imlAddr);
  } else {
    impl = await Impl.deploy();
  }
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData(initFn, initArgs);

  const Proxy = await ethers.getContractFactory(PROXY_FQN);
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  const attached = Impl.attach(await proxy.getAddress());

  if (fqn.includes("ShieldedPoolUpgradeableReduced")) {
    const { wirePoolFeeDistributor } = require("./reducedProduction.cjs");
    const [owner] = await ethers.getSigners();
    await wirePoolFeeDistributor(attached, owner);
  }

  return attached;
}

module.exports = { deployBehindProxy };
