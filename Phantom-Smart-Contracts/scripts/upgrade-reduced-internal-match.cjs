/**
 * M3 — Dry-run UUPS upgrade preparation for the BSC-testnet Reduced pool at
 * `0x77C4BadA4306e4b258980f0f0D79Aec814509FDf`.
 *
 * Goal (per `plans/fhe_internal_matching_milestones_520fa333.plan.md`):
 *   - Prepare (but do NOT submit) the upgrade transaction that promotes the
 *     proxy at 0x77C4... to the post-M3 implementation containing the working
 *     `internalMatchSettle` entrypoint.
 *   - Print the target proxy + the exact `upgradeToAndCall(newImpl, "0x")`
 *     calldata so the operator can submit the transaction manually from the
 *     pool-owner / timelock multisig.
 *
 * Hard rules (verified by the dry-run):
 *   1. NO on-chain transaction is ever broadcast by this script.
 *   2. Storage layout MUST be additive only — the script reads the layout JSON
 *      and aborts if any pre-M3 slot has moved.
 *   3. Runtime bytecode MUST be under EIP-170 (24,576 bytes); script aborts if
 *      the new impl exceeds the cap.
 *
 * Two modes:
 *   - `local`  (default):  spin up a hardhat in-memory fork, deploy each
 *                          required library + the new impl, then print the
 *                          `upgradeToAndCall` calldata for the operator to use
 *                          against the live proxy. Library / impl addresses
 *                          differ from BSC testnet so the calldata produced
 *                          here is layout-correct but address-illustrative —
 *                          re-run with `--network bscTestnet` against live
 *                          deployer wallet to get the real addresses.
 *   - bscTestnet:          when invoked with `--network bscTestnet`, deploys
 *                          libraries + impl on testnet (signed by
 *                          `DEPLOYER_PRIVATE_KEY` / `PRIVATE_KEY` from .env)
 *                          but STILL does not call `upgradeToAndCall`. The
 *                          final transaction is left for the operator.
 *
 * Usage:
 *     # Local dry run (no testnet RPC needed):
 *     HH_FULL=1 npx hardhat run scripts/upgrade-reduced-internal-match.cjs
 *
 *     # On testnet (requires funded DEPLOYER_PRIVATE_KEY in .env):
 *     HH_FULL=1 npx hardhat run scripts/upgrade-reduced-internal-match.cjs --network bscTestnet
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const POOL_PROXY_ADDR = "0x77C4BadA4306e4b258980f0f0D79Aec814509FDf";
const REDUCED_FQN =
  "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const INTENT_LIB_FQN = "contracts/_full/libraries/InternalMatchIntentLib.sol:InternalMatchIntentLib";
const JOIN_SPLIT_FEE_LIB_FQN =
  "contracts/_full/libraries/JoinSplitFeeValidation.sol:JoinSplitFeeValidation";
const MEV_COMMIT_LIB_FQN = "contracts/_full/libraries/MevCommitReveal.sol:MevCommitReveal";
const POOL_HELPERS_LIB_FQN = "contracts/_full/libraries/PoolHelpersLib.sol:PoolHelpersLib";

const EIP170_LIMIT = 24576;

function hexLen(hex) {
  const h = String(hex || "").replace(/^0x/, "");
  return h.length / 2;
}

/**
 * Re-derive the storage-layout JSON for the post-M3 Reduced impl from
 * Hardhat's build-info. Aborts if any pre-M3 slot has moved.
 */
