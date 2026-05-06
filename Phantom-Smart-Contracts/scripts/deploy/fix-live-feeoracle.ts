import hre from "hardhat";

const { ethers } = hre;

const DEFAULT_BNB_USD_FEED_BSC_TESTNET = "0x1A26d803C2e796601794f8C5609549643832702C";

async function main() {
  const feeOracleAddr = String(process.env.FEE_ORACLE_ADDRESS || "").trim();
  const bnbUsdFeed = String(process.env.BNB_USD_FEED || DEFAULT_BNB_USD_FEED_BSC_TESTNET).trim();
  if (!feeOracleAddr || !ethers.isAddress(feeOracleAddr)) throw new Error("FEE_ORACLE_ADDRESS required");
  if (!ethers.isAddress(bnbUsdFeed)) throw new Error("BNB_USD_FEED invalid");

  const [owner] = await ethers.getSigners();
  const feeOracle = await ethers.getContractAt("FeeOracle", feeOracleAddr, owner);

  const Stub = await ethers.getContractFactory("FixedBnbUsdOffchainStub");
  const stub = await Stub.deploy();
  await stub.waitForDeployment();
  const stubAddr = await stub.getAddress();

  await (await feeOracle.setOffchainOracle(stubAddr)).wait();
  await (await feeOracle.setPriceFeed(ethers.ZeroAddress, bnbUsdFeed)).wait();

  const usd = await feeOracle.getUSDValue(ethers.ZeroAddress, ethers.parseEther("0.01"));
  console.log("feeOracle:", feeOracleAddr);
  console.log("offchainStub:", stubAddr);
  console.log("usd(0.01 BNB):", usd.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
