const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require("crypto");
const { ethers } = require('ethers');
const {
  getInternalOrderById,
  listInternalOrdersForMatching,
  compareAndSetInternalOrderState,
  saveOrderEvent,
  saveMatch,
  getMatchByHash,
  saveFill,
  listFillsByMatch,
  saveMatchDecision,
  listMatchDecisionsByOrder,
} = require("./db");
const { ORDER_STATUS, assertLegalTransition } = require("./internalOrderLifecycle");
const { decryptJsonAtRest } = require("./noteCipher");
const router = express.Router();

const FHE_MODE_RAW = String(process.env.FHE_MODE || "mock").trim().toLowerCase();
const FHE_MODE = FHE_MODE_RAW === "remote" ? "remote" : "mock";
const FHE_SERVICE_URL = (process.env.FHE_SERVICE_URL || '').replace(/\/$/, '');
const FHE_SERVICE_TIMEOUT_MS = Number(process.env.FHE_SERVICE_TIMEOUT_MS || 30000);
const FHE_REMOTE_CONFIGURED = Boolean(FHE_SERVICE_URL);
const FHE_REMOTE_ENABLED = FHE_MODE === "remote" && FHE_REMOTE_CONFIGURED;
const NODE_ENV = String(process.env.NODE_ENV || "").toLowerCase();
const DEPLOYMENT_TIER = String(process.env.PHANTOM_DEPLOYMENT_TIER || "").trim().toLowerCase();
const FHE_PRODUCTION_MODE = NODE_ENV === "production" || DEPLOYMENT_TIER === "production";

let lastRemoteHealth = {
  checkedAt: 0,
  reachable: false,
  error: null,
};

function isRemoteMode() {
  return FHE_MODE === "remote";
}

function isRemoteConfigured() {
  return FHE_REMOTE_CONFIGURED;
}

function isRemoteEnabled() {
  return FHE_REMOTE_ENABLED;
}

async function fheRemoteFetch(relPath, init) {
  if (!isRemoteEnabled()) return null;
  const url = `${FHE_SERVICE_URL}${relPath.startsWith('/') ? '' : '/'}${relPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FHE_SERVICE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!r.ok) {
      const err = new Error(body?.error || body?.message || `FHE service ${r.status}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function getRemoteHealthSnapshot() {
  if (!isRemoteMode()) {
    return { reachable: false, configured: isRemoteConfigured(), error: null, checkedAt: Date.now() };
  }
  if (!isRemoteConfigured()) {
    return { reachable: false, configured: false, error: "FHE_SERVICE_URL missing", checkedAt: Date.now() };
  }
  const now = Date.now();
  if (now - Number(lastRemoteHealth.checkedAt || 0) < 5000) {
    return { ...lastRemoteHealth, configured: true };
  }
  try {
    await fheRemoteFetch("/health", { method: "GET" });
    lastRemoteHealth = { checkedAt: now, reachable: true, error: null };
  } catch (e) {
    lastRemoteHealth = { checkedAt: now, reachable: false, error: e?.message || "unreachable" };
  }
  return { ...lastRemoteHealth, configured: true };
}

const ORDER_STORE_FILE = process.env.MATCHING_ORDER_STORE || path.join(__dirname, '..', 'data', 'matching-orders.json');
const orderBook = new Map();
const MAX_ORDERS_PER_PAIR = 50;
const DEFAULT_RESERVATION_TTL_MS = Number(process.env.MATCHING_RESERVATION_TTL_MS || 90_000);
const DEFAULT_FHE_POLICY_MODE = String(process.env.MATCHING_FHE_POLICY_MODE || "degraded").toLowerCase();
// M4: degraded fallback is OFF by default now. Production assertion (above)
// still hard-fails if it is left on in production; for dev environments that
// rely on the legacy behaviour, the env var must be explicitly set to "true"
// and the operator will see a boot-time WARNING below.
const DEFAULT_FHE_DEGRADED_ALLOW_UNAVAILABLE =
  String(process.env.MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE || "false").toLowerCase() === "true";

// M4 boot-time advisory warnings. These never block boot in non-production
// (production guardrails are enforced by assertFheProductionSafety + the
// internal-matching guardrails), but they make it obvious when an operator
// has flipped a privacy-relevant lever on.
(function emitFheMatchingStartupWarnings() {
  try {
    if (DEFAULT_FHE_DEGRADED_ALLOW_UNAVAILABLE) {
      console.warn(
        "[fheMatchingService] WARNING: MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE=true — degraded fallback permits matches without a fresh FHE attestation. Set to 'false' for production-equivalent safety."
      );
    }
    const expectedSignerRaw = String(process.env.EXPECTED_FHE_ATTESTATION_SIGNER || "").trim();
    if (!expectedSignerRaw) {
      const strict = DEFAULT_FHE_POLICY_MODE === "strict" || FHE_PRODUCTION_MODE;
      const msg =
        "[fheMatchingService] EXPECTED_FHE_ATTESTATION_SIGNER is not configured — verifyFheAttestation will reject every match in strict mode and only verify the signature shape elsewhere.";
      if (strict) console.warn(msg);
    }
    // Deprecation notice — v1 canonical (with plaintext execAmount/execPrice)
    // is accepted for one release as a fallback so a TenSEAL-style service can
    // still drive the dev compare path. v2 canonical (execAmountCiphertextHash
    // + execPriceCiphertextHash) is the supported shape going forward.
    console.warn(
      "[fheMatchingService] NOTICE: 'phantom-fhe-attestation/v1' canonical (plaintext execAmount/execPrice) is DEPRECATED. Use 'phantom-fhe-attestation/v2' (execAmountCiphertextHash / execPriceCiphertextHash). v1 will be removed after the next release."
    );
  } catch (_) {
    /* never block boot on warnings */
  }
})();
let matchingContext = {
  db: null,
  reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
  fhePolicyMode: DEFAULT_FHE_POLICY_MODE === "strict" ? "strict" : "degraded",
  degradedAllowUnavailable: DEFAULT_FHE_DEGRADED_ALLOW_UNAVAILABLE,
  fheCompatibilityEvaluator: null,
  internalMatchCompareEvaluator: null,
};
let jsonFallbackLock = Promise.resolve();

const REASON_CODES = Object.freeze({
  PRICE_MISMATCH: "PRICE_MISMATCH",
  SIZE_MISMATCH: "SIZE_MISMATCH",
  FHE_REJECTED: "FHE_REJECTED",
  FHE_UNAVAILABLE: "FHE_UNAVAILABLE",
  POLICY_BLOCKED: "POLICY_BLOCKED",
  POLICY_DEGRADED_ALLOW: "POLICY_DEGRADED_ALLOW",
  NO_COMPATIBLE_COUNTERPARTY: "NO_COMPATIBLE_COUNTERPARTY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

function deriveFheSecurityPolicy(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "").toLowerCase();
  const tier = String(env.PHANTOM_DEPLOYMENT_TIER || "").trim().toLowerCase();
  const production = nodeEnv === "production" || tier === "production";
  const modeRaw = String(env.FHE_MODE || "mock").trim().toLowerCase();
  const mode = modeRaw === "remote" ? "remote" : "mock";
  const serviceUrlConfigured = Boolean(String(env.FHE_SERVICE_URL || "").trim());
  const policyMode = String(env.MATCHING_FHE_POLICY_MODE || "degraded").trim().toLowerCase() === "strict"
    ? "strict"
    : "degraded";
  const degradedAllowUnavailable = String(env.MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE || "").toLowerCase() !== "false";
  return { production, mode, serviceUrlConfigured, policyMode, degradedAllowUnavailable };
}

function assertFheProductionSafety(policy = deriveFheSecurityPolicy()) {
  if (!policy.production) return;
  if (policy.mode !== "remote") {
    throw new Error("Production startup blocked: FHE_MODE must be 'remote' (mock is forbidden).");
  }
  if (!policy.serviceUrlConfigured) {
    throw new Error("Production startup blocked: FHE_SERVICE_URL is required for remote FHE.");
  }
  if (policy.policyMode !== "strict") {
    throw new Error("Production startup blocked: MATCHING_FHE_POLICY_MODE must be 'strict'.");
  }
  if (policy.degradedAllowUnavailable) {
    throw new Error("Production startup blocked: MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE must be false.");
  }
}
assertFheProductionSafety();

function orderBookKey(inputAssetID, outputAssetID) {
  return `${Number(inputAssetID)}-${Number(outputAssetID)}`;
}

function normalizeFheOrder(order) {
  if (!order || order.inputAssetID === undefined || order.outputAssetID === undefined) return null;
  const inputAssetID = Number(order.inputAssetID);
  const outputAssetID = Number(order.outputAssetID);
  if (!Number.isFinite(inputAssetID) || !Number.isFinite(outputAssetID)) return null;
  return {
    ...order,
    inputAssetID,
    outputAssetID,
    fheEncryptedInputAmount: order.fheEncryptedInputAmount,
    fheEncryptedMinOutput: order.fheEncryptedMinOutput,
  };
}

function normalizeBigIntString(v) {
  return BigInt(v == null ? "0" : String(v)).toString();
}

function computeStableMatchHash(payload) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        pairBase: payload.pairBase,
        pairQuote: payload.pairQuote,
        makerOrderId: payload.makerOrderId,
        takerOrderId: payload.takerOrderId,
        quantity: payload.quantity,
        executionPrice: payload.executionPrice,
      })
    )
  );
}

