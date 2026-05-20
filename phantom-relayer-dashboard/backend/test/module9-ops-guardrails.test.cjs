const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateInternalMatchingGuardrails } = require("../src/internalMatchingGuardrails");

function deriveStubFhePolicy(env) {
  return {
    production: String(env.NODE_ENV || "").toLowerCase() === "production",
    mode: String(env.FHE_MODE || "mock").toLowerCase() === "remote" ? "remote" : "mock",
  };
}

test("module9 allows non-production even with mock flags", () => {
  const out = evaluateInternalMatchingGuardrails(
    {
      NODE_ENV: "development",
      PHANTOM_DEPLOYMENT_TIER: "dev",
      FHE_MODE: "mock",
      SEE_MODE: "mock",
      PHANTOM_SKIP_NO_MOCK_GATE: "true",
    },
    {
      seeConfig: { mode: "mock" },
      deriveFheSecurityPolicy: deriveStubFhePolicy,
    }
  );
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.warnings));
});

test("module9 blocks production startup with mock/insecure flags", () => {
  const out = evaluateInternalMatchingGuardrails(
    {
      NODE_ENV: "production",
      PHANTOM_DEPLOYMENT_TIER: "production",
      FHE_MODE: "mock",
      SEE_MODE: "mock",
      PHANTOM_SKIP_NO_MOCK_GATE: "true",
    },
    {
      seeConfig: { mode: "mock" },
      deriveFheSecurityPolicy: deriveStubFhePolicy,
    }
  );
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("mock/insecure flags")));
});

test("module9 rejects Path-B forbidden SETTLEMENT_SUBMISSION_MODE=live_internal_match", () => {
  const out = evaluateInternalMatchingGuardrails(
    {
      NODE_ENV: "production",
      PHANTOM_DEPLOYMENT_TIER: "production",
      FHE_MODE: "remote",
      SETTLEMENT_SUBMISSION_MODE: "live_internal_match",
      COMPLIANCE_POLICY_MODE: "enforced",
      ATTESTATION_REQUIRED: "true",
      ATTESTATION_REQUIRED_QUORUM_BPS: "6600",
      VALIDATOR_URLS: "http://v1,http://v2",
    },
    {
      seeConfig: { mode: "disabled" },
      deriveFheSecurityPolicy: deriveStubFhePolicy,
    }
  );
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("live_internal_match is not supported under Path-B")));
});

test("module9 blocks missing verifier/attestation config in production (Path-B safeguards)", () => {
  const out = evaluateInternalMatchingGuardrails(
    {
      NODE_ENV: "production",
      PHANTOM_DEPLOYMENT_TIER: "production",
      FHE_MODE: "remote",
      SETTLEMENT_SUBMISSION_MODE: "dry_run",
      COMPLIANCE_POLICY_MODE: "disabled",
      ATTESTATION_REQUIRED: "false",
      ATTESTATION_REQUIRED_QUORUM_BPS: "",
      VALIDATOR_URLS: "",
    },
    {
      seeConfig: { mode: "disabled" },
      deriveFheSecurityPolicy: deriveStubFhePolicy,
    }
  );
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes("VALIDATOR_URLS")));
  assert.ok(out.errors.some((e) => e.includes("ATTESTATION_REQUIRED must be true")));
});

