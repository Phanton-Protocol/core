/**
 * @title Deploy OffchainPriceOracle + wire to existing FeeOracle
 * @dev Required env: ORACLE_SIGNER, FEE_ORACLE_ADDRESS
 */
const hre = require("hardhat");

async function main() {
  const signer = process.env.ORACLE_SIGNER;
  const feeOracleAddress = process.env.FEE_ORACLE_ADDRESS;
  if (!signer || !feeOracleAddress) {
    throw new Error("Missing env ORACLE_SIGNER or FEE_ORACLE_ADDRESS");
  }

  console.log("Deploying OffchainPriceOracle...");
  const OffchainPriceOracle = await hre.ethers.getContractFactory("OffchainPriceOracle");
  const offchainOracle = await OffchainPriceOracle.deploy(signer);
  await offchainOracle.waitForDeployment();
  console.log("OffchainPriceOracle:", await offchainOracle.getAddress());

  console.log("Wiring FeeOracle -> OffchainPriceOracle...");
  const feeOracle = await hre.ethers.getContractAt("FeeOracle", feeOracleAddress);
  const tx = await feeOracle.setOffchainOracle(await offchainOracle.getAddress());
  await tx.wait();
  console.log("setOffchainOracle tx:", tx.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
