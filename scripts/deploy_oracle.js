/**
 * @title Offchain Oracle Deployment Script (Testnet/Mainnet)
 * @notice Deploys OffchainPriceOracle + FeeOracle and wires them together
 * @dev Run with: npx hardhat run scripts/deploy_oracle.js --network bscTestnet
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  console.log("Deploying with:", deployerAddress);
  console.log("Balance:", balance.toString());

  const signer = process.env.ORACLE_SIGNER;
  if (!signer) {
    throw new Error("Missing env ORACLE_SIGNER");
  }

  console.log("\n1) Deploying OffchainPriceOracle...");
  const OffchainPriceOracle = await hre.ethers.getContractFactory("OffchainPriceOracle");
  const offchainOracle = await OffchainPriceOracle.deploy(signer);
  await offchainOracle.waitForDeployment();
  console.log("OffchainPriceOracle:", await offchainOracle.getAddress());

  console.log("\n2) Deploying FeeOracle...");
  const FeeOracle = await hre.ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  console.log("FeeOracle:", await feeOracle.getAddress());

  console.log("\n3) Wiring FeeOracle -> OffchainPriceOracle...");
  const tx = await feeOracle.setOffchainOracle(await offchainOracle.getAddress());
  await tx.wait();
  console.log("setOffchainOracle tx:", tx.hash);

  console.log("\nDone.");
  console.log("OffchainPriceOracle:", await offchainOracle.getAddress());
  console.log("FeeOracle:", await feeOracle.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
