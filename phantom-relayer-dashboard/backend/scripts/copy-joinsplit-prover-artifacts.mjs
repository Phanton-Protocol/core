/**
 * Copy joinsplit_public9 Groth16 artifacts into backend/circuits/ so resolveProverPaths()
 * finds them without PROVER_WASM / PROVER_ZKEY.
 *
 * Vercel (typical):
 *   - Project root directory: core/phantom-relayer-dashboard/backend (full repo clone).
 *   - Build command: npm install && npm run build
 *   - vercel.json includeFiles packs backend/circuits/** into the function.
 *
 * Production: wasm + circuit_final.zkey MUST match the deployed JoinSplitVerifier (pinned hashes in
 * Phantom-Smart-Contracts/circuits/joinsplit_public9/manifest.json). Do not run circuit:build:joinsplit
 * on Vercel to "generate" them — that creates a new zkey and proofs will fail on-chain. Commit the
 * pinned wasm/zkey in the repo (or restore from your release cache), then this script only copies.
 *
 * Optional: VERIFY_PROVER_ARTIFACTS=1 to assert sha256 matches manifest.json after copy.
 * Override source: PHANTOM_PSC_ROOT=/path/to/Phantom-Smart-Contracts
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

const pscRoot = process.env.PHANTOM_PSC_ROOT?.trim()
  ? path.resolve(process.env.PHANTOM_PSC_ROOT.trim())
  : path.join(backendRoot, "..", "..", "Phantom-Smart-Contracts");

const joinsplitDir = path.join(pscRoot, "circuits", "joinsplit_public9");
const srcWasm = path.join(joinsplitDir, "build", "joinsplit_public9_js", "joinsplit_public9.wasm");
const srcZkey = path.join(joinsplitDir, "circuit_final.zkey");

const destWasmDir = path.join(backendRoot, "circuits", "joinsplit_public9_js");
const destWasm = path.join(destWasmDir, "joinsplit_public9.wasm");
const destZkey = path.join(backendRoot, "circuits", "joinsplit_public9_final.zkey");

function fileSha256Hex(absPath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

function verifyAgainstManifest() {
  const manifestPath = path.join(joinsplitDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.warn("[copy-joinsplit-prover-artifacts] No manifest.json — skip sha256 verify");
    return;
  }
  let man;
  try {
    man = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    console.warn("[copy-joinsplit-prover-artifacts] manifest.json unreadable — skip sha256 verify");
    return;
  }
  const expWasm = man?.artifacts?.wasm?.sha256;
  const expZkey = man?.artifacts?.zkeyFinal?.sha256;
  const gotWasm = fileSha256Hex(destWasm);
  const gotZkey = fileSha256Hex(destZkey);
  if (expWasm && gotWasm !== expWasm) {
    console.error("[copy-joinsplit-prover-artifacts] wasm sha256 mismatch manifest.json");
    console.error("  expected:", expWasm);
    console.error("  got:     ", gotWasm);
    process.exit(1);
  }
  if (expZkey && gotZkey !== expZkey) {
    console.error("[copy-joinsplit-prover-artifacts] zkey sha256 mismatch manifest.json");
    console.error("  expected:", expZkey);
    console.error("  got:     ", gotZkey);
    process.exit(1);
  }
  console.log("[copy-joinsplit-prover-artifacts] sha256 OK (manifest.json)");
}

function main() {
  const need = [
    ["wasm", srcWasm],
    ["zkey", srcZkey],
  ];
  const missing = need.filter(([, p]) => !fs.existsSync(p));
  if (missing.length) {
    console.error("[copy-joinsplit-prover-artifacts] Missing:");
    for (const [kind, p] of missing) console.error(`  (${kind}) ${p}`);
    console.error("");
    console.error("Add the pinned joinsplit_public9 wasm + circuit_final.zkey under:");
    console.error(`  ${joinsplitDir}`);
    console.error("(commit them, or restore from the artifact store that matches production verifier).");
    console.error("Dev-only local compile: cd Phantom-Smart-Contracts && npm run circuit:build:joinsplit");
    console.error(`PHANTOM_PSC_ROOT (if layout differs): ${pscRoot}`);
    process.exit(1);
  }

  fs.mkdirSync(destWasmDir, { recursive: true });
  fs.copyFileSync(srcWasm, destWasm);
  fs.copyFileSync(srcZkey, destZkey);
  console.log("[copy-joinsplit-prover-artifacts] OK");
  console.log(" ", destWasm);
  console.log(" ", destZkey);

  const verify =
    process.env.VERIFY_PROVER_ARTIFACTS === "1" || /^true$/i.test(process.env.VERIFY_PROVER_ARTIFACTS || "");
  if (verify) verifyAgainstManifest();
}

main();