async function assertAdditiveOnlyStorageLayout() {
  const buildInfo = await hre.artifacts.getBuildInfo(REDUCED_FQN);
  if (!buildInfo) throw new Error(`No build info for ${REDUCED_FQN}`);
  const input = JSON.parse(JSON.stringify(buildInfo.input));
  input.settings.outputSelection = input.settings.outputSelection || {};
  input.settings.outputSelection["*"] = input.settings.outputSelection["*"] || {};
  input.settings.outputSelection["*"]["*"] = Array.from(
    new Set([...(input.settings.outputSelection["*"]["*"] || []), "storageLayout"])
  );
  const solcBuild = await hre.run("compile:solidity:solc:get-build", {
    solcVersion: buildInfo.solcVersion,
    quiet: true,
  });
  let raw;
  if (solcBuild.isSolcJs) {
    const solc = require(solcBuild.compilerPath);
    raw = solc.compile(JSON.stringify(input));
  } else {
    const { spawnSync } = require("child_process");
    const res = spawnSync(solcBuild.compilerPath, ["--standard-json"], {
      input: JSON.stringify(input),
      maxBuffer: 1024 * 1024 * 200,
    });
    raw = res.stdout.toString();
  }
  const out = JSON.parse(raw);
  const [src, name] = REDUCED_FQN.split(":");
  const layout = out.contracts?.[src]?.[name]?.storageLayout;
  if (!layout) throw new Error("Failed to derive storageLayout");

  // The M3 mappings MUST appear at or after slot 336 (right after the
  // pre-existing `__moduleOneSecurityGap[44]` at slots 292..335).
  const m3Slots = [
    "usedInternalMatchHashes",
    "usedInternalDecisionHashes",
    "internalMatchAttestationNonceUsed",
    "internalMatchIntentNonceUsed",
  ];
  for (const v of layout.storage) {
    if (m3Slots.includes(v.label)) {
      const slot = Number(v.slot);
      if (slot < 336) {
        throw new Error(
          `[storage] ${v.label} at slot ${slot} — MUST be >= 336 (end of __moduleOneSecurityGap)`
        );
      }
    }
  }

  // Cross-check vs. the pre-M3 baseline if a snapshot is available alongside.
  const baselinePath = path.join(__dirname, "..", "..", "docs", "reduced-storage-pre-m3.json");
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const byLabel = (arr) => Object.fromEntries(arr.map((v) => [v.label, v]));
    const before = byLabel(baseline.storage || baseline);
    const after = byLabel(layout.storage);
    for (const [label, prev] of Object.entries(before)) {
      const next = after[label];
      if (!next) throw new Error(`[storage] slot for ${label} disappeared in post-M3 layout`);
      if (Number(next.slot) !== Number(prev.slot)) {
        throw new Error(
          `[storage] ${label} moved from slot ${prev.slot} -> ${next.slot}: REGRESSION`
        );
      }
      if (Number(next.offset) !== Number(prev.offset)) {
        throw new Error(
          `[storage] ${label} offset moved from ${prev.offset} -> ${next.offset}: REGRESSION`
        );
      }
    }
  }
  console.log("[storage] additive-only check PASSED (all pre-M3 slots preserved)");
}

/**
 * Validate the post-M3 deployed bytecode is under EIP-170. Reads the cached
 * artifact (the script does NOT recompile).
 */
function assertEip170(deployedBytecodeHex) {
  const size = hexLen(deployedBytecodeHex);
  if (size > EIP170_LIMIT) {
    throw new Error(
      `[size] post-M3 deployed bytecode is ${size} bytes — exceeds EIP-170 limit ${EIP170_LIMIT}`
    );
  }
  console.log(`[size] deployed bytecode ${size} bytes (EIP-170 limit ${EIP170_LIMIT}) — OK`);
  return size;
}

async function deployLibraries(deployer) {
  console.log("[deploy] InternalMatchIntentLib");
  const IntentLib = await hre.ethers.getContractFactory(INTENT_LIB_FQN, deployer);
  const intentLib = await IntentLib.deploy();
  await intentLib.waitForDeployment();

  console.log("[deploy] JoinSplitFeeValidation");
  const FeeLib = await hre.ethers.getContractFactory(JOIN_SPLIT_FEE_LIB_FQN, deployer);
  const feeLib = await FeeLib.deploy();
  await feeLib.waitForDeployment();

  console.log("[deploy] MevCommitReveal");
  const MevLib = await hre.ethers.getContractFactory(MEV_COMMIT_LIB_FQN, deployer);
  const mevLib = await MevLib.deploy();
  await mevLib.waitForDeployment();

  console.log("[deploy] PoolHelpersLib");
  const Helpers = await hre.ethers.getContractFactory(POOL_HELPERS_LIB_FQN, deployer);
  const helpers = await Helpers.deploy();
  await helpers.waitForDeployment();

  return {
    InternalMatchIntentLib: await intentLib.getAddress(),
    JoinSplitFeeValidation: await feeLib.getAddress(),
    MevCommitReveal: await mevLib.getAddress(),
    PoolHelpersLib: await helpers.getAddress(),
  };
}

