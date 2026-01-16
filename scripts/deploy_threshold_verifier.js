const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deploying ThresholdVerifier with:", deployerAddress);

  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB");

  // Required addresses from environment
  const stakingAddress = process.env.RELAYER_STAKING_ADDRESS;
  
  if (!stakingAddress) {
    throw new Error("Missing env: RELAYER_STAKING_ADDRESS");
  }

  // Threshold (default 66%)
  const thresholdBps = process.env.THRESHOLD_BPS || 6600;

  console.log("\nDeployment Config:");
  console.log("Staking Contract:", stakingAddress);
  console.log("Threshold:", (thresholdBps / 100).toFixed(2), "%");

  // Deploy ThresholdVerifier
  const ThresholdVerifier = await hre.ethers.getContractFactory("ThresholdVerifier");
  const verifier = await ThresholdVerifier.deploy(
    stakingAddress,
    thresholdBps
  );
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();

  console.log("\n✅ Deployment Complete!");
  console.log("ThresholdVerifier:", verifierAddress);

  console.log("\n📋 Next Steps:");
  console.log("\n1. Stakers: Run validator servers");
  console.log("   cd backend && node src/validatorServer.js");
  console.log("\n2. Configure relayer with validator URLs:");
  console.log(`   validators: ["http://validator1:6000", "http://validator2:6000", ...]`);
  console.log("\n3. (Optional) Replace verifier in ShieldedPool:");
  console.log(`   ShieldedPool.setVerifier("${verifierAddress}")`);

  console.log("\n🎉 Setup Complete!");
  console.log(`\nAdd to .env or config.json:\nTHRESHOLD_VERIFIER_ADDRESS=${verifierAddress}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