function computeFheResultHash(result) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        compatible: Boolean(result?.compatible),
        availability: String(result?.availability || "unknown"),
        code: String(result?.code || ""),
        attestationRef: String(result?.attestationRef || ""),
      })
    )
  );
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

function buildCanonicalMatchDecisionArtifact({
  traceId,
  taker,
  maker,
  matchHash,
  executionKey,
  policy,
  decisionReasonCode,
  fheResultHash,
  fheAttestationRef,
  fheAttestationSignature,
  fheAttestationPayloadHash,
  decidedAtMs = Date.now(),
  decisionNonce = null,
  decisionDomain = null,
}) {
  const artifact = {
    schema: "phantom.match.decision.v1",
    domain: {
      protocol: "phantom-internal-matching",
      chainId: Number(process.env.CHAIN_ID || 97),
      verifyingContract: String(process.env.SHIELDED_POOL_ADDRESS || ethers.ZeroAddress),
      engine: "fheMatchingService",
      engineMode: FHE_MODE,
      decisionDomain: decisionDomain ? String(decisionDomain) : "default",
    },
    orders: {
      taker: {
        orderId: String(taker?.id || ""),
        side: String(taker?.side || ""),
        pairBase: String(taker?.pairBase || ""),
        pairQuote: String(taker?.pairQuote || ""),
        nonce: String(taker?.nonce || ""),
        replayKey: String(taker?.replayKey || ""),
      },
      maker: {
        orderId: String(maker?.id || ""),
        side: String(maker?.side || ""),
        pairBase: String(maker?.pairBase || ""),
        pairQuote: String(maker?.pairQuote || ""),
        nonce: String(maker?.nonce || ""),
        replayKey: String(maker?.replayKey || ""),
      },
    },
    constraints: {
      pair: `${String(taker?.pairBase || "")}/${String(taker?.pairQuote || "")}`,
      takerSide: String(taker?.side || ""),
      makerSide: String(maker?.side || ""),
      priceCompatible: true,
      policyMode: String(policy?.mode || "degraded"),
      degradedAllowUnavailable: Boolean(policy?.degradedAllowUnavailable),
    },
    timing: {
      traceId: String(traceId || ""),
      decidedAtMs: Number(decidedAtMs || Date.now()),
      decisionNonce: decisionNonce != null ? String(decisionNonce) : `${String(taker?.nonce || "")}:${String(maker?.nonce || "")}:${String(traceId || "")}`,
    },
    result: {
      decision: "match_approved",
      reasonCode: String(decisionReasonCode || "FHE_ACCEPTED"),
      fheResultHash: String(fheResultHash || ""),
    },
    attestation: {
      reference: fheAttestationRef ? String(fheAttestationRef) : null,
      signature: fheAttestationSignature ? String(fheAttestationSignature) : null,
      payloadHash: fheAttestationPayloadHash ? String(fheAttestationPayloadHash) : null,
    },
    bindings: {
      matchHash: String(matchHash || ""),
      executionKey: String(executionKey || ""),
    },
  };
  return { artifact, decisionHash: hashDecisionArtifact(artifact) };
}

function computeFheDecisionHash(payload) {
  if (payload?.decisionArtifact && typeof payload.decisionArtifact === "object") {
    return hashDecisionArtifact(payload.decisionArtifact);
  }
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify({
        matchHash: payload.matchHash ?? null,
        executionKey: payload.executionKey ?? null,
        policyMode: payload.policyMode,
        degradedAllowUnavailable: Boolean(payload.degradedAllowUnavailable),
        reasonCode: payload.reasonCode,
        fheResultHash: payload.fheResultHash ?? null,
        fheAttestationRef: payload.fheAttestationRef ?? null,
      })
    )
  );
}

function parseNum(v, fallback = 0n) {
  try {
    return BigInt(String(v));
  } catch {
    return fallback;
  }
}

function sortByTimeNonceIdAsc(a, b) {
  if (Number(a.createdAt || 0) !== Number(b.createdAt || 0)) return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  const an = parseNum(a.nonce, 0n);
  const bn = parseNum(b.nonce, 0n);
  if (an !== bn) return an < bn ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

function isPriceCompatible(taker, maker) {
  const takerPrice = parseNum(taker.limitPrice, 0n);
  const makerPrice = parseNum(maker.limitPrice, 0n);
  if (String(taker.side) === "buy") return takerPrice >= makerPrice;
  return makerPrice >= takerPrice;
}

function getExecutionPrice(taker, maker) {
  return normalizeBigIntString(maker.limitPrice);
}

function toPairKey(order) {
  return `${String(order.pairBase)}::${String(order.pairQuote)}`;
}

function isOrderLiveForMatch(order, nowSec) {
  if (!order) return false;
  if (order.status !== ORDER_STATUS.OPEN && order.status !== ORDER_STATUS.PARTIALLY_FILLED) return false;
  if (parseNum(order.remainingAmount, 0n) <= 0n) return false;
  if (Number(order.expiryTs || 0) <= Number(nowSec)) return false;
  return true;
}

async function withJsonLock(task) {
  const prev = jsonFallbackLock;
  let release;
  jsonFallbackLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await task();
  } finally {
    release();
  }
}

function configureMatchingEngine(opts = {}) {
  const nextPolicyMode = String(opts.fhePolicyMode || DEFAULT_FHE_POLICY_MODE).toLowerCase() === "strict"
    ? "strict"
    : "degraded";
  const nextDegradedAllowUnavailable = typeof opts.degradedAllowUnavailable === "boolean"
    ? opts.degradedAllowUnavailable
    : DEFAULT_FHE_DEGRADED_ALLOW_UNAVAILABLE;
  if (FHE_PRODUCTION_MODE && (nextPolicyMode !== "strict" || nextDegradedAllowUnavailable)) {
    throw new Error("Production matching engine requires strict policy and degraded fallback disabled.");
  }
  matchingContext = {
    db: opts.db || null,
    reservationTtlMs: Number(opts.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS),
    fhePolicyMode: nextPolicyMode,
    degradedAllowUnavailable: nextDegradedAllowUnavailable,
    fheCompatibilityEvaluator: typeof opts.fheCompatibilityEvaluator === "function" ? opts.fheCompatibilityEvaluator : null,
    internalMatchCompareEvaluator:
      typeof opts.internalMatchCompareEvaluator === "function" ? opts.internalMatchCompareEvaluator : null,
  };
}

function getDb() {
  return matchingContext.db || null;
}

function getFhePolicy() {
  return {
    mode: matchingContext.fhePolicyMode,
    degradedAllowUnavailable: Boolean(matchingContext.degradedAllowUnavailable),
  };
}

function computeExecutionKey(orderA, orderB) {
  const [left, right] = [String(orderA.id), String(orderB.id)].sort();
  return ethers.keccak256(ethers.toUtf8Bytes(`${left}:${right}`));
}

function buildCounterpartyComparator(taker) {
  const takerIsBuy = String(taker.side) === "buy";
  return (a, b) => {
    const ap = parseNum(a.limitPrice, 0n);
    const bp = parseNum(b.limitPrice, 0n);
    if (ap !== bp) {
      if (takerIsBuy) return ap < bp ? -1 : 1; // lower asks first
      return ap > bp ? -1 : 1; // higher bids first
    }
    return sortByTimeNonceIdAsc(a, b);
  };
}

