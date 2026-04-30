function evaluateInternalMatchingGuardrails(env = process.env, opts = {}) {
  const errors = [];
  const warnings = [];
  const tier = String(env.PHANTOM_DEPLOYMENT_TIER || "").trim().toLowerCase();
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  const isProd = nodeEnv === "production" || tier === "production";
  const settlementMode = String(env.SETTLEMENT_SUBMISSION_MODE || "").trim().toLowerCase();
  const guardSee = opts.seeConfig || { mode: String(env.SEE_MODE || "disabled").toLowerCase() };
  const validatorUrls = String(env.VALIDATOR_URLS || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const attestationRequired = String(env.ATTESTATION_REQUIRED || "").toLowerCase() === "true";
  const attestationQuorum = Number(env.ATTESTATION_REQUIRED_QUORUM_BPS || 0);
  const complianceMode = String(env.COMPLIANCE_POLICY_MODE || "enforced").toLowerCase();
  const mockFlagsEnabled = [
    env.PHANTOM_SKIP_NO_MOCK_GATE === "true" ? "PHANTOM_SKIP_NO_MOCK_GATE=true" : null,
    String(env.FHE_MODE || "").toLowerCase() === "mock" ? "FHE_MODE=mock" : null,
    guardSee.mode === "mock" ? "SEE_MODE=mock" : null,
  ].filter(Boolean);

  if (!isProd) {
    if (mockFlagsEnabled.length) warnings.push(`non-prod mock flags enabled: ${mockFlagsEnabled.join(", ")}`);
    return { ok: true, errors, warnings, isProd };
  }

  if (mockFlagsEnabled.length) {
    errors.push(`mock/insecure flags are enabled (${mockFlagsEnabled.join(", ")})`);
  }
  if (settlementMode === "live_internal_match") {
    if (!validatorUrls.length) errors.push("VALIDATOR_URLS is required for live internal settlement");
    if (!attestationRequired) errors.push("ATTESTATION_REQUIRED must be true for live internal settlement");
    if (!Number.isFinite(attestationQuorum) || attestationQuorum <= 0) {
      errors.push("ATTESTATION_REQUIRED_QUORUM_BPS must be configured (> 0)");
    }
    if (complianceMode === "disabled") {
      errors.push("COMPLIANCE_POLICY_MODE cannot be disabled for live internal settlement");
    }
  }
  if (typeof opts.deriveFheSecurityPolicy === "function") {
    const fhePolicy = opts.deriveFheSecurityPolicy(env);
    if (fhePolicy.production && fhePolicy.mode !== "remote") {
      errors.push("FHE_MODE must be remote in production");
    }
  }
  return { ok: errors.length === 0, errors, warnings, isProd };
}

module.exports = { evaluateInternalMatchingGuardrails };
