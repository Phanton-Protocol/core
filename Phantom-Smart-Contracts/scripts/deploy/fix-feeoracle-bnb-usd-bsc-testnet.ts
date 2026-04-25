/**
 * Repair FeeOracle on BSC testnet for native-BNB USD valuation used by deposit relay fees.
 *
 * Problems seen in production:
 * - `setOffchainOracle(address(0))` is **disallowed** by FeeOracle ("FeeOracle: zero address").
 * - A stale third-party offchain oracle makes `getUSDValue` revert or mis-price.
 * - `priceFeeds[address(0)]` defaults to a **mainnet** BNB/USD aggregator in FeeOracle's constructor.
 *
 * This script (FeeOracle owner):
 * 1) Deploys `FixedBnbUsdOffchainStub` (always-fresh `updatedAt = block.timestamp`).
 * 2) `setOffchainOracle(stub)` so off-chain pricing path is sane on testnet.
 * 3) `setPriceFeed(address(0), BNB_USD_FEED)` to a working BNB/USD adapter on Chapel (Chainlink-compatible).
 *
 * Usage (from `Phantom-Smart-Contracts/` with HH_FULL=1):
 *   HH_FULL=1 DEPLOYER_PRIVATE_KEY=... \\
 *     npx hardhat run scripts/deploy/fix-feeoracle-bnb-usd-bsc-testnet.ts --network bscTestnet
 *
 * Optional:
 *   BNB_USD_FEED=0x1A26d803C2e796601794f8C5609549643832702C   (default: Binance Oracle BNB/USD on testnet)
 */
import hre from "hardhat";
import { loadDeployment } from "./deploymentRecord";

const { ethers, network } = hre;

const DEFAULT_BNB_USD_FEED_BSC_TESTNET = "0x1A26d803C2e796601794f8C5609549643832702C";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer — set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY for bscTestnet");
  }
  const dep = loadDeployment(network.name);
  const feeOracleAddr = dep.contracts.feeOracle;
  if (!feeOracleAddr) {
    throw new Error(`deployments/${network.name}.json missing contracts.feeOracle`);
  }

  const bnbUsdFeed = String(process.env.BNB_USD_FEED || DEFAULT_BNB_USD_FEED_BSC_TESTNET).trim();
  if (!ethers.isAddress(bnbUsdFeed)) {
    throw new Error("Invalid BNB_USD_FEED");
  }

  const feeOracle = await ethers.getContractAt("FeeOracle", feeOracleAddr);
  const owner = await feeOracle.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.address} is not FeeOracle owner ${owner}`);
  }

  const offchainBefore = await feeOracle.offchainOracle();
  const feedBefore = await feeOracle.priceFeeds(ethers.ZeroAddress);

  console.log("[fix-feeoracle] network:", network.name);
  console.log("[fix-feeoracle] feeOracle:", feeOracleAddr);
  console.log("[fix-feeoracle] deployer:", deployer.address);
  console.log("[fix-feeoracle] offchainOracle before:", offchainBefore);
  console.log("[fix-feeoracle] priceFeeds[0] before:", feedBefore);

  const Stub = await ethers.getContractFactory("FixedBnbUsdOffchainStub");
  const stub = await Stub.deploy();
  await stub.waitForDeployment();
  const stubAddr = await stub.getAddress();
  console.log("[fix-feeoracle] deployed FixedBnbUsdOffchainStub:", stubAddr);

  const tx0 = await feeOracle.connect(deployer).setOffchainOracle(stubAddr);
  console.log("[fix-feeoracle][tx] setOffchainOracle(stub):", tx0.hash);
  await tx0.wait();

  const tx1 = await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, bnbUsdFeed);
  console.log("[fix-feeoracle][tx] setPriceFeed(0, BNB/USD):", tx1.hash);
  await tx1.wait();

  const usd01 = await feeOracle.getUSDValue(ethers.ZeroAddress, ethers.parseEther("0.01"));
  const usd1 = await feeOracle.getUSDValue(ethers.ZeroAddress, ethers.parseEther("1"));
  console.log("[fix-feeoracle] getUSDValue(0, 0.01 BNB) =", usd01.toString(), "(8-dec USD)");
  console.log("[fix-feeoracle] getUSDValue(0, 1 BNB)   =", usd1.toString(), "(8-dec USD)");
  console.log("[fix-feeoracle] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
