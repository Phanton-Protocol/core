const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.FIREBASE_FUNCTIONS = "true";
process.env.SEE_MODE = "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);
process.env.RELAYER_DB_PATH = process.env.RELAYER_DB_PATH || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phantom-runtime-mount-")), "relayer.db");

const { app } = require("../src/index");

async function withServer(t) {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return `http://127.0.0.1:${port}`;
}

test("runtime app mounts internal intent + Path-B status route (no on-chain settle)", async (t) => {
  const baseUrl = await withServer(t);

  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health?.internalRoutes?.intentInternal, true);
  // Path-B (M5): match-time on-chain settlement route is removed.
  assert.equal(health?.internalRoutes?.settlementInternal, false);
  assert.ok(Array.isArray(health?.internalRoutes?.endpoints));

  const internalHealthRes = await fetch(`${baseUrl}/internal-matching/health`);
  assert.ok(internalHealthRes.status === 200 || internalHealthRes.status === 503);
  const internalHealth = await internalHealthRes.json();
  assert.ok(internalHealth?.status === "ok" || internalHealth?.status === "degraded");
  assert.ok(Array.isArray(internalHealth?.routeCoverage));
  assert.ok(internalHealth?.config);

  const listRes = await fetch(`${baseUrl}/intent/internal?limit=1&offset=0`);
  assert.equal(listRes.status, 200);
  const listed = await listRes.json();
  assert.ok(Array.isArray(listed.items));

  const missingOrderRes = await fetch(`${baseUrl}/intent/internal/0x${"ab".repeat(32)}`);
  assert.equal(missingOrderRes.status, 404);
  const missingOrderBody = await missingOrderRes.json();
  assert.equal(missingOrderBody.error, "internal_order_not_found");

  // Path-B `/internal-match/:matchHash/status` returns 404 for unknown match.
  const matchHash = `0x${"cd".repeat(32)}`;
  const statusRes = await fetch(`${baseUrl}/internal-match/${matchHash}/status`);
  assert.equal(statusRes.status, 404);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.error, "internal_match_status_not_found");

  // Legacy `/settlement/internal/:matchHash/{start,retry,status}` routes are gone.
  const legacyStart = await fetch(`${baseUrl}/settlement/internal/${matchHash}/start`, { method: "POST" });
  assert.equal(legacyStart.status, 404);
});