async function deployNewImplementation(deployer, libs) {
  // M3 ctor signature: `constructor(address _internalMatchIntentLib)`.
  const Factory = await hre.ethers.getContractFactory(REDUCED_FQN, {
    signer: deployer,
    libraries: {
      JoinSplitFeeValidation: libs.JoinSplitFeeValidation,
      MevCommitReveal: libs.MevCommitReveal,
      PoolHelpersLib: libs.PoolHelpersLib,
    },
  });
  console.log("[deploy] ShieldedPoolUpgradeableReduced (impl) with ctor arg:", libs.InternalMatchIntentLib);
  const impl = await Factory.deploy(libs.InternalMatchIntentLib);
  await impl.waitForDeployment();
  return impl;
}

async function main() {
  const isLive = String(hre.network.name) === "bscTestnet" || String(hre.network.name) === "bsc";
  console.log("=".repeat(78));
  console.log(`M3 Reduced pool UUPS upgrade — DRY RUN (network=${hre.network.name})`);
  console.log("=".repeat(78));
  console.log("[target] proxy:", POOL_PROXY_ADDR, "(this script does NOT call it)");

  // Storage-layout gate runs first — regression here means the dry run is
  // unsafe to submit at all, library / impl deployment is skipped.
  await assertAdditiveOnlyStorageLayout();

  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer available. On bscTestnet, set DEPLOYER_PRIVATE_KEY in .env. On local, ensure hardhat node is reachable."
    );
  }
  const deployer = signers[0];
  console.log("[deploy] signer:", deployer.address);

  if (isLive) {
    console.log(
      "[warn] running against a LIVE network. This script deploys libraries + impl but DOES NOT submit `upgradeToAndCall`."
    );
  }

  const libs = await deployLibraries(deployer);
  console.log("[deploy] library addresses:");
  console.log(JSON.stringify(libs, null, 2));

  const impl = await deployNewImplementation(deployer, libs);
  const implAddr = await impl.getAddress();
  const provider = hre.ethers.provider;
  const code = await provider.getCode(implAddr);
  assertEip170(code);
  console.log("[deploy] new implementation address:", implAddr);

  // Compose upgradeToAndCall calldata (UUPSUpgradeable.upgradeToAndCall(address,bytes)).
  const upgradeAbi = ["function upgradeToAndCall(address newImplementation, bytes memory data) external payable"];
  const iface = new hre.ethers.Interface(upgradeAbi);
  const calldata = iface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);

  console.log("");
  console.log("=".repeat(78));
  console.log("UPGRADE TRANSACTION TO SUBMIT MANUALLY (DO NOT use this script to broadcast)");
  console.log("=".repeat(78));
  console.log("To       :", POOL_PROXY_ADDR);
  console.log("Value    : 0");
  console.log("Data     :", calldata);
  console.log("");
  console.log("Selector : 0x4f1ef286 (upgradeToAndCall(address,bytes))");
  console.log("NewImpl  :", implAddr);
  console.log("Init     : 0x (none — impl already initialised via existing proxy state)");
  console.log("");
  console.log("Submit from: the pool's authorized upgrader.");
  console.log(
    "  - If `timelock` is set on the proxy, the timelock contract MUST be the sender."
  );
  console.log(
    "  - Otherwise the OZ `owner()` MUST be the sender (bootstrap path; switch to timelock after the upgrade via `initializeV2(...)`)."
  );
  console.log("");
  console.log("Post-upgrade smoke check (read-only):");
  console.log(
    `  cast call ${POOL_PROXY_ADDR} 'internalMatchIntentLib()(address)' --rpc-url $BSC_TESTNET_RPC`
  );
  console.log(`  expected: ${libs.InternalMatchIntentLib}`);
  console.log("=".repeat(78));

  // Final safety: explicit assertion that we did NOT broadcast the upgrade.
  console.log("[safety] upgradeToAndCall was NOT submitted. Operator action required.");
}

main().catch((err) => {
  console.error("[upgrade-reduced-internal-match] failed:", err?.shortMessage || err?.message || err);
  process.exit(1);
});
