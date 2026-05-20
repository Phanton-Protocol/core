const crypto = require("crypto");
const { ethers } = require("ethers");
const {
  getMatchByHash,
  listFillsByMatch,
  createSettlementExecutionIfAbsent,
  updateSettlementExecution,
  getSettlementExecutionByMatchHash,
  saveSettlementEvent,
  listSettlementEventsByExecutionId,
  saveAttestationDecision,
  listComplianceDecisionsByMatch,
  listAttestationDecisionsByMatch,
} = require("./db");

const SETTLEMENT_STATUS = Object.freeze({
  PENDING: "pending",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  RETRIABLE: "retriable",
});

const PRECHECK_REASON = Object.freeze({
  MISSING_NOTE_REFERENCES: "MISSING_NOTE_REFERENCES",
  MISSING_WITNESS_CONTEXT: "MISSING_WITNESS_CONTEXT",
  CONSERVATION_CHECK_FAILED: "CONSERVATION_CHECK_FAILED",
  FEE_CHECK_FAILED: "FEE_CHECK_FAILED",
  FHE_LINKAGE_REQUIRED_MISSING: "FHE_LINKAGE_REQUIRED_MISSING",
  POLICY_NO_SUBMIT: "POLICY_NO_SUBMIT",
  SUBMIT_TRANSIENT_ERROR: "SUBMIT_TRANSIENT_ERROR",
  SUBMIT_FATAL_ERROR: "SUBMIT_FATAL_ERROR",
  FALLBACK_ROUTED: "FALLBACK_ROUTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  ONCHAIN_DATA_MISSING: "ONCHAIN_DATA_MISSING",
  COMPLIANCE_BLOCKED: "COMPLIANCE_BLOCKED",
  COMPLIANCE_HOLD: "COMPLIANCE_HOLD",
  COMPLIANCE_ESCALATED: "COMPLIANCE_ESCALATED",
  ATTESTATION_MISSING: "ATTESTATION_MISSING",
  ATTESTATION_INVALID: "ATTESTATION_INVALID",
  ATTESTATION_QUORUM_INSUFFICIENT: "ATTESTATION_QUORUM_INSUFFICIENT",
  DECISION_ARTIFACT_MISSING: "DECISION_ARTIFACT_MISSING",
  DECISION_ARTIFACT_INVALID: "DECISION_ARTIFACT_INVALID",
  PROOF_CONTEXT_BINDING_MISSING: "PROOF_CONTEXT_BINDING_MISSING",
  PROOF_CONTEXT_BINDING_INVALID: "PROOF_CONTEXT_BINDING_INVALID",
});

function b(v) {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
}

function normalizePolicy(opts = {}) {
  return {
    protocolFeeBps: Number(opts.protocolFeeBps ?? process.env.SETTLEMENT_PROTOCOL_FEE_BPS ?? 20),
    gasRefundWei: b(opts.gasRefundWei ?? process.env.SETTLEMENT_GAS_REFUND_WEI ?? "0"),
    requireFheLinkage: opts.requireFheLinkage ?? process.env.SETTLEMENT_REQUIRE_FHE_LINKAGE === "true",
    fallbackMode: String(opts.fallbackMode ?? process.env.SETTLEMENT_FALLBACK_MODE ?? "none"),
    allowFallback: opts.allowFallback ?? (process.env.SETTLEMENT_ALLOW_FALLBACK === "true"),
    submissionMode: String(opts.submissionMode ?? process.env.SETTLEMENT_SUBMISSION_MODE ?? "dry_run"),
    compliancePolicyMode: String(opts.compliancePolicyMode ?? process.env.COMPLIANCE_POLICY_MODE ?? "enforced"),
    compliancePolicyVersion: String(opts.compliancePolicyVersion ?? process.env.COMPLIANCE_POLICY_VERSION ?? "v1"),
    requireAttestation: opts.requireAttestation ?? (process.env.ATTESTATION_REQUIRED === "true"),
    attestationQuorumBps: Number(opts.attestationQuorumBps ?? process.env.ATTESTATION_REQUIRED_QUORUM_BPS ?? 6600),
  };
}

function classifySubmissionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("network") ||
    msg.includes("429") ||
    msg.includes("rate")
  ) {
    return { transient: true, reasonCode: PRECHECK_REASON.SUBMIT_TRANSIENT_ERROR };
  }
  if (msg.includes("poolerr(") || msg.includes("execution reverted") || msg.includes("call exception")) {
    return { transient: false, reasonCode: PRECHECK_REASON.SUBMIT_FATAL_ERROR };
  }
  return { transient: false, reasonCode: PRECHECK_REASON.SUBMIT_FATAL_ERROR };
}

function defaultSubmitter({ payload }) {
  const hash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        matchHash: payload.matchHash,
        executionKey: payload.executionKey,
        inputAmount: payload.amounts.inputAmount,
        outputMatched: payload.amounts.matchedOut,
      })
    )
  );
  return { txHash: hash, mode: "dry_run" };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashDecisionArtifact(artifact) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(artifact || {})));
}

function buildSettlementPayload(match, fills, policy) {
  const qty = b(match.quantity);
  const meta = match.metadataJson || {};
  const noteRefs = Array.isArray(meta.noteRefs) ? meta.noteRefs : [];
  const witness = meta.witness || null;

  const inputAmount = qty;
  const decisionArtifact = meta.decisionArtifact || null;
  const protocolFee = (inputAmount * BigInt(Math.max(policy.protocolFeeBps, 0))) / 10000n;
  const gasRefund = b(policy.gasRefundWei);
  const changeAmount = b(meta.changeAmount ?? "0");
  const matchedOut = inputAmount - protocolFee - gasRefund - changeAmount;

  return {
    matchHash: match.matchHash,
    executionKey: match.executionKey,
    pairBase: match.pairBase,
    pairQuote: match.pairQuote,
    takerOrderId: match.takerOrderId,
    makerOrderId: match.makerOrderId,
    fills: fills.map((f) => ({
      orderId: f.orderId,
      side: f.side,
      quantity: String(f.quantity),
      price: String(f.price),
      isMaker: !!f.isMaker,
    })),
    noteRefs,
    witness,
    onchain: meta.onchain || null,
    fheBinding: {
      fheDecisionHash: match.fheDecisionHash || null,
      fheResultHash: match.fheResultHash || null,
      fheAttestationRef: match.fheAttestationRef || null,
      decisionArtifact,
    },
    amounts: {
      inputAmount: inputAmount.toString(),
      matchedOut: matchedOut.toString(),
      changeAmount: changeAmount.toString(),
      protocolFee: protocolFee.toString(),
      gasRefund: gasRefund.toString(),
    },
    conservation: {
      lhs: inputAmount.toString(),
      rhs: (matchedOut + changeAmount + protocolFee + gasRefund).toString(),
    },
  };
}

function validateDecisionArtifact(payload) {
  const artifact = payload?.fheBinding?.decisionArtifact;
  if (!artifact || typeof artifact !== "object") {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_MISSING, details: { missing: "decisionArtifact" } };
  }
  const expectedHash = String(payload?.fheBinding?.fheDecisionHash || "");
  if (!expectedHash) {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_MISSING, details: { missing: "fheDecisionHash" } };
  }
  const actualHash = hashDecisionArtifact(artifact);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return {
      ok: false,
      reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID,
      details: { expectedHash, actualHash, reason: "hash_mismatch" },
    };
  }
  if (String(artifact?.bindings?.matchHash || "") !== String(payload.matchHash || "")) {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID, details: { reason: "match_hash_mismatch" } };
  }
  if (String(artifact?.bindings?.executionKey || "") !== String(payload.executionKey || "")) {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID, details: { reason: "execution_key_mismatch" } };
  }
  if (String(artifact?.orders?.taker?.orderId || "") !== String(payload.takerOrderId || "")) {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID, details: { reason: "taker_order_mismatch" } };
  }
  if (String(artifact?.orders?.maker?.orderId || "") !== String(payload.makerOrderId || "")) {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID, details: { reason: "maker_order_mismatch" } };
  }
  if (String(artifact?.result?.decision || "") !== "match_approved") {
    return { ok: false, reasonCode: PRECHECK_REASON.DECISION_ARTIFACT_INVALID, details: { reason: "decision_not_match_approved" } };
  }
  return { ok: true, decisionHash: actualHash };
}