function selectBestCounterparty(taker, allOrders, nowSec) {
  const takerPair = toPairKey(taker);
  const oppositeSide = String(taker.side) === "buy" ? "sell" : "buy";
  const candidates = allOrders
    .filter((o) =>
      o.id !== taker.id &&
      toPairKey(o) === takerPair &&
      String(o.side) === oppositeSide &&
      isOrderLiveForMatch(o, nowSec) &&
      isPriceCompatible(taker, o)
    )
    .sort(buildCounterpartyComparator(taker));
  return candidates[0] || null;
}

function logStructuredDecision(payload) {
  try {
    console.log("[matching.decision]", JSON.stringify(payload));
  } catch {
    console.log("[matching.decision]", payload);
  }
}

function persistDecision(db, row) {
  saveMatchDecision(db, {
    id: crypto.randomUUID(),
    traceId: row.traceId,
    takerOrderId: row.takerOrderId,
    candidateOrderId: row.candidateOrderId ?? null,
    matchHash: row.matchHash ?? null,
    executionKey: row.executionKey ?? null,
    reasonCode: row.reasonCode,
    policyMode: row.policyMode,
    fheDecisionHash: row.fheDecisionHash ?? null,
    fheResultHash: row.fheResultHash ?? null,
    fheAttestationRef: row.fheAttestationRef ?? null,
    detailsJson: row.detailsJson || {},
    createdAt: Date.now(),
  });
}

function derivePostFillState(order, fillQty, executionKey, actor) {
  const remainingBefore = parseNum(order.remainingAmount, 0n);
  const filledBefore = parseNum(order.filledAmount, 0n);
  const nextRemaining = remainingBefore - fillQty;
  const nextFilled = filledBefore + fillQty;
  const toStatus = nextRemaining <= 0n ? ORDER_STATUS.FILLED : ORDER_STATUS.PARTIALLY_FILLED;
  return {
    id: order.id,
    status: toStatus,
    remainingAmount: nextRemaining < 0n ? "0" : nextRemaining.toString(),
    filledAmount: nextFilled.toString(),
    reservedAmount: "0",
    matchRef: executionKey,
    updatedBy: actor,
    updatedAt: Date.now(),
  };
}

function reserveOrder(db, order, quantity, executionKey, actor) {
  assertLegalTransition(order.status, ORDER_STATUS.RESERVED);
  const now = Date.now();
  const reservedRow = {
    id: order.id,
    status: ORDER_STATUS.RESERVED,
    remainingAmount: normalizeBigIntString(order.remainingAmount),
    filledAmount: normalizeBigIntString(order.filledAmount),
    reservedAmount: normalizeBigIntString(quantity),
    matchRef: executionKey,
    updatedBy: actor,
    updatedAt: now,
    fromStatuses: [order.status],
  };
  const ok = compareAndSetInternalOrderState(db, reservedRow);
  if (!ok) return false;
  saveOrderEvent(db, {
    id: crypto.randomUUID(),
    orderId: order.id,
    eventType: "order_reserved",
    fromStatus: order.status,
    toStatus: ORDER_STATUS.RESERVED,
    reason: "deterministic_match_reservation",
    actor,
    metadataJson: { executionKey, reservedAmount: String(quantity) },
    createdAt: now,
  });
  return true;
}

function releaseReservation(db, reservedOrder, restoreStatus, executionKey, actor, reason) {
  const now = Date.now();
  const ok = compareAndSetInternalOrderState(db, {
    id: reservedOrder.id,
    status: restoreStatus,
    remainingAmount: normalizeBigIntString(reservedOrder.remainingAmount),
    filledAmount: normalizeBigIntString(reservedOrder.filledAmount),
    reservedAmount: "0",
    matchRef: null,
    updatedBy: actor,
    updatedAt: now,
    fromStatuses: [ORDER_STATUS.RESERVED],
  });
  if (!ok) return false;
  saveOrderEvent(db, {
    id: crypto.randomUUID(),
    orderId: reservedOrder.id,
    eventType: "order_unreserved",
    fromStatus: ORDER_STATUS.RESERVED,
    toStatus: restoreStatus,
    reason: reason || "reservation_released",
    actor,
    metadataJson: { executionKey },
    createdAt: now,
  });
  return true;
}

function persistMatchAndFills(db, payload) {
  const existing = getMatchByHash(db, payload.matchHash);
  if (existing) {
    return {
      idempotent: true,
      match: existing,
      fills: listFillsByMatch(db, existing.id),
    };
  }

  const now = Date.now();
  const matchId = crypto.randomUUID();
  saveMatch(db, {
    id: matchId,
    matchHash: payload.matchHash,
    executionKey: payload.executionKey,
    pairBase: payload.pairBase,
    pairQuote: payload.pairQuote,
    makerOrderId: payload.maker.id,
    takerOrderId: payload.taker.id,
    makerSide: payload.maker.side,
    takerSide: payload.taker.side,
    executionPrice: payload.executionPrice,
    quantity: payload.quantity.toString(),
    status: "finalized",
    decisionReasonCode: payload.decisionReasonCode ?? null,
    fheResultHash: payload.fheResultHash ?? null,
    fheDecisionHash: payload.fheDecisionHash ?? null,
    fheAttestationRef: payload.fheAttestationRef ?? null,
    metadataJson: {
      reason: "price_time_priority_match",
      finalDecisionReasonCode: payload.decisionReasonCode ?? null,
      makerRemainingBefore: payload.maker.remainingAmount,
      takerRemainingBefore: payload.taker.remainingAmount,
      decisionArtifact: payload.decisionArtifact || null,
      fheAttestation: payload.fheAttestation || null,
      onchain: {
        internalMatchData: {
          decisionHash: payload.fheDecisionHash || null,
          matchHash: payload.matchHash,
          executionKey: payload.executionKey,
          makerSignedIntent: payload.makerSignedIntent || null,
          takerSignedIntent: payload.takerSignedIntent || null,
        },
      },
    },
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: payload.maker.id,
    side: payload.maker.side,
    quantity: payload.quantity.toString(),
    price: payload.executionPrice,
    isMaker: true,
    createdAt: now,
  });
  saveFill(db, {
    id: crypto.randomUUID(),
    matchId,
    orderId: payload.taker.id,
    side: payload.taker.side,
    quantity: payload.quantity.toString(),
    price: payload.executionPrice,
    isMaker: false,
    createdAt: now,
  });
  return {
    idempotent: false,
    match: getMatchByHash(db, payload.matchHash),
    fills: listFillsByMatch(db, matchId),
  };
}

// ---------- Phase 4: real FHE compare + signed user intent persistence ----------
//
// When both orders carry an EIP-712 InternalMatchIntent (Phase 2) and the FHE
// service is reachable, the matching service prefers the new
// `/internal-match/compare` endpoint introduced in Phase 3. The endpoint
// returns a signed match attestation; this module verifies the signature,
// optionally checks it against EXPECTED_FHE_ATTESTATION_SIGNER, and persists
// the user signed intents + attestation alongside the match so that the
// settlement coordinator's `onchainSubmitter` can feed them into
// `internalMatchSettle` (Phase 1 contract).

function getExpectedFheAttestationSigner() {
  const v = String(process.env.EXPECTED_FHE_ATTESTATION_SIGNER || "").trim();
  if (!v) return null;
  try {
    return ethers.getAddress(v);
  } catch {
    return null;
  }
}

// ─── M4: canonical version negotiation ───────────────────────────────────
//
// M0+M1+M2 introduced the v2 canonical produced by tfhe-matching-service.
// The v2 shape replaces the v1 plaintext `execAmount`/`execPrice` fields
// with `execAmountCiphertextHash`/`execPriceCiphertextHash` — the matching
// service never exfiltrates plaintext exec values.
//
// For one release we still accept v1 so a TenSEAL-style service can drive
// the dev compare path. v1 will be removed after the next release.
const CANONICAL_DOMAIN_V1 = "phantom-fhe-attestation/v1";
const CANONICAL_DOMAIN_V2 = "phantom-fhe-attestation/v2";
const SUPPORTED_CANONICAL_DOMAINS = new Set([CANONICAL_DOMAIN_V1, CANONICAL_DOMAIN_V2]);

