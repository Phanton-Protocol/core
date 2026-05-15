import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import { deployVerifiersAndSwapAdaptor } from "./deployInfrastructure";
import { deployCoreGovernance } from "./deployGovernance";
import { getReducedPoolFactory } from "./joinSplitFeeValidationLink";

const { ethers, network } = hre;

type DeployRecord = {
  network: string;
  chainId: number;
  deployer: string;
  deployedAt: string;
  note: string;
  contracts: Record<string, string>;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const walletA = ethers.getAddress(String(process.env.WALLET_A_ADDRESS || "").trim());
  const walletB = ethers.getAddress(String(process.env.WALLET_B_ADDRESS || "").trim());
  const walletBPrivateKey = String(process.env.WALLET_B_PRIVATE_KEY || "").trim();
  const stakeAmountHuman = String(process.env.STAKE_AMOUNT_SHDW || "1000").trim();
  const transferAmountHuman = String(process.env.TRANSFER_AMOUNT_SHDW || "10000").trim();
  const existingOffchainOracle = String(process.env.EXISTING_OFFCHAIN_ORACLE || "").trim();
  const bnbUsdFeed = String(process.env.BNB_USD_FEED || "").trim();

  if (!walletBPrivateKey) {
    throw new Error("WALLET_B_PRIVATE_KEY is required");
  }

  console.log("[path-b] network:", network.name, "chainId:", chainId);
  console.log("[path-b] deployer:", deployer.address);
  console.log("[path-b] DEPLOY_PROFILE:", process.env.DEPLOY_PROFILE || "dev");

  const ProtocolToken = await ethers.getContractFactory("ProtocolToken");
  const protocolToken = await ProtocolToken.deploy(deployer.address);
  console.log("[path-b][tx] ProtocolToken.deploy:", protocolToken.deploymentTransaction()?.hash);
  await protocolToken.waitForDeployment();
  const protocolTokenAddr = await protocolToken.getAddress();
  console.log("[path-b] ProtocolToken:", protocolTokenAddr);

  const govOwner = String(process.env.GOVERNANCE_OWNER || "").trim() || deployer.address;
  const { address: governanceAddr, deployTx: govDeployTx } = await deployCoreGovernance(deployer, {
    tokenAddress: protocolTokenAddr,
    ownerAddress: govOwner,
  });
  if (govDeployTx) {
    console.log("[path-b][tx] Governance.deploy:", govDeployTx.hash);
  }
  console.log("[path-b] Governance (core):", governanceAddr);
  console.log(
    "[path-b] governance ops: after a proposal passes voting, queue(id) then wait EXECUTION_DELAY (2 days on-chain) then execute(id) — see DEPLOY.md"
  );

  const minStake = ethers.parseUnits("1000", 18);
  const RelayerStaking = await ethers.getContractFactory("RelayerStaking");
  const relayerStaking = await RelayerStaking.deploy(protocolTokenAddr, minStake);
  console.log("[path-b][tx] RelayerStaking.deploy:", relayerStaking.deploymentTransaction()?.hash);
  await relayerStaking.waitForDeployment();
  const relayerStakingAddr = await relayerStaking.getAddress();
  console.log("[path-b] RelayerStaking:", relayerStakingAddr);

  const infra = await deployVerifiersAndSwapAdaptor();
  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  console.log("[path-b][tx] FeeOracle.deploy:", feeOracle.deploymentTransaction()?.hash);
  await feeOracle.waitForDeployment();
  const feeOracleAddr = await feeOracle.getAddress();
  console.log("[path-b] FeeOracle:", feeOracleAddr);

  if (existingOffchainOracle) {
    const tx = await feeOracle.setOffchainOracle(existingOffchainOracle);
    console.log("[path-b][tx] FeeOracle.setOffchainOracle:", tx.hash);
    await tx.wait();
    console.log("[path-b] FeeOracle.offchainOracle set:", existingOffchainOracle);
  }
  if (bnbUsdFeed) {
    const tx = await feeOracle.setPriceFeed(ethers.ZeroAddress, bnbUsdFeed);
    await tx.wait();
    console.log("[path-b] FeeOracle BNB/USD feed set:", bnbUsdFeed);
  }

  const ReducedPool = await getReducedPoolFactory(deployer);
  const pool = await ReducedPool.deploy();
  console.log("[path-b][tx] ShieldedPoolUpgradeableReduced.deploy:", pool.deploymentTransaction()?.hash);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("[path-b] ShieldedPoolUpgradeableReduced:", poolAddr);

  const initTx = await pool.initialize(
    infra.joinSplit,
    infra.threshold,
    infra.swapAdaptor,
    feeOracleAddr,
    relayerStakingAddr
  );
  console.log("[path-b][tx] ShieldedPool.initialize:", initTx.hash);
  await initTx.wait();
  console.log("[path-b] pool initialized");

  const transferAmount = ethers.parseUnits(transferAmountHuman, 18);
  const transferATx = await protocolToken.transfer(walletA, transferAmount);
  console.log("[path-b][tx] ProtocolToken.transfer(walletA):", transferATx.hash);
  await transferATx.wait();
  const transferBTx = await protocolToken.transfer(walletB, transferAmount);
  console.log("[path-b][tx] ProtocolToken.transfer(walletB):", transferBTx.hash);
  await transferBTx.wait();
  console.log(`[path-b] transferred ${transferAmountHuman} SHDW to wallet A and B`);

  const provider = ethers.provider;
  const walletBSigner = new ethers.Wallet(walletBPrivateKey, provider);
  const tokenAsB = protocolToken.connect(walletBSigner);
  const stakingAsB = relayerStaking.connect(walletBSigner);
  const stakeAmount = ethers.parseUnits(stakeAmountHuman, 18);
  const approveTx = await tokenAsB.approve(relayerStakingAddr, ethers.MaxUint256);
  console.log("[path-b][tx] ProtocolToken.approve(staking):", approveTx.hash);
  await approveTx.wait();
  const stakeTx = await stakingAsB.stake(stakeAmount);
  console.log("[path-b][tx] RelayerStaking.stake:", stakeTx.hash);
  await stakeTx.wait();
  const isRelayer = await relayerStaking.isRelayer(walletB);
  const stakedBalance = await relayerStaking.stakedBalance(walletB);
  console.log("[path-b] wallet B staked:", ethers.formatUnits(stakedBalance, 18));
  console.log("[path-b] wallet B isRelayer:", isRelayer);
  if (!isRelayer) {
    throw new Error("wallet B is not relayer after staking");
  }

  const record: DeployRecord = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    note: "Path-B production: ShieldedPoolUpgradeableReduced + SHDW + RelayerStaking (ERC20 allowlist probe at registerAsset)",
    contracts: {
      protocolToken: protocolTokenAddr,
      governance: governanceAddr,
      relayerStaking: relayerStakingAddr,
      joinSplitVerifier: infra.joinSplit,
      portfolioVerifier: infra.portfolio,
      thresholdVerifier: infra.threshold,
      swapAdaptor: infra.swapAdaptor,
      ...(infra.groth16Verifier ? { groth16Verifier: infra.groth16Verifier } : {}),
      feeOracle: feeOracleAddr,
      shieldedPool: poolAddr,
    },
  };

  const outDir = path.join(process.cwd(), "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `pathb-reduced-${network.name}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log("[path-b] wrote deployment record:", outFile);
}

main().catch((err) => {
  console.error("[path-b] failed:", err);
  process.exit(1);
});