function runPrechecks(payload, policy) {
  if (!Array.isArray(payload.noteRefs) || payload.noteRefs.length === 0) {
    return { ok: false, reasonCode: PRECHECK_REASON.MISSING_NOTE_REFERENCES, details: {} };
  }
  if (!payload.witness || !payload.witness.merkleRoot) {
    return { ok: false, reasonCode: PRECHECK_REASON.MISSING_WITNESS_CONTEXT, details: {} };
  }
  if (policy.requireFheLinkage && (!payload.fheBinding.fheDecisionHash || !payload.fheBinding.fheResultHash)) {
    return { ok: false, reasonCode: PRECHECK_REASON.FHE_LINKAGE_REQUIRED_MISSING, details: {} };
  }
  const decision = validateDecisionArtifact(payload);
  if (!decision.ok) {
    return { ok: false, reasonCode: decision.reasonCode, details: decision.details || {} };
  }
  const lhs = b(payload.conservation.lhs);
  const rhs = b(payload.conservation.rhs);
  if (lhs !== rhs) {
    return { ok: false, reasonCode: PRECHECK_REASON.CONSERVATION_CHECK_FAILED, details: { lhs: lhs.toString(), rhs: rhs.toString() } };
  }
  if (b(payload.amounts.protocolFee) < 0n || b(payload.amounts.gasRefund) < 0n) {
    return { ok: false, reasonCode: PRECHECK_REASON.FEE_CHECK_FAILED, details: payload.amounts };
  }
  if (b(payload.amounts.matchedOut) < 0n) {
    return { ok: false, reasonCode: PRECHECK_REASON.CONSERVATION_CHECK_FAILED, details: payload.amounts };
  }
  // Path-B: on-chain settle (`live_internal_match`) removed. Only `dry_run`
  // or `disabled` are honored at match time; the on-chain touch happens at
  // withdraw, not here.
  return { ok: true };
}

