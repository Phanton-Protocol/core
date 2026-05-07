import hre from "hardhat";

const { ethers } = hre;

const DEFAULT_BNB_USD_FEED_BSC_TESTNET = "0x1A26d803C2e796601794f8C5609549643832702C";

async function main() {
  const poolAddr = String(process.env.SHIELDED_POOL_ADDRESS || "").trim() || "0x77C4BadA4306e4b258980f0f0D79Aec814509FDf";
  const bnbUsdFeed = String(process.env.BNB_USD_FEED || DEFAULT_BNB_USD_FEED_BSC_TESTNET).trim();
  if (!ethers.isAddress(poolAddr)) throw new Error("Invalid SHIELDED_POOL_ADDRESS");
  if (!ethers.isAddress(bnbUsdFeed)) throw new Error("Invalid BNB_USD_FEED");

  const [owner] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ShieldedPoolUpgradeableReduced", poolAddr, owner);
  const currentOwner = await pool.owner();
  if (currentOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`Signer ${owner.address} is not pool owner ${currentOwner}`);
  }

  const FeeOracle = await ethers.getContractFactory("FeeOracle", owner);
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  const feeOracleAddr = await feeOracle.getAddress();

  const Stub = await ethers.getContractFactory("FixedBnbUsdOffchainStub", owner);
  const stub = await Stub.deploy();
  await stub.waitForDeployment();
  const stubAddr = await stub.getAddress();

  await (await feeOracle.setOffchainOracle(stubAddr)).wait();
  await (await feeOracle.setPriceFeed(ethers.ZeroAddress, bnbUsdFeed)).wait();

  const usd01 = await feeOracle.getUSDValue(ethers.ZeroAddress, ethers.parseEther("0.01"));
  const fee02 = await feeOracle.calculateFee(ethers.ZeroAddress, ethers.parseEther("0.02"));
  const fee03 = await feeOracle.calculateFee(ethers.ZeroAddress, ethers.parseEther("0.03"));

  const oldFeeOracle = await pool.feeOracle();
  console.log("poolAddr:", poolAddr);
  console.log("signer:", owner.address);
  console.log("pool.owner:", await pool.owner());
  console.log("oldFeeOracle(check):", oldFeeOracle);
  try {
    await pool.setFeeOracle.staticCall(feeOracleAddr);
    console.log("staticCall setFeeOracle: ok");
  } catch (e: any) {
    console.log("staticCall setFeeOracle failed:", e?.shortMessage || e?.message || e);
    throw e;
  }
  const tx = await pool.setFeeOracle(feeOracleAddr);
  console.log("setFeeOracle tx:", tx.hash);
  await tx.wait();

  console.log("pool:", poolAddr);
  console.log("oldFeeOracle:", oldFeeOracle);
  console.log("newFeeOracle:", feeOracleAddr);
  console.log("offchainStub:", stubAddr);
  console.log("usd(0.01BNB):", usd01.toString());
  console.log("fee(0.02BNB):", fee02.toString());
  console.log("fee(0.03BNB):", fee03.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