const REQUIRED_V2_FIELDS = [
  "v",
  "matched",
  "makerCiphertextHash",
  "takerCiphertextHash",
  "makerUser",
  "takerUser",
  "makerNonce",
  "takerNonce",
  "inputAssetID",
  "outputAssetID",
  "execAmountCiphertextHash",
  "execPriceCiphertextHash",
  "ts",
];

// v2 canonicals MUST NOT carry plaintext exec amount / exec price; this is
// the privacy contract the FHE service signs against. If a tampered service
// ships a v2 canonical with a plaintext field, refuse it explicitly.
const PLAINTEXT_EXEC_FIELDS_FORBIDDEN_IN_V2 = ["execAmount", "execPrice"];

function detectCanonicalDomain(canonical) {
  if (!canonical || typeof canonical !== "object") return null;
  const v = typeof canonical.v === "string" ? canonical.v : null;
  if (!v) return null;
  return SUPPORTED_CANONICAL_DOMAINS.has(v) ? v : null;
}

function validateCanonicalShape(canonical, domain) {
  if (domain === CANONICAL_DOMAIN_V2) {
    for (const k of REQUIRED_V2_FIELDS) {
      if (canonical[k] == null) return `v2_missing_field:${k}`;
    }
    for (const k of PLAINTEXT_EXEC_FIELDS_FORBIDDEN_IN_V2) {
      if (canonical[k] != null) return `v2_plaintext_exec_field_forbidden:${k}`;
    }
    return null;
  }
  // v1 — accepted but deprecated; we only require enough fields for the
  // decisionHash to be reproducible. The plaintext exec fields are a known
  // v1 leak — see the deprecation warning above.
  return null;
}

function safeDecryptOrderEnvelope(order) {
  try {
    if (!order?.encryptedPayload) return null;
    return decryptJsonAtRest(order.encryptedPayload);
  } catch (e) {
    return { _decryptError: e?.message || String(e) };
  }
}

function extractMatchIntentBundle(order) {
  const normalized = order?.normalizedPayload || {};
  const intent = normalized?.matchIntent?.intent || null;
  if (!intent) return null;
  const envelope = safeDecryptOrderEnvelope(order) || {};
  const ciphertext = envelope?.matchIntent?.ciphertext ?? null;
  const signature =
    envelope?.matchIntent?.signature ?? normalized?.matchIntent?.signature ?? null;
  if (!ciphertext || !signature) return null;
  return { intent, ciphertext, signature };
}

function verifyFheAttestation(attestation, opts = {}) {
  if (!attestation || typeof attestation !== "object") {
    return { valid: false, reason: "attestation_missing" };
  }
  const { decisionHash, signature, signerAddress, canonical } = attestation;
  if (!decisionHash || !signature) {
    return { valid: false, reason: "attestation_fields_missing" };
  }

  // ── Canonical shape gating (M4): when a `canonical` blob is provided we
  // identify its version, enforce the v2 privacy contract (no plaintext
  // execAmount/execPrice), and recompute the decisionHash. v1 is still
  // accepted for one release with a deprecation warning emitted at module
  // init.
  let domain = null;
  if (canonical && typeof canonical === "object") {
    domain = detectCanonicalDomain(canonical);
    if (canonical.v != null && !domain) {
      return { valid: false, reason: "canonical_domain_unsupported", canonicalDomain: String(canonical.v) };
    }
    const shapeErr = validateCanonicalShape(canonical, domain);
    if (shapeErr) {
      return { valid: false, reason: shapeErr, canonicalDomain: domain };
    }
    const recomputed = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
    if (recomputed.toLowerCase() !== String(decisionHash).toLowerCase()) {
      return { valid: false, reason: "decision_hash_canonical_mismatch", recomputed, canonicalDomain: domain };
    }
  }

  let recovered;
  try {
    recovered = ethers.recoverAddress(decisionHash, signature);
  } catch (e) {
    return { valid: false, reason: "signature_recover_failed", error: e?.message || String(e), canonicalDomain: domain };
  }
  if (signerAddress) {
    try {
      const expected = ethers.getAddress(signerAddress);
      if (expected.toLowerCase() !== recovered.toLowerCase()) {
        return { valid: false, reason: "claimed_signer_mismatch", recovered, claimed: expected, canonicalDomain: domain };
      }
    } catch {
      return { valid: false, reason: "claimed_signer_invalid", recovered, canonicalDomain: domain };
    }
  }

  const expectedSigner = getExpectedFheAttestationSigner();
  const strictMode =
    typeof opts.strictExpectedSigner === "boolean"
      ? opts.strictExpectedSigner
      : (matchingContext.fhePolicyMode === "strict" || FHE_PRODUCTION_MODE);

  if (!expectedSigner && strictMode) {
    // M4: strict mode forbids the permissive fallback that previously let any
    // signature recover-only pass when EXPECTED_FHE_ATTESTATION_SIGNER was
    // unset. Production must pin the expected signer.
    return {
      valid: false,
      reason: "expected_signer_unconfigured_in_strict_mode",
      recovered,
      canonicalDomain: domain,
    };
  }
  if (expectedSigner && expectedSigner.toLowerCase() !== recovered.toLowerCase()) {
    return { valid: false, reason: "unexpected_signer", recovered, expected: expectedSigner, canonicalDomain: domain };
  }

  return { valid: true, recovered, canonicalDomain: domain };
}

async function evaluateInternalMatchCompare(taker, maker, traceId) {
  if (typeof matchingContext.internalMatchCompareEvaluator === "function") {
    try {
      const out = await matchingContext.internalMatchCompareEvaluator({ taker, maker, traceId });
      return out;
    } catch (e) {
      return {
        availability: "unavailable",
        compatible: false,
        code: "evaluator_error",
        attestationRef: null,
        error: e?.message || String(e),
      };
    }
  }

  const takerBundle = extractMatchIntentBundle(taker);
  const makerBundle = extractMatchIntentBundle(maker);
  if (!takerBundle || !makerBundle) {
    return null; // signal caller to fall back to legacy /compatibility path
  }
  if (!isRemoteEnabled()) {
    return { availability: "unavailable", compatible: false, code: "service_not_configured", attestationRef: null };
  }

  let body;
  try {
    body = await fheRemoteFetch("/internal-match/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traceId,
        maker: { intent: makerBundle.intent, ciphertext: makerBundle.ciphertext, signature: makerBundle.signature },
        taker: { intent: takerBundle.intent, ciphertext: takerBundle.ciphertext, signature: takerBundle.signature },
        context: { matchTraceId: traceId },
      }),
    });
  } catch (e) {
    return {
      availability: "unavailable",
      compatible: false,
      code: e?.name === "AbortError" ? "timeout" : "remote_error",
      attestationRef: null,
      error: e?.message || String(e),
    };
  }

  const matched = Boolean(body?.matched);
  const attestation = body?.attestation || null;
  const verification = matched ? verifyFheAttestation(attestation) : { valid: !attestation || true };
  // Derive decisionDomain from the actual canonical version (M4 v1+v2 path).
  const decisionDomain =
    detectCanonicalDomain(attestation?.canonical) ||
    (typeof attestation?.canonical?.v === "string" ? attestation.canonical.v : CANONICAL_DOMAIN_V2);
  if (matched && !verification.valid) {
    return {
      availability: "available",
      compatible: false,
      code: `attestation_invalid:${verification.reason || "unknown"}`,
      attestationRef: attestation?.decisionHash || null,
      attestationSignature: attestation?.signature || null,
      attestationPayloadHash: attestation?.decisionHash || null,
      decisionDomain,
      error: verification.error || verification.reason || "attestation_invalid",
      verifiedSigner: verification.recovered || null,
      fheCanonical: attestation?.canonical || null,
      fheResult: body?.result || null,
      makerSignedIntent: { intent: makerBundle.intent, signature: makerBundle.signature },
      takerSignedIntent: { intent: takerBundle.intent, signature: takerBundle.signature },
    };
  }
  return {
    availability: "available",
    compatible: matched,
    code: matched ? "fhe_compare_match" : `fhe_compare_${body?.reason || "no_match"}`,
    attestationRef: attestation?.decisionHash || null,
    attestationSignature: attestation?.signature || null,
    attestationPayloadHash: attestation?.decisionHash || null,
    decisionDomain,
    decisionNonce: attestation?.canonical?.ts || null,
    verifiedSigner: matched ? verification.recovered : null,
    fheCanonical: attestation?.canonical || null,
    fheResult: body?.result || null,
    makerSignedIntent: { intent: makerBundle.intent, signature: makerBundle.signature },
    takerSignedIntent: { intent: takerBundle.intent, signature: takerBundle.signature },
  };
}

