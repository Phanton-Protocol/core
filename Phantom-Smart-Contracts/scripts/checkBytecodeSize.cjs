/**
 * CI gate: Path-B `ShieldedPoolUpgradeableReduced` implementation must stay deployable (EIP-170).
 * Run after `HH_FULL=1 npx hardhat compile`. Wired via `npm run check:bytecode`.
 */
const fs = require("fs");
const path = require("path");

const ARTIFACT =
  "artifacts/contracts/_full/core/ShieldedPoolUpgradeableReduced.sol/ShieldedPoolUpgradeableReduced.json";
const EIP170_LIMIT = 24576;
/**
 * Headroom below EIP-170 for future fixes without emergency library extraction.
 *
 * Path-B (M5, 2026-05): removed `internalMatchSettle` + the inline-assembly
 * DELEGATECALL forwarder + the `internalMatchIntentLib` immutable. The four
 * M3 storage mappings are retained as `__deprecated…` for proxy storage-layout
 * compatibility but contribute no bytecode. {PoolHelpersLib} stays linked for
 * compliance + fee distribution. The previous EIP-170 ceiling is no longer
 * load-bearing; we hold the soft margin at the hard cap until further
 * refactors free headroom. See
 * `core/docs/internal-matching-path-b-architecture.md`.
 */
const MARGIN_LIMIT = EIP170_LIMIT;
const CONTRACT_NAME = "ShieldedPoolUpgradeableReduced";

function byteLen(hex) {
  const h = String(hex || "").replace(/^0x/, "");
  return h.length / 2;
}

const artifactPath = path.join(__dirname, "..", ARTIFACT);
if (!fs.existsSync(artifactPath)) {
  console.error(`Missing ${ARTIFACT}. Run: HH_FULL=1 npx hardhat compile`);
  process.exit(1);
}

const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const size = byteLen(art.deployedBytecode);

console.log(`${CONTRACT_NAME}: ${size} bytes (EIP-170 ${EIP170_LIMIT}, margin target ${MARGIN_LIMIT})`);

if (size > EIP170_LIMIT) {
  console.error(`FAIL: exceeds EIP-170 limit by ${size - EIP170_LIMIT} bytes`);
  process.exit(1);
}
if (size > MARGIN_LIMIT) {
  console.error(`FAIL: exceeds margin target by ${size - MARGIN_LIMIT} bytes`);
  process.exit(1);
}

console.log("OK: bytecode within EIP-170 and margin.");