function createSettlementCoordinator({ db, submitter, complianceEngine, validatorNetwork } = {}) {
  function persistEvent(exec, traceId, eventType, reasonCode, detailsJson) {
    saveSettlementEvent(db, {
      id: crypto.randomUUID(),
      executionId: exec.executionId,
      matchHash: exec.matchHash,
      traceId,
      eventType,
      reasonCode: reasonCode || null,
      detailsJson: detailsJson || {},
      createdAt: Date.now(),
    });
  }

  function getStatus(matchHash) {
    const exec = getSettlementExecutionByMatchHash(db, matchHash);
    if (!exec) return null;
    const events = listSettlementEventsByExecutionId(db, exec.executionId, 200);
    const compliance = listComplianceDecisionsByMatch(db, matchHash, 50);
    const attestations = listAttestationDecisionsByMatch(db, matchHash, 20);
    return {
      execution: exec,
      events,
      latestGateOutcome: {
        compliance: compliance[0] || null,
        attestation: attestations[0] || null,
      },
      complianceDecisions: compliance,
      attestationDecisions: attestations,
    };
  }

  async function start(matchHash, options = {}) {
    const traceId = crypto.randomUUID();
    const policy = normalizePolicy(options.policy || {});
    const now = Date.now();

    let existing = getSettlementExecutionByMatchHash(db, matchHash);
    if (!existing) {
      const seedExec = {
        executionId: crypto.randomUUID(),
        matchHash,
        executionKey: options.executionKey || ethers.ZeroHash,
        status: SETTLEMENT_STATUS.PENDING,
        attemptCount: 0,
        txHash: null,
        traceId,
        fallbackMode: null,
        fallbackReasonCode: null,
        errorCode: null,
        errorMessage: null,
        payloadJson: {},
        createdAt: now,
        updatedAt: now,
        lastAttemptAt: null,
      };
      createSettlementExecutionIfAbsent(db, seedExec);
      existing = getSettlementExecutionByMatchHash(db, matchHash);
    }

    const existingTrace = {
      decisionHash: existing?.payloadJson?.fheBinding?.fheDecisionHash || null,
      takerOrderId: existing?.payloadJson?.takerOrderId || null,
      makerOrderId: existing?.payloadJson?.makerOrderId || null,
    };
    if (!options.forceRetry && (existing.status === SETTLEMENT_STATUS.SUBMITTED || existing.status === SETTLEMENT_STATUS.CONFIRMED)) {
      return {
        traceId,
        matchHash,
        executionKey: existing.executionKey,
        settlementStatus: existing.status,
        txHash: existing.txHash || null,
        decisionReasonCode: "IDEMPOTENT_ALREADY_SUBMITTED",
        idempotent: true,
        ...existingTrace,
      };
    }

    const match = getMatchByHash(db, matchHash);
    if (!match) {
      const updated = {
        ...existing,
        status: SETTLEMENT_STATUS.FAILED,
        traceId,
        errorCode: PRECHECK_REASON.INTERNAL_ERROR,
        errorMessage: "match_not_found",
        updatedAt: now,
      };
      updateSettlementExecution(db, updated);
      persistEvent(updated, traceId, "settlement_failed", PRECHECK_REASON.INTERNAL_ERROR, { message: "match_not_found" });
      return {
        traceId,
        matchHash,
        executionKey: existing.executionKey,
        settlementStatus: updated.status,
        txHash: null,
        decisionReasonCode: PRECHECK_REASON.INTERNAL_ERROR,
        ...existingTrace,
      };
    }

    const fills = listFillsByMatch(db, match.id);
    const payload = buildSettlementPayload(match, fills, policy);
    const traceFields = {
      decisionHash: payload?.fheBinding?.fheDecisionHash || null,
      takerOrderId: payload?.takerOrderId || null,
      makerOrderId: payload?.makerOrderId || null,
    };

    if (complianceEngine) {
      const gate = await complianceEngine.checkExecution({
        traceId,
        executionId: existing.executionId,
        match,
        policy: {
          mode: policy.compliancePolicyMode,
          version: policy.compliancePolicyVersion,
        },
      });
      persistEvent(existing, traceId, "settlement_compliance_gate_evaluated", null, {
        action: gate.action,
        reasonCode: gate.reasonCode,
        drift: !!gate.drift,
        policyVersion: policy.compliancePolicyVersion,
      });
      if (!gate.allowed) {
        const reasonCode = gate.reasonCode || PRECHECK_REASON.COMPLIANCE_ESCALATED;
        const nextStatus = reasonCode === PRECHECK_REASON.COMPLIANCE_HOLD ? SETTLEMENT_STATUS.RETRIABLE : SETTLEMENT_STATUS.FAILED;
        const updated = {
          ...existing,
          executionKey: match.executionKey,
          status: nextStatus,
          traceId,
          errorCode: reasonCode,
          errorMessage: reasonCode,
          payloadJson: {
            ...payload,
            gate: {
              complianceAction: gate.action,
              complianceReasonCode: reasonCode,
              policyVersion: policy.compliancePolicyVersion,
            },
          },
          updatedAt: now,
        };
        updateSettlementExecution(db, updated);
        persistEvent(updated, traceId, "settlement_compliance_gate_blocked", reasonCode, {
          action: gate.action,
          drift: !!gate.drift,
        });
        return {
          traceId,
          matchHash,
          executionKey: match.executionKey,
          settlementStatus: nextStatus,
          txHash: null,
          decisionReasonCode: reasonCode,
          ...traceFields,
        };
      }
    }

    if (policy.requireAttestation) {
      const attestation = payload?.onchain?.attestation || null;
      let verdict = null;
      if (validatorNetwork?.verifyAttestationQuorum) {
        verdict = await validatorNetwork.verifyAttestationQuorum(
          attestation,
          {
            matchHash: payload.matchHash,
            executionKey: payload.executionKey,
            fheDecisionHash: payload?.fheBinding?.fheDecisionHash || "",
          },
          {
            requiredQuorumBps: policy.attestationQuorumBps,
            policyVersion: policy.compliancePolicyVersion,
          }
        );
      } else {
        verdict = {
          valid: false,
          reasonCode: PRECHECK_REASON.ATTESTATION_MISSING,
          requiredQuorumBps: policy.attestationQuorumBps,
          signerCount: 0,
          signerSetHash: null,
        };
      }
      const reasonCode = verdict.valid ? null : (
        verdict.reasonCode === "ATTESTATION_QUORUM_INSUFFICIENT"
          ? PRECHECK_REASON.ATTESTATION_QUORUM_INSUFFICIENT
          : verdict.reasonCode === "ATTESTATION_INVALID"
            ? PRECHECK_REASON.ATTESTATION_INVALID
            : PRECHECK_REASON.ATTESTATION_MISSING
      );
      saveAttestationDecision(db, {
        id: crypto.randomUUID(),
        matchHash,
        executionKey: match.executionKey,
        executionId: existing.executionId,
        traceId,
        policyVersion: policy.compliancePolicyVersion,
        requiredQuorumBps: verdict.requiredQuorumBps || policy.attestationQuorumBps,
        valid: !!verdict.valid,
        reasonCode,
        signerCount: Number(verdict.signerCount || 0),
        signerSetHash: verdict.signerSetHash || null,
        detailsJson: {
          validVotingPowerBps: verdict.validVotingPowerBps ?? null,
        },
        createdAt: Date.now(),
      });
      persistEvent(existing, traceId, "settlement_attestation_gate_evaluated", reasonCode, {
        valid: !!verdict.valid,
        requiredQuorumBps: verdict.requiredQuorumBps || policy.attestationQuorumBps,
        signerCount: verdict.signerCount || 0,
      });
      if (!verdict.valid) {
        const updated = {
          ...existing,
          executionKey: match.executionKey,
          status: SETTLEMENT_STATUS.FAILED,
          traceId,
          errorCode: reasonCode,
          errorMessage: reasonCode,
          payloadJson: {
            ...payload,
            gate: {
              attestationValid: false,
              attestationReasonCode: reasonCode,
              policyVersion: policy.compliancePolicyVersion,
            },
          },
          updatedAt: now,
        };
        updateSettlementExecution(db, updated);
        persistEvent(updated, traceId, "settlement_attestation_gate_blocked", reasonCode, {
          requiredQuorumBps: verdict.requiredQuorumBps || policy.attestationQuorumBps,
          signerCount: verdict.signerCount || 0,
        });
        return {
          traceId,
          matchHash,
          executionKey: match.executionKey,
          settlementStatus: updated.status,
          txHash: null,
          decisionReasonCode: reasonCode,
          ...traceFields,
        };
      }
    }

    const pre = runPrechecks(payload, policy);
    if (!pre.ok) {
      const fallbackConfigured = policy.allowFallback && policy.fallbackMode === "shieldedSwapJoinSplit";
      const nextStatus = fallbackConfigured ? SETTLEMENT_STATUS.RETRIABLE : SETTLEMENT_STATUS.FAILED;
      const nextReason = fallbackConfigured ? PRECHECK_REASON.FALLBACK_ROUTED : pre.reasonCode;
      const updated = {
        ...existing,
        executionKey: match.executionKey,
        status: nextStatus,
        attemptCount: Number(existing.attemptCount || 0),
        traceId,
        fallbackMode: fallbackConfigured ? policy.fallbackMode : null,
        fallbackReasonCode: nextReason,
        errorCode: pre.reasonCode,
        errorMessage: pre.reasonCode,
        payloadJson: payload,
        updatedAt: now,
      };
      updateSettlementExecution(db, updated);
      persistEvent(updated, traceId, "settlement_precheck_failed", pre.reasonCode, { precheck: pre, fallbackConfigured });
      if (fallbackConfigured) {
        persistEvent(updated, traceId, "settlement_fallback_routed", PRECHECK_REASON.FALLBACK_ROUTED, {
          fallbackMode: policy.fallbackMode,
          reasonCode: pre.reasonCode,
        });
      }
      return {
        traceId,
        matchHash,
        executionKey: match.executionKey,
        settlementStatus: nextStatus,
        txHash: null,
        decisionReasonCode: nextReason,
        ...traceFields,
      };
    }

    const attempt = Number(existing.attemptCount || 0) + 1;
    const submitting = {
      ...existing,
      executionKey: match.executionKey,
      status: SETTLEMENT_STATUS.PENDING,
      attemptCount: attempt,
      traceId,
      errorCode: null,
      errorMessage: null,
      payloadJson: payload,
      updatedAt: now,
      lastAttemptAt: now,
    };
    updateSettlementExecution(db, submitting);
    persistEvent(submitting, traceId, "settlement_submit_attempt", null, { attempt });

    try {
      if (policy.submissionMode === "disabled") {
        throw new Error(PRECHECK_REASON.POLICY_NO_SUBMIT);
      }
      const tx = await (submitter || defaultSubmitter)({ payload, match, fills, traceId, attempt, policy });
      const txHash = String(tx?.txHash || ethers.keccak256(ethers.toUtf8Bytes(`${matchHash}:${attempt}`)));
      const submitted = {
        ...submitting,
        status: SETTLEMENT_STATUS.SUBMITTED,
        payloadJson: {
          ...payload,
          onchainResult: tx?.receipt
            ? {
                blockNumber: tx.receipt.blockNumber ?? null,
                status: tx.receipt.status ?? null,
                gasUsed: tx.receipt.gasUsed != null ? String(tx.receipt.gasUsed) : null,
              }
            : null,
        },
        txHash,
        updatedAt: Date.now(),
      };
      updateSettlementExecution(db, submitted);
      persistEvent(submitted, traceId, "settlement_submitted", null, {
        txHash,
        attempt,
        receipt: tx?.receipt || null,
      });
      return {
        traceId,
        matchHash,
        executionKey: match.executionKey,
        settlementStatus: submitted.status,
        txHash,
        decisionReasonCode: null,
        ...traceFields,
      };
    } catch (e) {
      const cls = classifySubmissionError(e);
      const failed = {
        ...submitting,
        status: cls.transient ? SETTLEMENT_STATUS.RETRIABLE : SETTLEMENT_STATUS.FAILED,
        errorCode: cls.reasonCode,
        errorMessage: e?.message || String(e),
        updatedAt: Date.now(),
      };
      updateSettlementExecution(db, failed);
      persistEvent(failed, traceId, "settlement_submit_failed", cls.reasonCode, { message: failed.errorMessage, transient: cls.transient });
      return {
        traceId,
        matchHash,
        executionKey: match.executionKey,
        settlementStatus: failed.status,
        txHash: null,
        decisionReasonCode: cls.reasonCode,
        ...traceFields,
      };
    }
  }

  return {
    SETTLEMENT_STATUS,
    PRECHECK_REASON,
    buildSettlementPayload,
    runPrechecks,
    start,
    retry: async (matchHash, options = {}) => start(matchHash, { ...options, forceRetry: true }),
    getStatus,
  };
}

// Path-B: `createOnchainInternalMatchSubmitter` and the ABI tuple normalisers
// (joinSplitSwapData, signedInternalMatchIntent, decisionArtifact) for the
// removed `internalMatchSettle` entrypoint were stripped in M5. The
// coordinator now only supports off-chain dry-run status tracking; the
// pending-note ledger introduced in M7 will replace this module's settle path
// entirely.

module.exports = {
  createSettlementCoordinator,
  SETTLEMENT_STATUS,
  PRECHECK_REASON,
};