// M4: privacy filter applied AT THE PERSISTENCE BOUNDARY. The v2 canonical
// contract is that the FHE service never returns plaintext exec amount /
// price — only ciphertext bundles + their hashes. We strip any stray
// plaintext-looking fields here as defense-in-depth before the result is
// embedded in the match metadata that lands in the DB. The v1 canonical
// itself still carries execAmount/execPrice as plaintext (known v1 leak,
// see deprecation notice above); for v1 the leak is sealed inside
// `canonical` and cannot be redacted without breaking the signature, so we
// document the limitation rather than mutate.
const PLAINTEXT_EXEC_KEYS = new Set([
  "execAmount",
  "execAmountPlain",
  "execAmountPlaintext",
  "execPrice",
  "execPricePlain",
  "execPricePlaintext",
]);

function stripPlaintextExecFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PLAINTEXT_EXEC_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function sanitizeMatchAttestationForPersistence(attestation) {
  if (!attestation || typeof attestation !== "object") return attestation;
  const out = { ...attestation };
  if (out.result) out.result = stripPlaintextExecFields(out.result);
  // The canonical is sealed by the signature — DO NOT mutate. The v2 shape
  // gate above already rejects v2 canonicals that try to smuggle plaintext.
  return out;
}

async function evaluateFheCompatibility(taker, maker, traceId) {
  if (typeof matchingContext.fheCompatibilityEvaluator === "function") {
    try {
      const out = await matchingContext.fheCompatibilityEvaluator({ taker, maker, candidate: maker, traceId });
      return {
        availability: "available",
        compatible: Boolean(out?.compatible),
        code: String(out?.code || (out?.compatible ? "ok" : "reject")),
        attestationRef: out?.attestationRef ? String(out.attestationRef) : null,
        attestationSignature: out?.attestationSignature ? String(out.attestationSignature) : null,
        attestationPayloadHash: out?.attestationPayloadHash ? String(out.attestationPayloadHash) : null,
        decisionNonce: out?.decisionNonce != null ? String(out.decisionNonce) : null,
        decisionDomain: out?.decisionDomain ? String(out.decisionDomain) : null,
      };
    } catch (e) {
      return { availability: "unavailable", compatible: false, code: "evaluator_error", attestationRef: null, error: e?.message || String(e) };
    }
  }

  if (!isRemoteEnabled()) {
    return { availability: "unavailable", compatible: false, code: "service_not_configured", attestationRef: null };
  }

  try {
    const body = await fheRemoteFetch("/compatibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traceId,
        taker: {
          orderId: taker.id,
          side: taker.side,
          pairBase: taker.pairBase,
          pairQuote: taker.pairQuote,
          remainingAmount: taker.remainingAmount,
          limitPrice: taker.limitPrice,
        },
        candidate: {
          orderId: maker.id,
          side: maker.side,
          pairBase: maker.pairBase,
          pairQuote: maker.pairQuote,
          remainingAmount: maker.remainingAmount,
          limitPrice: maker.limitPrice,
        },
      }),
    });
    return {
      availability: "available",
      compatible: Boolean(body?.compatible),
      code: String(body?.code || (body?.compatible ? "ok" : "reject")),
      attestationRef: body?.attestationRef ? String(body.attestationRef) : null,
      attestationSignature: body?.attestationSignature ? String(body.attestationSignature) : null,
      attestationPayloadHash: body?.attestationPayloadHash ? String(body.attestationPayloadHash) : null,
      decisionNonce: body?.decisionNonce != null ? String(body.decisionNonce) : null,
      decisionDomain: body?.decisionDomain ? String(body.decisionDomain) : null,
    };
  } catch (e) {
    return {
      availability: "unavailable",
      compatible: false,
      code: e?.name === "AbortError" ? "timeout" : "remote_error",
      attestationRef: null,
      error: e?.message || String(e),
    };
  }
}

function recordCandidateRejection(db, payload) {
  persistDecision(db, {
    traceId: payload.traceId,
    takerOrderId: payload.taker.id,
    candidateOrderId: payload.candidate?.id || null,
    reasonCode: payload.reasonCode,
    policyMode: payload.policy.mode,
    fheDecisionHash: payload.fheDecisionHash ?? null,
    fheResultHash: payload.fheResultHash ?? null,
    fheAttestationRef: payload.fheAttestationRef ?? null,
    detailsJson: payload.detailsJson || {},
  });
  logStructuredDecision({
    traceId: payload.traceId,
    workerId: payload.workerId,
    takerOrderId: payload.taker.id,
    candidateOrderId: payload.candidate?.id || null,
    reasonCode: payload.reasonCode,
    policyMode: payload.policy.mode,
    details: payload.detailsJson || {},
  });
}

async function pickBestCompatibleCounterparty(db, taker, allOrders, nowSec, policy, traceId, workerId) {
  const takerPair = toPairKey(taker);
  const oppositeSide = String(taker.side) === "buy" ? "sell" : "buy";
  const candidates = allOrders
    .filter((o) => o.id !== taker.id && toPairKey(o) === takerPair && String(o.side) === oppositeSide && isOrderLiveForMatch(o, nowSec))
    .sort(buildCounterpartyComparator(taker));

  for (const candidate of candidates) {
    const candidateQty = parseNum(candidate.remainingAmount, 0n);
    if (candidateQty <= 0n) {
      recordCandidateRejection(db, {
        traceId, workerId, taker, candidate, policy,
        reasonCode: REASON_CODES.SIZE_MISMATCH,
        detailsJson: { candidateRemainingAmount: String(candidate.remainingAmount) },
      });
      continue;
    }
    if (!isPriceCompatible(taker, candidate)) {
      recordCandidateRejection(db, {
        traceId, workerId, taker, candidate, policy,
        reasonCode: REASON_CODES.PRICE_MISMATCH,
        detailsJson: { takerLimitPrice: taker.limitPrice, candidateLimitPrice: candidate.limitPrice },
      });
      continue;
    }

    let fhe = await evaluateInternalMatchCompare(taker, candidate, traceId);
    if (fhe == null) {
      fhe = await evaluateFheCompatibility(taker, candidate, traceId);
    }
    const fheResultHash = computeFheResultHash(fhe);
    const unavailable = fhe.availability !== "available";
    if (unavailable) {
      if (policy.mode === "strict" || !policy.degradedAllowUnavailable) {
        const decisionReason = policy.mode === "strict" ? REASON_CODES.FHE_UNAVAILABLE : REASON_CODES.POLICY_BLOCKED;
        const fheDecisionHash = computeFheDecisionHash({
          policyMode: policy.mode,
          degradedAllowUnavailable: policy.degradedAllowUnavailable,
          reasonCode: decisionReason,
          fheResultHash,
          fheAttestationRef: fhe.attestationRef,
        });
        recordCandidateRejection(db, {
          traceId, workerId, taker, candidate, policy,
          reasonCode: decisionReason,
          fheDecisionHash,
          fheResultHash,
          fheAttestationRef: fhe.attestationRef,
          detailsJson: { fheCode: fhe.code, fheError: fhe.error || null, policyBlocked: true },
        });
        continue;
      }
      const decisionReason = REASON_CODES.POLICY_DEGRADED_ALLOW;
      const fheDecisionHash = computeFheDecisionHash({
        policyMode: policy.mode,
        degradedAllowUnavailable: policy.degradedAllowUnavailable,
        reasonCode: decisionReason,
        fheResultHash,
        fheAttestationRef: fhe.attestationRef,
      });
      return {
        candidate,
        decisionReasonCode: decisionReason,
        fheResultHash,
        fheDecisionHash,
        fheAttestationRef: fhe.attestationRef,
        fheDetails: fhe,
      };
    }

    if (!fhe.compatible) {
      const decisionReason = REASON_CODES.FHE_REJECTED;
      const fheDecisionHash = computeFheDecisionHash({
        policyMode: policy.mode,
        degradedAllowUnavailable: policy.degradedAllowUnavailable,
        reasonCode: decisionReason,
        fheResultHash,
        fheAttestationRef: fhe.attestationRef,
      });
      recordCandidateRejection(db, {
        traceId, workerId, taker, candidate, policy,
        reasonCode: decisionReason,
        fheDecisionHash,
        fheResultHash,
        fheAttestationRef: fhe.attestationRef,
        detailsJson: { fheCode: fhe.code },
      });
      continue;
    }

    const decisionReason = "FHE_ACCEPTED";
    const fheDecisionHash = computeFheDecisionHash({
      policyMode: policy.mode,
      degradedAllowUnavailable: policy.degradedAllowUnavailable,
      reasonCode: decisionReason,
      fheResultHash,
      fheAttestationRef: fhe.attestationRef,
    });
    return {
      candidate,
      decisionReasonCode: decisionReason,
      fheResultHash,
      fheDecisionHash,
      fheAttestationRef: fhe.attestationRef,
      fheDetails: fhe,
    };
  }

  return null;
}

