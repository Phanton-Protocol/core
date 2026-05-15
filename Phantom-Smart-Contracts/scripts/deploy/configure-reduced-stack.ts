import hre from "hardhat";

const { ethers } = hre;

async function main() {
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
  await (await pool.setSwapHandler(await swapHandler.getAddress())).wait();
  await (await pool.setWithdrawHandler(await withdrawHandler.getAddress())).wait();
  await (await pool.setSwapAdaptor(swapAdaptorAddr)).wait();

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

  console.log("pool:", poolAddr);
  console.log("depositHandler:", await depositHandler.getAddress());
  console.log("swapHandler:", await swapHandler.getAddress());
  console.log("withdrawHandler:", await withdrawHandler.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
