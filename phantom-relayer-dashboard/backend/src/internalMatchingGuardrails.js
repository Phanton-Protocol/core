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
  // Path-B guardrail: match-time on-chain settlement is permanently disabled.
  // SETTLEMENT_SUBMISSION_MODE must be `dry_run` or `disabled` in production;
  // the legacy `live_internal_match` value is rejected.
  if (settlementMode === "live_internal_match") {
    errors.push(
      "SETTLEMENT_SUBMISSION_MODE=live_internal_match is not supported under Path-B. " +
        "Use SETTLEMENT_SUBMISSION_MODE=dry_run (no chain submit at match time)."
    );
  }
  if (settlementMode && settlementMode !== "dry_run" && settlementMode !== "disabled") {
    errors.push(
      `SETTLEMENT_SUBMISSION_MODE=${settlementMode} is not supported under Path-B (only dry_run|disabled).`
    );
  }
  // Path-B production posture still requires validator quorum + attestation +
  // strict compliance, even though we never submit match txs — these
  // safeguards now gate withdraw-side enforcement.
  if (!validatorUrls.length) errors.push("VALIDATOR_URLS is required in production");
  if (!attestationRequired) errors.push("ATTESTATION_REQUIRED must be true in production");
  if (!Number.isFinite(attestationQuorum) || attestationQuorum <= 0) {
    errors.push("ATTESTATION_REQUIRED_QUORUM_BPS must be configured (> 0)");
  }
  if (complianceMode === "disabled") {
    errors.push("COMPLIANCE_POLICY_MODE cannot be disabled in production");
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