async function runDeterministicMatchForOrderCore(db, takerOrderId, workerId = "matcher") {
  const nowSec = Math.floor(Date.now() / 1000);
  const traceId = crypto.randomUUID();
  const policy = getFhePolicy();
  const taker = getInternalOrderById(db, takerOrderId);
  if (!taker || !isOrderLiveForMatch(taker, nowSec)) {
    return { matched: false, reason: "taker_not_matchable", reasonCode: REASON_CODES.SIZE_MISMATCH, traceId };
  }

  const universe = listInternalOrdersForMatching(db);
  const selected = await pickBestCompatibleCounterparty(db, taker, universe, nowSec, policy, traceId, workerId);
  if (!selected) {
    persistDecision(db, {
      traceId,
      takerOrderId: taker.id,
      candidateOrderId: null,
      reasonCode: REASON_CODES.NO_COMPATIBLE_COUNTERPARTY,
      policyMode: policy.mode,
      detailsJson: {},
    });
    return { matched: false, reason: "no_compatible_counterparty", reasonCode: REASON_CODES.NO_COMPATIBLE_COUNTERPARTY, traceId };
  }
  const maker = selected.candidate;

  const fillQty = parseNum(taker.remainingAmount, 0n) < parseNum(maker.remainingAmount, 0n)
    ? parseNum(taker.remainingAmount, 0n)
    : parseNum(maker.remainingAmount, 0n);
  if (fillQty <= 0n) {
    recordCandidateRejection(db, {
      traceId, workerId, taker, candidate: maker, policy,
      reasonCode: REASON_CODES.SIZE_MISMATCH,
      detailsJson: { takerRemainingAmount: taker.remainingAmount, candidateRemainingAmount: maker.remainingAmount },
    });
    return { matched: false, reason: "non_positive_fill_qty", reasonCode: REASON_CODES.SIZE_MISMATCH, traceId };
  }

  const executionKey = computeExecutionKey(taker, maker);
  const actor = `matcher:${workerId}`;
  const takerBeforeStatus = taker.status;
  const makerBeforeStatus = maker.status;

  const takerReserved = reserveOrder(db, taker, fillQty, executionKey, actor);
  if (!takerReserved) return { matched: false, reason: "taker_reservation_conflict", reasonCode: REASON_CODES.INTERNAL_ERROR, traceId };

  const makerFresh = getInternalOrderById(db, maker.id);
  if (!makerFresh || !isOrderLiveForMatch(makerFresh, nowSec)) {
    releaseReservation(db, getInternalOrderById(db, taker.id), takerBeforeStatus, executionKey, actor, "maker_unavailable");
    return { matched: false, reason: "maker_unavailable_after_taker_reserve", reasonCode: REASON_CODES.INTERNAL_ERROR, traceId };
  }

  const makerReserved = reserveOrder(db, makerFresh, fillQty, executionKey, actor);
  if (!makerReserved) {
    releaseReservation(db, getInternalOrderById(db, taker.id), takerBeforeStatus, executionKey, actor, "maker_reservation_conflict");
    return { matched: false, reason: "maker_reservation_conflict", reasonCode: REASON_CODES.INTERNAL_ERROR, traceId };
  }

  const takerReservedRow = getInternalOrderById(db, taker.id);
  const makerReservedRow = getInternalOrderById(db, maker.id);
  const executionPrice = getExecutionPrice(takerReservedRow, makerReservedRow);
  const matchHash = computeStableMatchHash({
    pairBase: taker.pairBase,
    pairQuote: taker.pairQuote,
    makerOrderId: maker.id,
    takerOrderId: taker.id,
    quantity: fillQty.toString(),
    executionPrice,
  });

  const tx = () => {
    const decisionArtifactBundle = buildCanonicalMatchDecisionArtifact({
      traceId,
      taker: takerReservedRow,
      maker: makerReservedRow,
      matchHash,
      executionKey,
      policy,
      decisionReasonCode: selected.decisionReasonCode,
      fheResultHash: selected.fheResultHash,
      fheAttestationRef: selected.fheAttestationRef,
      fheAttestationSignature: selected.fheDetails?.attestationSignature || null,
      fheAttestationPayloadHash: selected.fheDetails?.attestationPayloadHash || null,
      decisionNonce: selected.fheDetails?.decisionNonce || null,
      decisionDomain: selected.fheDetails?.decisionDomain || null,
    });
    const persisted = persistMatchAndFills(db, {
      matchHash,
      executionKey,
      pairBase: taker.pairBase,
      pairQuote: taker.pairQuote,
      maker: makerReservedRow,
      taker: takerReservedRow,
      executionPrice,
      quantity: fillQty,
      decisionReasonCode: selected.decisionReasonCode,
      fheResultHash: selected.fheResultHash,
      fheDecisionHash: decisionArtifactBundle.decisionHash,
      fheAttestationRef: selected.fheAttestationRef,
      decisionArtifact: decisionArtifactBundle.artifact,
      makerSignedIntent: selected.fheDetails?.makerSignedIntent || null,
      takerSignedIntent: selected.fheDetails?.takerSignedIntent || null,
      fheAttestation: selected.fheDetails?.fheCanonical
        ? sanitizeMatchAttestationForPersistence({
            decisionHash: selected.fheDetails?.attestationPayloadHash || null,
            signature: selected.fheDetails?.attestationSignature || null,
            signerAddress: selected.fheDetails?.verifiedSigner || null,
            canonical: selected.fheDetails?.fheCanonical || null,
            result: selected.fheDetails?.fheResult || null,
          })
        : null,
    });

    const takerAfter = derivePostFillState(takerReservedRow, fillQty, executionKey, actor);
    const makerAfter = derivePostFillState(makerReservedRow, fillQty, executionKey, actor);
    assertLegalTransition(ORDER_STATUS.RESERVED, takerAfter.status);
    assertLegalTransition(ORDER_STATUS.RESERVED, makerAfter.status);

    const takerOk = compareAndSetInternalOrderState(db, {
      ...takerAfter,
      fromStatuses: [ORDER_STATUS.RESERVED],
    });
    const makerOk = compareAndSetInternalOrderState(db, {
      ...makerAfter,
      fromStatuses: [ORDER_STATUS.RESERVED],
    });
    if (!takerOk || !makerOk) throw new Error("finalize_reservation_cas_failed");

    const now = Date.now();
    saveOrderEvent(db, {
      id: crypto.randomUUID(),
      orderId: taker.id,
      eventType: "order_matched_fill",
      fromStatus: ORDER_STATUS.RESERVED,
      toStatus: takerAfter.status,
      reason: "deterministic_match_finalize",
      actor,
      metadataJson: {
        executionKey,
        matchHash,
        quantity: fillQty.toString(),
        price: executionPrice,
        role: "taker",
        fheDecisionHash: persisted.match?.fheDecisionHash || null,
        fheResultHash: persisted.match?.fheResultHash || null,
        decisionReasonCode: persisted.match?.decisionReasonCode || selected.decisionReasonCode
      },
      createdAt: now,
    });
    saveOrderEvent(db, {
      id: crypto.randomUUID(),
      orderId: maker.id,
      eventType: "order_matched_fill",
      fromStatus: ORDER_STATUS.RESERVED,
      toStatus: makerAfter.status,
      reason: "deterministic_match_finalize",
      actor,
      metadataJson: {
        executionKey,
        matchHash,
        quantity: fillQty.toString(),
        price: executionPrice,
        role: "maker",
        fheDecisionHash: persisted.match?.fheDecisionHash || null,
        fheResultHash: persisted.match?.fheResultHash || null,
        decisionReasonCode: persisted.match?.decisionReasonCode || selected.decisionReasonCode
      },
      createdAt: now,
    });

    persistDecision(db, {
      traceId,
      takerOrderId: taker.id,
      candidateOrderId: maker.id,
      matchHash,
      executionKey,
      reasonCode: selected.decisionReasonCode,
      policyMode: policy.mode,
      fheDecisionHash: persisted.match?.fheDecisionHash || null,
      fheResultHash: persisted.match?.fheResultHash || null,
      fheAttestationRef: persisted.match?.fheAttestationRef || null,
      detailsJson: {
        matched: true,
        workerId,
        fheCode: selected.fheDetails?.code || null,
        attestationSignature: selected.fheDetails?.attestationSignature || null,
        attestationPayloadHash: selected.fheDetails?.attestationPayloadHash || null,
        decisionNonce: selected.fheDetails?.decisionNonce || null,
      },
    });

    return {
      matched: true,
      idempotent: persisted.idempotent,
      reason: "matched",
      executionKey,
      matchHash,
      quantity: fillQty.toString(),
      executionPrice,
      traceId,
      reasonCode: selected.decisionReasonCode,
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      fheResultHash: persisted.match?.fheResultHash || null,
      fheDecisionHash: persisted.match?.fheDecisionHash || null,
      fheAttestationRef: persisted.match?.fheAttestationRef || null,
      fills: persisted.fills,
    };
  };

  try {
    if (typeof db.transaction === "function") {
      return db.transaction(tx)();
    }
    return tx();
  } catch (e) {
    const tRow = getInternalOrderById(db, taker.id);
    const mRow = getInternalOrderById(db, maker.id);
    if (tRow?.status === ORDER_STATUS.RESERVED) {
      releaseReservation(db, tRow, takerBeforeStatus, executionKey, actor, "finalization_failed");
    }
    if (mRow?.status === ORDER_STATUS.RESERVED) {
      releaseReservation(db, mRow, makerBeforeStatus, executionKey, actor, "finalization_failed");
    }
    persistDecision(db, {
      traceId,
      takerOrderId: taker.id,
      candidateOrderId: maker.id,
      reasonCode: REASON_CODES.INTERNAL_ERROR,
      policyMode: policy.mode,
      detailsJson: { error: e.message || String(e), stage: "finalization" },
    });
    return { matched: false, reason: "finalization_failed", reasonCode: REASON_CODES.INTERNAL_ERROR, error: e.message || String(e), traceId };
  }
}

