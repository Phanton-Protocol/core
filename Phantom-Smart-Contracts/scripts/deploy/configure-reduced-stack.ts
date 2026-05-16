import hre from "hardhat";
import {
  assertExpectedChainId,
  assertChainalysisOracleDeployed,
  assertProductionNetworkBinding,
  requireBnbUsdFeedForChain,
  requireGovernanceTimelockAddress,
} from "./networkConfig";
import { getDeployProfile } from "./deployInfrastructure";

const { ethers, network } = hre;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployProfile = getDeployProfile();
  assertProductionNetworkBinding(chainId, deployProfile);
  const expectedChainId = String(process.env.EXPECTED_CHAIN_ID || "").trim();
  if (expectedChainId) {
    assertExpectedChainId(chainId, Number(expectedChainId));
  }
  requireBnbUsdFeedForChain(chainId);
  const timelockAddr = requireGovernanceTimelockAddress();
  console.log("[configure-reduced-stack] network:", network.name, "chainId:", chainId);

  const poolAddr = String(process.env.REDUCED_POOL_ADDRESS || "").trim();
  const feeOracleAddr = String(process.env.REDUCED_FEE_ORACLE_ADDRESS || "").trim();
  const relayerRegistryAddr = String(process.env.REDUCED_RELAYER_REGISTRY_ADDRESS || "").trim();
  const verifierAddr = String(process.env.REDUCED_VERIFIER_ADDRESS || "").trim();
  const swapAdaptorAddr = String(process.env.REDUCED_SWAP_ADAPTOR_ADDRESS || "").trim();
  const busdAddr = String(process.env.BUSD_ADDRESS || "").trim();
  const usdtAddr = String(process.env.USDT_ADDRESS || "").trim();

  if (!poolAddr || !feeOracleAddr || !relayerRegistryAddr || !verifierAddr || !swapAdaptorAddr || !busdAddr || !usdtAddr) {
    throw new Error("Missing required env for reduced stack config");
  }

  const pool = await ethers.getContractAt("ShieldedPoolUpgradeableReduced", poolAddr);
  const feeOracle = await ethers.getContractAt("FeeOracle", feeOracleAddr);

  const chainalysisOracle = String(process.env.CHAINALYSIS_ORACLE_ADDRESS || "").trim();
  if (deployProfile === "production" && chainalysisOracle) {
    await assertChainalysisOracleDeployed(chainalysisOracle, ethers.provider);
  }

  const complianceAddr = String(process.env.COMPLIANCE_MODULE_ADDRESS || "").trim();
  if (complianceAddr && chainalysisOracle) {
    const cmPre = await ethers.getContractAt("ComplianceModule", complianceAddr);
    await assertChainalysisOracleDeployed(chainalysisOracle, ethers.provider);
    const cfg = await cmPre.config();
    const curOracle = cfg.chainalysisOracle ?? cfg[3];
    if (!curOracle || curOracle === ethers.ZeroAddress) {
      await (await cmPre.setChainalysisOracle(chainalysisOracle)).wait();
      console.log("[configure-reduced-stack] ComplianceModule oracle set (bootstrap)");
    }
  }

  if (!(await feeOracle.timelock())) {
    await (await feeOracle.initializeTimelock(timelockAddr)).wait();
    console.log("[configure-reduced-stack] FeeOracle timelock:", timelockAddr);
  }

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(poolAddr, feeOracleAddr, relayerRegistryAddr);
  await depositHandler.waitForDeployment();

  const SwapHandler = await ethers.getContractFactory("SwapHandler");
  const swapHandler = await SwapHandler.deploy(poolAddr, verifierAddr, verifierAddr, swapAdaptorAddr, feeOracleAddr, relayerRegistryAddr);
  await swapHandler.waitForDeployment();

  const WithdrawHandler = await ethers.getContractFactory("WithdrawHandler");
  const withdrawHandler = await WithdrawHandler.deploy(poolAddr, verifierAddr, verifierAddr, feeOracleAddr, relayerRegistryAddr);
  await withdrawHandler.waitForDeployment();

  await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();
  // Path-B Reduced pool executes join-split inline; SwapHandler is not wired on Reduced.
  await (await pool.setWithdrawHandler(await withdrawHandler.getAddress())).wait();
  // swapAdaptor is set in pool.initialize(); post-bootstrap changes require UUPS upgrade via timelock.

  const [deployer] = await ethers.getSigners();
  const probe = 10n ** 18n;
  for (const tokenAddr of [busdAddr, usdtAddr]) {
    const erc20 = await ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
      tokenAddr
    );
    await (await erc20.approve(poolAddr, probe)).wait();
  }
  await (await pool.connect(deployer).registerAsset(1, busdAddr)).wait();
  await (await pool.connect(deployer).registerAsset(2, usdtAddr)).wait();

  const relayerStaking = await ethers.getContractAt("RelayerStaking", relayerRegistryAddr);
  await (await relayerStaking.setFeeDistributor(poolAddr, true)).wait();

  console.log("pool:", poolAddr);
  console.log("depositHandler:", await depositHandler.getAddress());
  console.log("swapHandler:", await swapHandler.getAddress());
  console.log("withdrawHandler:", await withdrawHandler.getAddress());

  if (complianceAddr) {
    const cm = await ethers.getContractAt("ComplianceModule", complianceAddr);
    if (!(await cm.timelock())) {
      await (await cm.initializeTimelock(timelockAddr)).wait();
      console.log("[configure-reduced-stack] ComplianceModule timelock:", timelockAddr);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
