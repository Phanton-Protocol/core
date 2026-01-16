/**
 * @title Deploy ShieldedPool (reuse existing contracts)
 * @dev Required env:
 * VERIFIER_ADDRESS, SWAP_ADAPTOR_ADDRESS, FEE_ORACLE_ADDRESS, RELAYER_REGISTRY_ADDRESS
 */

const hre = require("hardhat");

async function main() {
  const verifier = process.env.VERIFIER_ADDRESS;
  const swapAdaptor = process.env.SWAP_ADAPTOR_ADDRESS;
  const feeOracle = process.env.FEE_ORACLE_ADDRESS;
  const relayerRegistry = process.env.RELAYER_REGISTRY_ADDRESS;

  if (!verifier || !swapAdaptor || !feeOracle || !relayerRegistry) {
    throw new Error("Missing env: VERIFIER_ADDRESS, SWAP_ADAPTOR_ADDRESS, FEE_ORACLE_ADDRESS, RELAYER_REGISTRY_ADDRESS");
  }

  const ShieldedPool = await hre.ethers.getContractFactory("ShieldedPool");
  const pool = await ShieldedPool.deploy(
    verifier,
    swapAdaptor,
    feeOracle,
    relayerRegistry
  );
  await pool.waitForDeployment();
  console.log("ShieldedPool:", await pool.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