async function runDeterministicMatchForOrder(orderId, workerId = "matcher") {
  const db = getDb();
  if (!db) return { matched: false, reason: "db_not_configured" };
  if (typeof db.transaction === "function") {
    return runDeterministicMatchForOrderCore(db, orderId, workerId);
  }
  return withJsonLock(async () => runDeterministicMatchForOrderCore(db, orderId, workerId));
}

async function reconcileStaleReservations(workerId = "matcher") {
  const db = getDb();
  if (!db) return { scanned: 0, released: 0 };
  const now = Date.now();
  const cutoff = now - Number(matchingContext.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS);
  const run = () => {
    const orders = listInternalOrdersForMatching(db);
    let released = 0;
    for (const order of orders) {
      if (order.status !== ORDER_STATUS.RESERVED) continue;
      if (Number(order.updatedAt || 0) > cutoff) continue;
      const restore = parseNum(order.filledAmount, 0n) > 0n ? ORDER_STATUS.PARTIALLY_FILLED : ORDER_STATUS.OPEN;
      if (!assertLegalTransition) continue;
      try {
        assertLegalTransition(ORDER_STATUS.RESERVED, restore);
      } catch {
        continue;
      }
      const ok = releaseReservation(db, order, restore, order.matchRef || null, `matcher:${workerId}`, "reservation_ttl_recovery");
      if (ok) released += 1;
    }
    return { scanned: orders.length, released };
  };
  if (typeof db.transaction === "function") return db.transaction(run)();
  return withJsonLock(async () => run());
}

function loadOrderBook() {
  try {
    if (!fs.existsSync(ORDER_STORE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ORDER_STORE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [k, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      orderBook.set(k, list.slice(-MAX_ORDERS_PER_PAIR));
    }
  } catch (_) {}
}

function persistOrderBook() {
  try {
    const out = {};
    for (const [k, list] of orderBook.entries()) out[k] = list;
    const dir = path.dirname(ORDER_STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ORDER_STORE_FILE, JSON.stringify(out), 'utf8');
  } catch (_) {}
}

async function registerOrderAndTryMatch(order) {
  const db = getDb();
  if (db && order?.orderId && typeof order.orderId === "string") {
    await reconcileStaleReservations("register");
    return runDeterministicMatchForOrder(order.orderId, order.workerId || "register");
  }
  const normalized = normalizeFheOrder(order);
  if (!normalized) {
    return { matched: false, error: "invalid_order_asset_ids" };
  }
  const key = orderBookKey(normalized.inputAssetID, normalized.outputAssetID);
  const reverseKey = orderBookKey(normalized.outputAssetID, normalized.inputAssetID);
  const reverseList = orderBook.get(reverseKey);
  if (reverseList && reverseList.length > 0) {
    const existing = reverseList[reverseList.length - 1];
    const result = await matchOrdersFHE(normalized, existing);
    if (result.matched) {
      reverseList.pop();
      if (reverseList.length === 0) orderBook.delete(reverseKey);
      else orderBook.set(reverseKey, reverseList);
      persistOrderBook();
      return { matched: true, matchResult: result };
    }
  }
  const list = orderBook.get(key) || [];
  list.push({ ...normalized, ts: Date.now() });
  if (list.length > MAX_ORDERS_PER_PAIR) list.shift();
  orderBook.set(key, list);
  persistOrderBook();
  return { matched: false };
}

async function matchOrdersFHE(order1, order2) {
  console.log('🔄 Matching FHE-encrypted orders...');

  if (isRemoteEnabled()) {
    try {
      const remote = await fheRemoteFetch('/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order1, order2 }),
      });
      if (remote && typeof remote.matched === 'boolean') return remote;
    } catch (e) {
      console.error('FHE remote /match failed:', e.message || e);
      throw e;
    }
  }

  if (FHE_PRODUCTION_MODE) {
    throw new Error("fhe_remote_required_in_production");
  }

  const a1 = Number(order1.inputAssetID);
  const a2 = Number(order1.outputAssetID);
  const b1 = Number(order2.inputAssetID);
  const b2 = Number(order2.outputAssetID);
  const assetsMatch = a1 === b2 && a2 === b1;
  
  if (!assetsMatch) {
    return {
      matched: false,
      fheEncryptedResult: '0x',
      executionId: ethers.ZeroHash
    };
  }

  const executionId = ethers.keccak256(
    ethers.concat([
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(order1.fheEncryptedInputAmount))),
      ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(order2.fheEncryptedInputAmount))),
      ethers.toUtf8Bytes(Date.now().toString())
    ])
  );

  const fheEncryptedResult = ethers.hexlify(
    ethers.toUtf8Bytes(`FHE_MATCH:${executionId}`)
  );
  
  console.log('✅ Orders matched via FHE');
  
  return {
    matched: true,
    fheEncryptedResult,
    executionId
  };
}

