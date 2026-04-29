const path = require("path");
const os = require("os");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const storePath = path.join(os.tmpdir(), `phantom-fhe-internal-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
process.env.MATCHING_ORDER_STORE = storePath;

const {
  registerOrderAndTryMatch,
  normalizeFheOrder,
  deriveFheSecurityPolicy,
  assertFheProductionSafety,
} = require("../src/fheMatchingService");

test("normalizeFheOrder rejects invalid asset ids", () => {
  assert.equal(normalizeFheOrder(null), null);
  assert.equal(normalizeFheOrder({ inputAssetID: "x", outputAssetID: 1 }), null);
});

test("string asset IDs match against numeric counter-order", async () => {
  const o1 = {
    inputAssetID: "701",
    outputAssetID: "702",
    fheEncryptedInputAmount: "0x01",
    fheEncryptedMinOutput: "0x02",
  };
  const r1 = await registerOrderAndTryMatch(o1);
  assert.equal(r1.matched, false);

  const o2 = {
    inputAssetID: 702,
    outputAssetID: 701,
    fheEncryptedInputAmount: "0x03",
    fheEncryptedMinOutput: "0x04",
  };
  const r2 = await registerOrderAndTryMatch(o2);
  assert.equal(r2.matched, true);
  assert.ok(r2.matchResult?.executionId);
  assert.ok(r2.matchResult?.fheEncryptedResult);
});

test("production safety policy rejects insecure flags", () => {
  const insecure = deriveFheSecurityPolicy({
    NODE_ENV: "production",
    PHANTOM_DEPLOYMENT_TIER: "production",
    FHE_MODE: "mock",
    FHE_SERVICE_URL: "",
    MATCHING_FHE_POLICY_MODE: "degraded",
    MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE: "true",
  });
  assert.throws(() => assertFheProductionSafety(insecure), /Production startup blocked/);
});

test("production safety policy accepts strict remote configuration", () => {
  const secure = deriveFheSecurityPolicy({
    NODE_ENV: "production",
    PHANTOM_DEPLOYMENT_TIER: "production",
    FHE_MODE: "remote",
    FHE_SERVICE_URL: "https://fhe.example",
    MATCHING_FHE_POLICY_MODE: "strict",
    MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE: "false",
  });
  assert.doesNotThrow(() => assertFheProductionSafety(secure));
});
