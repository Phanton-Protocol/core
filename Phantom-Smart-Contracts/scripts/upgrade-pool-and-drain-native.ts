/**
 * One-off: deploy new ShieldedPoolUpgradeableReduced implementation, UUPS upgrade proxy in-place,
 * then call emergencySendAllNativeBalance(recipient).
 *
 *   HH_FULL=1 OWNER_PRIVATE_KEY=0x... POOL_PROXY=0x4955... RECIPIENT=0x8F41... \
 *   npx hardhat run scripts/upgrade-pool-and-drain-native.ts --network bscTestnet
 */
import hre from "hardhat";
import { getReducedPoolFactory } from "./deploy/joinSplitFeeValidationLink";

const { ethers } = hre;

async function main() {
  const ownerPk = String(process.env.OWNER_PRIVATE_KEY || "").trim();
  const poolAddr = String(process.env.POOL_PROXY || process.env.SHIELDED_POOL_ADDRESS || "").trim();
  const recipient = String(process.env.RECIPIENT || "").trim();
  if (!ownerPk) throw new Error("OWNER_PRIVATE_KEY");
  if (!poolAddr) throw new Error("POOL_PROXY or SHIELDED_POOL_ADDRESS");
  const pk = ownerPk.startsWith("0x") ? ownerPk : `0x${ownerPk}`;
  const owner = new ethers.Wallet(pk, ethers.provider);
  const to = recipient ? ethers.getAddress(recipient) : owner.address;

  const balBefore = await ethers.provider.getBalance(poolAddr);
  console.log("[drain] pool balance wei", balBefore.toString());
  console.log("[drain] owner", owner.address);
  console.log("[drain] recipient", to);

  const Factory = await getReducedPoolFactory(owner);
  console.log("[drain] deploying new implementation...");
  const newImpl = await Factory.deploy();
  await newImpl.waitForDeployment();
  const implAddr = await newImpl.getAddress();
  console.log("[drain] new implementation", implAddr);

  const proxy = new ethers.Contract(
    poolAddr,
    ["function upgradeToAndCall(address newImplementation, bytes memory data) external payable"],
    owner
  );
  console.log("[drain] upgrading proxy...");
  const upTx = await proxy.upgradeToAndCall(implAddr, "0x");
  console.log("[drain] upgrade tx", upTx.hash);
  await upTx.wait();
  console.log("[drain] upgrade confirmed");

  const pool = new ethers.Contract(
    poolAddr,
    ["function emergencySendAllNativeBalance(address payable to) external"],
    owner
  );
  const drainTx = await pool.emergencySendAllNativeBalance(to);
  console.log("[drain] drain tx", drainTx.hash);
  await drainTx.wait();
  const balAfter = await ethers.provider.getBalance(poolAddr);
  console.log("[drain] pool balance after wei", balAfter.toString());
}

main().catch((e) => {
  console.error("[drain] failed:", e?.shortMessage || e?.message || e);
  process.exit(1);
});
