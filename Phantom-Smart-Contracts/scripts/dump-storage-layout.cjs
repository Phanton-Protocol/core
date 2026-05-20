/**
 * Dump storageLayout for ShieldedPoolUpgradeableReduced (and any other FQN passed via CLI).
 *
 * Usage:
 *   HH_FULL=1 npx hardhat run scripts/dump-storage-layout.cjs
 *   HH_FULL=1 OUT=/tmp/reduced_storage_before.json npx hardhat run scripts/dump-storage-layout.cjs
 *
 * We re-run the standard solc input that Hardhat already produced (build-info)
 * but with `storageLayout` added to outputSelection so the layout JSON appears
 * in the output. Hardhat caches the regular build artifacts; this script does
 * not overwrite them — it only writes the storage-layout JSON to the path in
 * the OUT env var (default: ./storage-layout.json).
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const TARGET_FQN =
  process.env.FQN ||
  "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const OUT = process.env.OUT || path.join(__dirname, "..", "storage-layout.json");

async function main() {
  const buildInfo = await hre.artifacts.getBuildInfo(TARGET_FQN);
  if (!buildInfo) throw new Error(`No build info found for ${TARGET_FQN} — compile first.`);

  // Force-include storageLayout for the solc re-run.
  const input = JSON.parse(JSON.stringify(buildInfo.input));
  input.settings.outputSelection = input.settings.outputSelection || {};
  input.settings.outputSelection["*"] = input.settings.outputSelection["*"] || {};
  input.settings.outputSelection["*"]["*"] = Array.from(
    new Set([...(input.settings.outputSelection["*"]["*"] || []), "storageLayout", "abi"])
  );

  const solcVersion = buildInfo.solcVersion;
  const solcBuild = await hre.run("compile:solidity:solc:get-build", { solcVersion, quiet: true });
  let outputRaw;
  if (solcBuild.isSolcJs) {
    const solc = require(solcBuild.compilerPath);
    outputRaw = solc.compile(JSON.stringify(input));
  } else {
    const { spawnSync } = require("child_process");
    const res = spawnSync(solcBuild.compilerPath, ["--standard-json"], {
      input: JSON.stringify(input),
      maxBuffer: 1024 * 1024 * 200,
    });
    if (res.status !== 0) {
      throw new Error(`solc exited with ${res.status}: ${res.stderr?.toString() || ""}`);
    }
    outputRaw = res.stdout.toString();
  }
  const output = JSON.parse(outputRaw);
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length) {
      console.error("Solc errors:");
      for (const e of fatal) console.error(" - " + e.formattedMessage);
      throw new Error("Solc compile failed");
    }
  }

  const [sourcePath, contractName] = TARGET_FQN.split(":");
  const layout = output.contracts?.[sourcePath]?.[contractName]?.storageLayout;
  if (!layout) {
    throw new Error(`No storageLayout in solc output for ${TARGET_FQN}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(layout, null, 2));
  console.log(`Wrote storage layout for ${TARGET_FQN} -> ${OUT}`);
  console.log(`Storage slots:`);
  for (const v of layout.storage) {
    console.log(`  slot ${v.slot} offset ${v.offset} ${v.type} ${v.label}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
