#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "module8");
const OUT_JSON = path.join(OUT_DIR, "readiness-summary.json");
const OUT_MD = path.join(OUT_DIR, "readiness-summary.md");

function runStep(step) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(step.command, {
    cwd: path.join(ROOT, step.cwd || "."),
    shell: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  const endedAt = new Date().toISOString();
  return {
    id: step.id,
    layer: step.layer,
    gate: step.gate,
    command: step.command,
    cwd: step.cwd || ".",
    required: !!step.required,
    startedAt,
    endedAt,
    exitCode: res.status,
    pass: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function summarize(results) {
  const byLayer = {};
  for (const r of results) {
    const entry = byLayer[r.layer] || { pass: 0, fail: 0, total: 0 };
    entry.total += 1;
    if (r.pass) entry.pass += 1;
    else entry.fail += 1;
    byLayer[r.layer] = entry;
  }
  const hardFailures = results.filter((r) => r.required && !r.pass);
  return {
    generatedAt: new Date().toISOString(),
    overallGo: hardFailures.length === 0,
    hardFailureCount: hardFailures.length,
    byLayer,
    results,
  };
}

function toMarkdown(summary) {
  const lines = [];
  lines.push("# Module 8 Readiness Summary");
  lines.push("");
  lines.push(`Generated at: ${summary.generatedAt}`);
  lines.push(`Final verdict: **${summary.overallGo ? "GO" : "NO-GO"}**`);
  lines.push("");
  lines.push("## Layer Summary");
  for (const [layer, s] of Object.entries(summary.byLayer)) {
    lines.push(`- ${layer}: ${s.pass}/${s.total} passed, ${s.fail} failed`);
  }
  lines.push("");
  lines.push("## Gate Results");
  for (const r of summary.results) {
    lines.push(`- [${r.pass ? "PASS" : "FAIL"}] ${r.id} (${r.layer})`);
    lines.push(`  - gate: ${r.gate}`);
    lines.push(`  - command: \`${r.command}\``);
    lines.push(`  - cwd: \`${r.cwd}\``);
    lines.push(`  - required: ${r.required ? "yes" : "no"}`);
    lines.push(`  - exitCode: ${r.exitCode}`);
  }
  lines.push("");
  lines.push("## Hard Failures");
  const hardFailures = summary.results.filter((r) => r.required && !r.pass);
  if (!hardFailures.length) lines.push("- none");
  else {
    for (const r of hardFailures) {
      lines.push(`- ${r.id}: failed required gate \`${r.gate}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

const steps = [
  {
    id: "backend_all_modules",
    layer: "backend",
    gate: "backend_gate",
    command: "npm run test",
    cwd: "phantom-relayer-dashboard/backend",
    required: true,
  },
  {
    id: "backend_adversarial_concurrency",
    layer: "adversarial",
    gate: "backend_gate",
    // Path-B (M5): `module5-settlement-onchain-bridge.test.cjs` was retired
    // alongside `internalMatchSettle`. M7 will re-add an off-chain
    // pending-note ledger suite here.
    command: "node --test test/module2-sqlite-concurrency.test.cjs test/module6-compliance-attestation.test.cjs",
    cwd: "phantom-relayer-dashboard/backend",
    required: true,
  },
  {
    id: "contracts_internal_match_revert_matrix",
    layer: "contracts",
    gate: "contract_gate",
    // Path-B (M5): legacy `internalMatchSettle.integration.test.cjs` deleted.
    // M6 will add an enroll-on-chain suite for the new entrypoint; until then
    // the full hardhat suite (run by `contracts_legacy_regression`) is the
    // gate.
    command: "HH_FULL=1 npx hardhat test test/shieldedPoolReduced.m3a.test.cjs",
    cwd: "Phantom-Smart-Contracts",
    required: true,
  },
  {
    id: "contracts_legacy_regression",
    layer: "contracts",
    gate: "contract_gate",
    command: "HH_FULL=1 npx hardhat test test/shieldedPool.integration.test.cjs test/shieldedPool.deposit.test.cjs",
    cwd: "Phantom-Smart-Contracts",
    required: true,
  },
  {
    id: "frontend_build_gate",
    layer: "frontend",
    gate: "frontend_gate",
    command: "npm run build",
    cwd: ".",
    required: true,
  },
  {
    id: "frontend_lint_signal",
    layer: "frontend",
    gate: "frontend_gate",
    command: "npm run lint",
    cwd: ".",
    required: false,
  },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const results = steps.map(runStep);
const summary = summarize(results);
fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
fs.writeFileSync(OUT_MD, toMarkdown(summary));

console.log(`Wrote ${OUT_JSON}`);
console.log(`Wrote ${OUT_MD}`);
for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.id} exit=${r.exitCode}`);
}
process.exit(summary.overallGo ? 0 : 1);
