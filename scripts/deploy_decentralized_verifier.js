const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deploying DecentralizedVerifier with:", deployerAddress);

  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB");

  // Required addresses from environment
  const stakingAddress = process.env.RELAYER_STAKING_ADDRESS;
  const protocolTokenAddress = process.env.PROTOCOL_TOKEN_ADDRESS;

  if (!stakingAddress || !protocolTokenAddress) {
    throw new Error("Missing env: RELAYER_STAKING_ADDRESS, PROTOCOL_TOKEN_ADDRESS");
  }

  // Voting parameters (configurable)
  const votingPeriod = process.env.VOTING_PERIOD || 900; // 15 minutes
  const quorumBps = process.env.QUORUM_BPS || 6600; // 66%
  const slashBps = process.env.SLASH_BPS || 1000; // 10%

  console.log("\nDeployment Config:");
  console.log("Staking Contract:", stakingAddress);
  console.log("Protocol Token:", protocolTokenAddress);
  console.log("Voting Period:", votingPeriod, "seconds");
  console.log("Quorum:", (quorumBps / 100).toFixed(2), "%");
  console.log("Slash Penalty:", (slashBps / 100).toFixed(2), "%");

  // Deploy DecentralizedVerifier
  const DecentralizedVerifier = await hre.ethers.getContractFactory("DecentralizedVerifier");
  const verifier = await DecentralizedVerifier.deploy(
    stakingAddress,
    protocolTokenAddress,
    votingPeriod,
    quorumBps,
    slashBps
  );
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();

  console.log("\n✅ Deployment Complete!");
  console.log("DecentralizedVerifier:", verifierAddress);

  console.log("\n📋 Next Steps:");
  console.log("1. Authorize slashing:");
  console.log(`   RelayerStaking.setSlasher("${verifierAddress}", true)`);
  console.log("\n2. (Optional) Replace Groth16Verifier in ShieldedPool:");
  console.log(`   ShieldedPool.setVerifier("${verifierAddress}")`);
  console.log("\n3. Stakers: Run verification nodes to participate");
  console.log("   See docs/STAKER_VERIFICATION.md for details");

  // Auto-authorize slashing if PRIVATE_KEY is the owner
  console.log("\n⏳ Auto-authorizing slashing...");
  try {
    const RelayerStaking = await hre.ethers.getContractFactory("RelayerStaking");
    const staking = RelayerStaking.attach(stakingAddress);
    
    const tx = await staking.setSlasher(verifierAddress, true);
    await tx.wait();
    console.log("✅ Slashing authorized!");
  } catch (err) {
    console.log("⚠️  Could not auto-authorize (you may not be owner):", err.message);
    console.log("   Run manually: RelayerStaking.setSlasher(...)");
  }

  console.log("\n🎉 Setup Complete!");
  console.log(`\nAdd to .env or config.json:\nDECENTRALIZED_VERIFIER_ADDRESS=${verifierAddress}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
