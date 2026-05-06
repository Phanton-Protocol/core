const fs = require("fs");
const path = require("path");

const ARTIFACTS_ROOT = path.join(__dirname, "..", "artifacts", "contracts", "_full", "core");
const LIMIT_BYTES = 24576;

function readArtifact(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function collectArtifacts(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectArtifacts(p, out);
    else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function byteLen(hex) {
  const h = String(hex || "").replace(/^0x/, "");
  return h.length / 2;
}

const files = collectArtifacts(ARTIFACTS_ROOT);
if (!files.length) {
  console.error("No compiled artifacts found. Run `npm run compile:full` first.");
  process.exit(1);
}

let overs = 0;
const rows = [];
for (const f of files) {
  const art = readArtifact(f);
  if (!art || !art.bytecode) continue;
  const size = byteLen(art.bytecode);
  const rel = path.relative(path.join(__dirname, ".."), f);
  const over = size > LIMIT_BYTES;
  if (over) overs += 1;
  rows.push({ rel, size, over });
}

rows.sort((a, b) => b.size - a.size);
for (const r of rows) {
  const status = r.over ? "OVER" : "OK  ";
  console.log(`${status}  ${String(r.size).padStart(6)} bytes  ${r.rel}`);
}
console.log(`\nLimit: ${LIMIT_BYTES} bytes (EIP-170)`);
if (overs > 0) {
  console.error(`Oversized contracts: ${overs}`);
  process.exit(2);
}
console.log("All contract bytecode sizes are within limit.");

