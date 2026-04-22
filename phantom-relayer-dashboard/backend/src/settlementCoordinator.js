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

function buildSettlementPayload(match, fills, policy) {
  const qty = b(match.quantity);
  const meta = match.metadataJson || {};
  const noteRefs = Array.isArray(meta.noteRefs) ? meta.noteRefs : [];
  const witness = meta.witness || null;

  const inputAmount = qty;
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
    fheBinding: {
      fheDecisionHash: match.fheDecisionHash || null,
      fheResultHash: match.fheResultHash || null,
      fheAttestationRef: match.fheAttestationRef || null,
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
  return { ok: true };
}

function createSettlementCoordinator({ db, submitter } = {}) {
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
    return { execution: exec, events };
  }

  function start(matchHash, options = {}) {
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

    if (!options.forceRetry && (existing.status === SETTLEMENT_STATUS.SUBMITTED || existing.status === SETTLEMENT_STATUS.CONFIRMED)) {
      return {
        traceId,
        matchHash,
        executionKey: existing.executionKey,
        settlementStatus: existing.status,
        txHash: existing.txHash || null,
        decisionReasonCode: "IDEMPOTENT_ALREADY_SUBMITTED",
        idempotent: true,
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
      return { traceId, matchHash, executionKey: existing.executionKey, settlementStatus: updated.status, txHash: null, decisionReasonCode: PRECHECK_REASON.INTERNAL_ERROR };
    }

    const fills = listFillsByMatch(db, match.id);
    const payload = buildSettlementPayload(match, fills, policy);
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
      const tx = (submitter || defaultSubmitter)({ payload, match, fills, traceId, attempt, policy });
      const txHash = String(tx?.txHash || ethers.keccak256(ethers.toUtf8Bytes(`${matchHash}:${attempt}`)));
      const submitted = {
        ...submitting,
        status: SETTLEMENT_STATUS.SUBMITTED,
        txHash,
        updatedAt: Date.now(),
      };
      updateSettlementExecution(db, submitted);
      persistEvent(submitted, traceId, "settlement_submitted", null, { txHash, attempt });
      return {
        traceId,
        matchHash,
        executionKey: match.executionKey,
        settlementStatus: submitted.status,
        txHash,
        decisionReasonCode: null,
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
      };
    }
  }

  return {
    SETTLEMENT_STATUS,
    PRECHECK_REASON,
    buildSettlementPayload,
    runPrechecks,
    start,
    retry: (matchHash, options = {}) => start(matchHash, { ...options, forceRetry: true }),
    getStatus,
  };
}

module.exports = {
  createSettlementCoordinator,
  SETTLEMENT_STATUS,
  PRECHECK_REASON,
};