router.post('/match', async (req, res) => {
  try {
    const { order1, order2 } = req.body;
    
    if (!order1 || !order2) {
      return res.status(400).json({ error: 'Missing order data' });
    }

    const n1 = normalizeFheOrder(order1);
    const n2 = normalizeFheOrder(order2);
    if (!n1 || !n2) {
      return res.status(400).json({ error: 'Invalid order asset IDs' });
    }

    if (isRemoteEnabled()) {
      try {
        const remote = await fheRemoteFetch('/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order1: n1, order2: n2 }),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }
    if (FHE_PRODUCTION_MODE) {
      return res.status(503).json({
        error: "fhe_remote_required_in_production",
        detail: "Mock/plaintext matching fallback is disabled in production.",
      });
    }

    const result = await matchOrdersFHE(n1, n2);
    res.json(result);
  } catch (error) {
    console.error('❌ FHE matching error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const order = req.body;
    if (!order || order.inputAssetID === undefined || order.outputAssetID === undefined) {
      return res.status(400).json({ error: 'Missing order or asset IDs' });
    }
    const { matched, matchResult, error } = await registerOrderAndTryMatch(order);
    if (error) return res.status(400).json({ error });
    res.json({ matched, matchResult: matchResult || null });
  } catch (error) {
    console.error('❌ FHE register error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/internal/match", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "");
    const workerId = String(req.body?.workerId || "api");
    if (!ethers.isHexString(orderId, 32)) {
      return res.status(400).json({ error: "invalid_order_id" });
    }
    await reconcileStaleReservations(workerId);
    const out = await runDeterministicMatchForOrder(orderId, workerId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || "internal_match_failed" });
  }
});

router.post("/internal/reconcile", async (req, res) => {
  try {
    const workerId = String(req.body?.workerId || "api");
    const out = await reconcileStaleReservations(workerId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || "reconcile_failed" });
  }
});

router.get("/internal/order/:orderId/decisions", (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "db_not_configured" });
    const orderId = String(req.params.orderId || "");
    if (!ethers.isHexString(orderId, 32)) return res.status(400).json({ error: "invalid_order_id" });
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const items = listMatchDecisionsByOrder(db, orderId, limit);
    return res.json({ orderId, items, count: items.length, policy: getFhePolicy() });
  } catch (e) {
    return res.status(500).json({ error: e.message || "decision_query_failed" });
  }
});

router.get("/internal/match/:matchHash", (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: "db_not_configured" });
    const matchHash = String(req.params.matchHash || "");
    if (!ethers.isHexString(matchHash, 32)) return res.status(400).json({ error: "invalid_match_hash" });
    const match = getMatchByHash(db, matchHash);
    if (!match) return res.status(404).json({ error: "match_not_found" });
    const fills = listFillsByMatch(db, match.id);
    return res.json({ match, fills });
  } catch (e) {
    return res.status(500).json({ error: e.message || "match_query_failed" });
  }
});

router.get('/health', async (req, res) => {
  const openOrders = Array.from(orderBook.values()).reduce((sum, arr) => sum + arr.length, 0);
  const remoteHealth = await getRemoteHealthSnapshot();
  res.json({
    status: 'healthy',
    service: 'FHE Matching Service',
    fheEnabled: true,
    orderPairs: orderBook.size,
    openOrders,
    fheMode: FHE_MODE,
    fheEffectiveMode: isRemoteEnabled() ? 'remote' : 'mock',
    fheLibrary: isRemoteEnabled() ? 'remote-service' : 'deterministic-mock',
    fheServiceConfigured: isRemoteConfigured(),
    fheServiceReachable: remoteHealth.reachable,
    fheServiceError: remoteHealth.error,
    fheServiceCheckedAt: remoteHealth.checkedAt,
    fhePolicy: getFhePolicy(),
    productionPolicy: {
      production: FHE_PRODUCTION_MODE,
      mockForbidden: FHE_PRODUCTION_MODE,
      plaintextFallbackForbidden: FHE_PRODUCTION_MODE,
      failClosedOnUnavailable: FHE_PRODUCTION_MODE,
    },
  });
});

router.post('/compute', async (req, res) => {
  try {
    const { operation, encryptedInputs } = req.body;
    
    if (!operation || !encryptedInputs) {
      return res.status(400).json({ error: 'Missing operation or inputs' });
    }

    if (isRemoteEnabled()) {
      try {
        const remote = await fheRemoteFetch('/compute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }
    if (FHE_PRODUCTION_MODE) {
      return res.status(503).json({
        error: "fhe_remote_required_in_production",
        detail: "Local compute fallback is disabled in production.",
      });
    }

    console.log(`🔄 FHE computation: ${operation}`);

    const result = {
      operation,
      fheEncryptedResult: ethers.hexlify(ethers.randomBytes(32)),
      executionId: ethers.keccak256(ethers.toUtf8Bytes(Date.now().toString()))
    };
    
    res.json(result);
  } catch (error) {
    console.error('❌ FHE computation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/public-key', async (req, res) => {
  if (isRemoteEnabled()) {
    try {
      const remote = await fheRemoteFetch('/public-key', { method: 'GET' });
      return res.json(remote);
    } catch (e) {
      const code = e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(code).json({ error: e.message || 'FHE service error' });
    }
  }
  if (FHE_PRODUCTION_MODE) {
    return res.status(503).json({
      error: "fhe_remote_required_in_production",
      detail: "Mock public key fallback is disabled in production.",
    });
  }
  res.json({ publicKey: ethers.hexlify(ethers.randomBytes(32)) });
});

router.post('/encrypt', async (req, res) => {
  try {
    if (isRemoteEnabled()) {
      try {
        const remote = await fheRemoteFetch('/encrypt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        });
        return res.json(remote);
      } catch (e) {
        const code = e.status >= 400 && e.status < 600 ? e.status : 502;
        return res.status(code).json({ error: e.message || 'FHE service error' });
      }
    }
    if (FHE_PRODUCTION_MODE) {
      return res.status(503).json({
        error: "fhe_remote_required_in_production",
        detail: "Plaintext passthrough encryption fallback is disabled in production.",
      });
    }
    res.json({ ciphertext: req.body });
  } catch (e) {
    res.status(500).json({ error: e.message || 'encrypt failed' });
  }
});

router.post('/order', async (req, res) => {
  try {
    if (FHE_PRODUCTION_MODE) {
      return res.status(403).json({
        error: "plaintext_order_submission_disabled_in_production",
        detail: "Use remote encrypted order submission path only.",
      });
    }
    const encrypted = req.body?.ciphertext ?? req.body?.encrypted ?? req.body;
    if (!encrypted) {
      return res.status(400).json({ error: 'Missing order payload' });
    }

    const side = encrypted.side || 'sell';
    let assetIn = encrypted.assetIn;
    let assetOut = encrypted.assetOut;
    if (assetIn === undefined || assetOut === undefined) {
      return res.status(400).json({ error: 'Missing assetIn/assetOut' });
    }

    const inputAssetID = Number(assetIn);
    const outputAssetID = Number(assetOut);
    if (!Number.isFinite(inputAssetID) || !Number.isFinite(outputAssetID)) {
      return res.status(400).json({ error: 'Invalid asset IDs' });
    }

    const toFheBytes = (v) => ethers.hexlify(ethers.toUtf8Bytes(String(v)));
    const order = {
      inputAssetID,
      outputAssetID,
      fheEncryptedInputAmount: toFheBytes(encrypted.amount ?? '0'),
      fheEncryptedMinOutput: toFheBytes(encrypted.price ?? '0'),
    };

    const result = await registerOrderAndTryMatch(order);

    const orderId = ethers.keccak256(
      ethers.toUtf8Bytes(
        JSON.stringify({ inputAssetID, outputAssetID, side, ts: Date.now(), matched: !!result.matched })
      )
    );

    res.json({
      orderId,
      matched: !!result.matched,
      matchResult: result.matchResult ?? null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'order failed' });
  }
});

function getFheMatchMode() {
  return FHE_MODE;
}

module.exports = router;
module.exports.registerOrderAndTryMatch = registerOrderAndTryMatch;
module.exports.getFheMatchMode = getFheMatchMode;
module.exports.normalizeFheOrder = normalizeFheOrder;
module.exports.configureMatchingEngine = configureMatchingEngine;
module.exports.runDeterministicMatchForOrder = runDeterministicMatchForOrder;
module.exports.reconcileStaleReservations = reconcileStaleReservations;
module.exports.computeStableMatchHash = computeStableMatchHash;
module.exports.computeFheDecisionHash = computeFheDecisionHash;
module.exports.REASON_CODES = REASON_CODES;
module.exports.deriveFheSecurityPolicy = deriveFheSecurityPolicy;
module.exports.assertFheProductionSafety = assertFheProductionSafety;
module.exports.FHE_PRODUCTION_MODE = FHE_PRODUCTION_MODE;
module.exports.verifyFheAttestation = verifyFheAttestation;
module.exports.evaluateInternalMatchCompare = evaluateInternalMatchCompare;
loadOrderBook();