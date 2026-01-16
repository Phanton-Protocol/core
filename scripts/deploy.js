/**
 * @title Shadow-DeFi Protocol Deployment Script
 * @notice Deploys all contracts in the correct order
 * @dev Run with: npx hardhat run scripts/deploy.js --network bsc
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await hre.ethers.provider.getBalance(deployerAddress);
  console.log("Deploying contracts with account:", deployerAddress);
  console.log("Account balance:", balance.toString());

  // ============ Step 1: Deploy ProtocolToken ============
  console.log("\n1. Deploying ProtocolToken...");
  const ProtocolToken = await hre.ethers.getContractFactory("ProtocolToken");
  const protocolToken = await ProtocolToken.deploy(deployerAddress);
  await protocolToken.waitForDeployment();
  console.log("ProtocolToken deployed to:", await protocolToken.getAddress());

  // ============ Step 2: Deploy RelayerStaking ============
  console.log("\n2. Deploying RelayerStaking...");
  const RelayerStaking = await hre.ethers.getContractFactory("RelayerStaking");
  const minStake = hre.ethers.parseUnits("1000", 18);
  const relayerRegistry = await RelayerStaking.deploy(await protocolToken.getAddress(), minStake);
  await relayerRegistry.waitForDeployment();
  console.log("RelayerStaking deployed to:", await relayerRegistry.getAddress());

  // ============ Step 3: Deploy or Use FeeOracle ============
  let feeOracle;
  const feeOracleAddress = process.env.FEE_ORACLE_ADDRESS;
  if (feeOracleAddress) {
    console.log("\n3. Using existing FeeOracle...");
    feeOracle = await hre.ethers.getContractAt("FeeOracle", feeOracleAddress);
    console.log("FeeOracle:", feeOracleAddress);
  } else {
    console.log("\n3. Deploying FeeOracle...");
    const FeeOracle = await hre.ethers.getContractFactory("FeeOracle");
    feeOracle = await FeeOracle.deploy();
    await feeOracle.waitForDeployment();
    console.log("FeeOracle deployed to:", await feeOracle.getAddress());
  }

  // Configure price feeds (example addresses - replace with actual Chainlink feeds)
  // await feeOracle.setPriceFeed(ethers.constants.AddressZero, "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"); // BNB/USD
  // await feeOracle.setPriceFeed("0x55d398326f99059fF775485246999027B3197955", "0xB97Ad0E74fa7d920791E90258A6E2085088b4320"); // USDT/USD

  // ============ Step 4: Deploy PancakeSwapAdaptor ============
  console.log("\n4. Deploying PancakeSwapAdaptor...");
  const PancakeSwapAdaptor = await hre.ethers.getContractFactory("PancakeSwapAdaptor");
  const router = hre.network.name === "bscTestnet"
    ? "0x9ac64cc6e4415144c455bd8e4837fea55603e5c3"
    : "0x10ed43c718714eb63d5aa57b78b54704e256024e";
  const wbnb = hre.network.name === "bscTestnet"
    ? "0xae13d989dac2f0debff460ac112a837c89baa7cd"
    : "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const swapAdaptor = await PancakeSwapAdaptor.deploy(router, wbnb);
  await swapAdaptor.waitForDeployment();
  console.log("PancakeSwapAdaptor deployed to:", await swapAdaptor.getAddress());

  // ============ Step 5: Deploy Verifier ============
  console.log("\n5. Deploying Verifier...");
  const Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  const groth16 = await Verifier.deploy();
  await groth16.waitForDeployment();
  console.log("Groth16Verifier deployed to:", await groth16.getAddress());

  const VerifierAdapter = await hre.ethers.getContractFactory("Groth16VerifierAdapter");
  const verifier = await VerifierAdapter.deploy(await groth16.getAddress());
  await verifier.waitForDeployment();
  console.log("VerifierAdapter deployed to:", await verifier.getAddress());

  // ============ Step 6: Deploy ShieldedPool ============
  console.log("\n6. Deploying ShieldedPool...");
  const ShieldedPool = await hre.ethers.getContractFactory("ShieldedPool");
  const shieldedPool = await ShieldedPool.deploy(
    await verifier.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await shieldedPool.waitForDeployment();
  console.log("ShieldedPool deployed to:", await shieldedPool.getAddress());

  // ============ Step 7: Register Initial Relayers ============
  console.log("\n7. Registering relayers...");
  // Stake deployer as first relayer
  const approveTx = await protocolToken.approve(await relayerRegistry.getAddress(), minStake);
  await approveTx.wait();
  const stakeTx = await relayerRegistry.stake(minStake);
  await stakeTx.wait();
  console.log("Staked relayer:", deployer.address);

  // ============ Step 8: Deploy Governance ============
  console.log("\n8. Deploying Governance...");
  const Governance = await hre.ethers.getContractFactory("Governance");
  const votingPeriod = 600; // blocks
  const quorum = hre.ethers.parseUnits("10000000", 18);
  const governance = await Governance.deploy(await protocolToken.getAddress(), votingPeriod, quorum);
  await governance.waitForDeployment();
  console.log("Governance deployed to:", await governance.getAddress());

  // ============ Summary ============
  console.log("\n============ DEPLOYMENT SUMMARY ============");
  console.log("ProtocolToken:", await protocolToken.getAddress());
  console.log("RelayerStaking:", await relayerRegistry.getAddress());
  console.log("FeeOracle:", await feeOracle.getAddress());
  console.log("PancakeSwapAdaptor:", await swapAdaptor.getAddress());
  console.log("Groth16Verifier:", await groth16.getAddress());
  console.log("VerifierAdapter:", await verifier.getAddress());
  console.log("ShieldedPool:", await shieldedPool.getAddress());
  console.log("Governance:", await governance.getAddress());
  console.log("===========================================\n");

  // Save deployment addresses
  const deploymentInfo = {
    network: hre.network.name,
    deployer: deployer.address,
    contracts: {
      ProtocolToken: await protocolToken.getAddress(),
      RelayerStaking: await relayerRegistry.getAddress(),
      FeeOracle: await feeOracle.getAddress(),
      PancakeSwapAdaptor: await swapAdaptor.getAddress(),
      Groth16Verifier: await groth16.getAddress(),
      VerifierAdapter: await verifier.getAddress(),
      ShieldedPool: await shieldedPool.getAddress(),
      Governance: await governance.getAddress(),
    },
    timestamp: new Date().toISOString(),
  };

  console.log("Deployment info:", JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
