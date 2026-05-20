const crypto = require("crypto");
const express = require("express");
const { ethers } = require("ethers");
const { z } = require("zod");
const { encryptJsonAtRest } = require("./noteCipher");
const {
  saveInternalOrder,
  updateInternalOrderState,
  getInternalOrderById,
  getInternalOrderByReplayKey,
  getInternalOrderByOwnerNonce,
  listInternalOrders,
  saveOrderEvent,
  listOrderEvents,
  saveCancellation,
  listMatchDecisionsByOrder,
  listComplianceDecisionsByOrder,
} = require("./db");
const { ORDER_STATUS, canCancel, assertLegalTransition } = require("./internalOrderLifecycle");

const INTERNAL_ORDER_TYPES = {
  InternalOrderIntent: [
    { name: "owner", type: "address" },
    { name: "signingKey", type: "address" },
    { name: "baseAsset", type: "string" },
    { name: "quoteAsset", type: "string" },
    { name: "side", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "replayKey", type: "bytes32" },
  ],
};

const INTERNAL_CANCEL_TYPES = {
  InternalOrderCancel: [
    { name: "orderId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "reason", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// Phase 2: EIP-712 InternalMatchIntent — both maker and taker sign this off-chain
// to bind their encrypted order to its `ciphertextHash`. Under Path-B (M5+) the
// signature is verified off-chain only (the on-chain `internalMatchSettle`
// consumer was removed); M7 wires the verified pair into the pending-note
// ledger and M8 carries the binding into the withdraw proof.
const INTERNAL_MATCH_INTENT_TYPES = {
  InternalMatchIntent: [
    { name: "user", type: "address" },
    { name: "side", type: "uint8" },
    { name: "inputAssetID", type: "uint256" },
    { name: "outputAssetID", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "ciphertextHash", type: "bytes32" },
  ],
};
const MATCH_INTENT_DOMAIN_NAME = "PhantomInternalMatchIntent";
const MATCH_INTENT_DOMAIN_VERSION = "1";

const matchIntentSchema = z.object({
  user: z.string().refine((v) => ethers.isAddress(v)),
  side: z.union([z.literal(0), z.literal(1)]),
  inputAssetID: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  outputAssetID: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  amount: z.string().regex(/^\d+$/),
  limitPrice: z.string().regex(/^\d+$/),
  nonce: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  deadline: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  ciphertextHash: z.string().refine((v) => ethers.isHexString(v, 32)),
}).strict();

const orderIntentSchema = z.object({
  intent: z.object({
    owner: z.string().refine((v) => ethers.isAddress(v)),
    signingKey: z.string().refine((v) => ethers.isAddress(v)),
    baseAsset: z.string().min(1).max(128),
    quoteAsset: z.string().min(1).max(128),
    side: z.enum(["buy", "sell"]),
    amount: z.string().regex(/^\d+$/),
    limitPrice: z.string().regex(/^\d+$/),
    expiry: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    nonce: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    replayKey: z.string().refine((v) => ethers.isHexString(v, 32)),
  }).strict(),
  signature: z.string().min(2),
  envelope: z.any().optional(),
  matchIntent: matchIntentSchema.optional(),
  matchSignature: z.string().min(2).optional(),
  ciphertext: z.union([z.string().min(1), z.record(z.any())]).optional(),
}).strict();

const cancelSchema = z.object({
  orderId: z.string().refine((v) => ethers.isHexString(v, 32)),
  cancel: z.object({
    owner: z.string().refine((v) => ethers.isAddress(v)),
    reason: z.string().min(1).max(280),
    nonce: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    deadline: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  }).strict(),
  signature: z.string().min(2),
}).strict();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function computeCiphertextHash(ciphertext) {
  if (ciphertext == null) return null;
  if (typeof ciphertext === "string") {
    return ethers.keccak256(ethers.toUtf8Bytes(ciphertext));
  }
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(ciphertext)));
}

function isStrictUserIntentMode() {
  if (String(process.env.MATCHING_REQUIRE_USER_INTENT || "").toLowerCase() === "true") return true;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") return true;
  if (String(process.env.PHANTOM_DEPLOYMENT_TIER || "").toLowerCase() === "production") return true;
  return false;
}

function isFheRemoteRequiredMode() {
  if (String(process.env.MATCHING_FHE_POLICY_MODE || "degraded").toLowerCase() === "strict") return true;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") return true;
  if (String(process.env.PHANTOM_DEPLOYMENT_TIER || "").toLowerCase() === "production") return true;
  return false;
}

function fheModeRemote() {
  return String(process.env.FHE_MODE || "mock").trim().toLowerCase() === "remote";
}

function computeOrderId(intent, domain) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "string", "string", "string", "uint256", "uint256", "uint256", "uint256", "bytes32"],
    [
      BigInt(domain.chainId),
      intent.owner,
      intent.signingKey,
      intent.baseAsset,
      intent.quoteAsset,
      intent.side,
      BigInt(intent.amount),
      BigInt(intent.limitPrice),
      BigInt(intent.expiry),
      BigInt(intent.nonce),
      intent.replayKey,
    ]
  );
}

function hashSignature(signature) {
  return crypto.createHash("sha256").update(String(signature)).digest("hex");
}

function asSafeOrder(order) {
  return {
    id: order.id,
    ownerAddress: order.ownerAddress,
    signingKey: order.signingKey,
    pair: {
      baseAsset: order.pairBase,
      quoteAsset: order.pairQuote,
      side: order.side,
    },
    status: order.status,
    amount: order.amount,
    limitPrice: order.limitPrice,
    remainingAmount: order.remainingAmount,
    filledAmount: order.filledAmount,
    reservedAmount: order.reservedAmount,
    nonce: order.nonce,
    replayKey: order.replayKey,
    expiryTs: order.expiryTs,
    matchRef: order.matchRef || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    createdBy: order.createdBy || null,
    updatedBy: order.updatedBy || null,
    normalized: order.normalizedPayload || {},
  };
}

function createInternalOrderRouter({ db, chainId, verifyingContract, complianceEngine }) {
  const router = express.Router();
  const domain = {
    name: "PhantomInternalOrder",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: verifyingContract || ethers.ZeroAddress,
  };
  const matchIntentDomain = {
    name: MATCH_INTENT_DOMAIN_NAME,
    version: MATCH_INTENT_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: verifyingContract || ethers.ZeroAddress,
  };

  function verifyMatchIntent(parsedBody, normalizedOperatorIntent) {
    const requireMatchIntent = isStrictUserIntentMode();
    const matchIntentRaw = parsedBody.matchIntent;
    const matchSignature = parsedBody.matchSignature;
    const ciphertext = parsedBody.ciphertext;

    if (!matchIntentRaw && !matchSignature && !ciphertext) {
      if (requireMatchIntent) {
        return { ok: false, status: 400, body: { error: "match_intent_required", reason: "MATCH_INTENT_MISSING" } };
      }
      return { ok: true, value: null };
    }
    if (!matchIntentRaw || !matchSignature || !ciphertext) {
      return { ok: false, status: 400, body: { error: "match_intent_incomplete", reason: "MATCH_INTENT_INCOMPLETE" } };
    }

    if (requireMatchIntent && (!fheModeRemote() || !isFheRemoteRequiredMode())) {
      // Keep dev-mode tolerant; in strict mode user intent must come with real FHE
      if (isFheRemoteRequiredMode() && !fheModeRemote()) {
        return { ok: false, status: 503, body: { error: "fhe_remote_required", reason: "FHE_MOCK_FORBIDDEN" } };
      }
    }

    const normalizedMatchIntent = {
      user: ethers.getAddress(matchIntentRaw.user),
      side: Number(matchIntentRaw.side),
      inputAssetID: String(matchIntentRaw.inputAssetID),
      outputAssetID: String(matchIntentRaw.outputAssetID),
      amount: String(matchIntentRaw.amount),
      limitPrice: String(matchIntentRaw.limitPrice),
      nonce: String(matchIntentRaw.nonce),
      deadline: String(matchIntentRaw.deadline),
      ciphertextHash: ethers.hexlify(matchIntentRaw.ciphertextHash).toLowerCase(),
    };

    if (BigInt(normalizedMatchIntent.deadline) <= BigInt(nowSec())) {
      return { ok: false, status: 400, body: { error: "match_intent_expired", reason: "MATCH_INTENT_EXPIRED" } };
    }

    if (normalizedMatchIntent.user.toLowerCase() !== normalizedOperatorIntent.owner.toLowerCase()) {
      return { ok: false, status: 400, body: { error: "match_intent_user_mismatch", reason: "USER_MISMATCH" } };
    }

    const expectedSide = normalizedOperatorIntent.side === "sell" ? 0 : 1;
    if (normalizedMatchIntent.side !== expectedSide) {
      return { ok: false, status: 400, body: { error: "match_intent_side_mismatch", reason: "SIDE_MISMATCH" } };
    }

    if (BigInt(normalizedMatchIntent.amount) < BigInt(normalizedOperatorIntent.amount)) {
      return { ok: false, status: 400, body: { error: "match_intent_amount_below_operator_amount", reason: "AMOUNT_MISMATCH" } };
    }

    if (expectedSide === 0) {
      if (BigInt(normalizedMatchIntent.limitPrice) > BigInt(normalizedOperatorIntent.limitPrice)) {
        return { ok: false, status: 400, body: { error: "match_intent_limit_price_mismatch", reason: "LIMIT_PRICE_MISMATCH" } };
      }
    } else {
      if (BigInt(normalizedMatchIntent.limitPrice) < BigInt(normalizedOperatorIntent.limitPrice)) {
        return { ok: false, status: 400, body: { error: "match_intent_limit_price_mismatch", reason: "LIMIT_PRICE_MISMATCH" } };
      }
    }

    const recomputedCiphertextHash = computeCiphertextHash(ciphertext);
    if (!recomputedCiphertextHash || recomputedCiphertextHash.toLowerCase() !== normalizedMatchIntent.ciphertextHash) {
      return { ok: false, status: 400, body: { error: "ciphertext_hash_mismatch", reason: "CIPHERTEXT_HASH_MISMATCH" } };
    }

    const typed = {
      user: normalizedMatchIntent.user,
      side: normalizedMatchIntent.side,
      inputAssetID: BigInt(normalizedMatchIntent.inputAssetID),
      outputAssetID: BigInt(normalizedMatchIntent.outputAssetID),
      amount: BigInt(normalizedMatchIntent.amount),
      limitPrice: BigInt(normalizedMatchIntent.limitPrice),
      nonce: BigInt(normalizedMatchIntent.nonce),
      deadline: BigInt(normalizedMatchIntent.deadline),
      ciphertextHash: normalizedMatchIntent.ciphertextHash,
    };

    let recoveredSigner;
    try {
      recoveredSigner = ethers.verifyTypedData(matchIntentDomain, INTERNAL_MATCH_INTENT_TYPES, typed, matchSignature);
    } catch (e) {
      return { ok: false, status: 400, body: { error: "invalid_match_intent_signature", reason: "BAD_SIGNATURE", message: e.message } };
    }
    if (recoveredSigner.toLowerCase() !== normalizedMatchIntent.user.toLowerCase()) {
      return { ok: false, status: 400, body: { error: "match_intent_signer_mismatch", reason: "SIGNER_MISMATCH" } };
    }

    return {
      ok: true,
      value: {
        intent: normalizedMatchIntent,
        signature: matchSignature,
        ciphertext,
      },
    };
  }

  router.post("/", async (req, res) => {
    const parsed = orderIntentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const normalizedIntent = {
      ...parsed.data.intent,
      owner: ethers.getAddress(parsed.data.intent.owner),
      signingKey: ethers.getAddress(parsed.data.intent.signingKey),
      expiry: String(parsed.data.intent.expiry),
      nonce: String(parsed.data.intent.nonce),
      replayKey: ethers.hexlify(parsed.data.intent.replayKey).toLowerCase(),
    };
    if (BigInt(normalizedIntent.expiry) <= BigInt(nowSec())) {
      return res.status(400).json({ error: "internal_order_expired" });
    }

    const typed = {
      owner: normalizedIntent.owner,
      signingKey: normalizedIntent.signingKey,
      baseAsset: normalizedIntent.baseAsset,
      quoteAsset: normalizedIntent.quoteAsset,
      side: normalizedIntent.side,
      amount: BigInt(normalizedIntent.amount),
      limitPrice: BigInt(normalizedIntent.limitPrice),
      expiry: BigInt(normalizedIntent.expiry),
      nonce: BigInt(normalizedIntent.nonce),
      replayKey: normalizedIntent.replayKey,
    };

    let signerAddr;
    try {
      signerAddr = ethers.verifyTypedData(domain, INTERNAL_ORDER_TYPES, typed, parsed.data.signature);
    } catch (e) {
      return res.status(400).json({ error: "invalid_internal_order_signature", message: e.message });
    }
    if (signerAddr.toLowerCase() !== normalizedIntent.signingKey.toLowerCase()) {
      return res.status(400).json({ error: "invalid_internal_order_signer" });
    }

    const matchIntentResult = verifyMatchIntent(parsed.data, normalizedIntent);
    if (!matchIntentResult.ok) {
      return res.status(matchIntentResult.status).json(matchIntentResult.body);
    }
    const matchIntentVerified = matchIntentResult.value;

    const orderId = computeOrderId(normalizedIntent, domain);
    const existingByReplay = getInternalOrderByReplayKey(db, normalizedIntent.replayKey);
    if (existingByReplay) {
      if (existingByReplay.id === orderId) {
        return res.json({ orderId: existingByReplay.id, status: existingByReplay.status, idempotent: true });
      }
      return res.status(409).json({ error: "replay_key_already_used", orderId: existingByReplay.id });
    }

    const existingByNonce = getInternalOrderByOwnerNonce(db, normalizedIntent.owner.toLowerCase(), normalizedIntent.nonce);
    if (existingByNonce) {
      if (existingByNonce.id === orderId) {
        return res.json({ orderId: existingByNonce.id, status: existingByNonce.status, idempotent: true });
      }
      return res.status(409).json({ error: "owner_nonce_already_used", orderId: existingByNonce.id });
    }

    let encryptedPayload;
    try {
      encryptedPayload = encryptJsonAtRest({
        intent: normalizedIntent,
        signature: parsed.data.signature,
        envelope: parsed.data.envelope ?? null,
        matchIntent: matchIntentVerified
          ? {
              intent: matchIntentVerified.intent,
              signature: matchIntentVerified.signature,
              ciphertext: matchIntentVerified.ciphertext,
            }
          : null,
      });
    } catch (e) {
      return res.status(503).json({ error: "internal_order_encryption_unavailable", message: e.message });
    }

    const now = Date.now();
    const traceId = crypto.randomUUID();
    if (complianceEngine) {
      const intakeGate = await complianceEngine.checkIntake({
        traceId,
        orderId,
        ownerAddress: normalizedIntent.owner,
        policy: {
          mode: process.env.COMPLIANCE_POLICY_MODE || "enforced",
          version: process.env.COMPLIANCE_POLICY_VERSION || "v1",
        },
      });
      if (!intakeGate.allowed) {
        return res.status(409).json({
          error: "compliance_intake_blocked",
          action: intakeGate.action,
          reasonCode: intakeGate.reasonCode,
          traceId,
        });
      }
    }

    const normalizedWithMatchIntent = matchIntentVerified
      ? {
          ...normalizedIntent,
          matchIntent: {
            intent: matchIntentVerified.intent,
            signature: matchIntentVerified.signature,
            signatureHash: hashSignature(matchIntentVerified.signature),
            ciphertextHash: matchIntentVerified.intent.ciphertextHash,
          },
        }
      : normalizedIntent;
    const row = {
      id: orderId,
      ownerAddress: normalizedIntent.owner.toLowerCase(),
      signingKey: normalizedIntent.signingKey.toLowerCase(),
      pairBase: normalizedIntent.baseAsset,
      pairQuote: normalizedIntent.quoteAsset,
      side: normalizedIntent.side,
      status: ORDER_STATUS.OPEN,
      amount: normalizedIntent.amount,
      limitPrice: normalizedIntent.limitPrice,
      remainingAmount: normalizedIntent.amount,
      filledAmount: "0",
      reservedAmount: "0",
      nonce: normalizedIntent.nonce,
      replayKey: normalizedIntent.replayKey,
      signatureHash: hashSignature(parsed.data.signature),
      expiryTs: Number(normalizedIntent.expiry),
      encryptedPayload,
      normalizedPayload: normalizedWithMatchIntent,
      matchRef: null,
      createdBy: normalizedIntent.owner.toLowerCase(),
      updatedBy: normalizedIntent.owner.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    };

    try {
      saveInternalOrder(db, row);
      saveOrderEvent(db, {
        id: crypto.randomUUID(),
        orderId,
        eventType: "order_created",
        fromStatus: null,
        toStatus: ORDER_STATUS.OPEN,
        reason: null,
        actor: row.createdBy,
        metadataJson: { source: "api", replayKey: row.replayKey },
        createdAt: now,
      });
    } catch (e) {
      return res.status(409).json({ error: "internal_order_replay_conflict", message: e.message });
    }

    return res.status(201).json({
      orderId,
      status: ORDER_STATUS.OPEN,
      idempotent: false,
      matchIntentBound: !!matchIntentVerified,
    });
  });

  router.post("/cancel", async (req, res) => {
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const order = getInternalOrderById(db, parsed.data.orderId);
    if (!order) return res.status(404).json({ error: "internal_order_not_found" });

    const cancelPayload = {
      ...parsed.data.cancel,
      owner: ethers.getAddress(parsed.data.cancel.owner),
      nonce: String(parsed.data.cancel.nonce),
      deadline: String(parsed.data.cancel.deadline),
    };
    if (BigInt(cancelPayload.deadline) <= BigInt(nowSec())) {
      return res.status(400).json({ error: "internal_cancel_expired" });
    }

    const typed = {
      orderId: parsed.data.orderId,
      owner: cancelPayload.owner,
      reason: cancelPayload.reason,
      nonce: BigInt(cancelPayload.nonce),
      deadline: BigInt(cancelPayload.deadline),
    };

    let signerAddr;
    try {
      signerAddr = ethers.verifyTypedData(domain, INTERNAL_CANCEL_TYPES, typed, parsed.data.signature);
    } catch (e) {
      return res.status(400).json({ error: "invalid_internal_cancel_signature", message: e.message });
    }
    if (signerAddr.toLowerCase() !== order.ownerAddress.toLowerCase() || cancelPayload.owner.toLowerCase() !== order.ownerAddress.toLowerCase()) {
      return res.status(403).json({ error: "owner_authorization_required" });
    }
    if (!canCancel(order.status)) {
      return res.status(409).json({ error: "order_not_cancellable", status: order.status });
    }

    try {
      assertLegalTransition(order.status, ORDER_STATUS.CANCELLED);
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

    const updatedAt = Date.now();
    const updatedRow = {
      id: order.id,
      status: ORDER_STATUS.CANCELLED,
      remainingAmount: order.remainingAmount,
      filledAmount: order.filledAmount,
      reservedAmount: order.reservedAmount,
      matchRef: order.matchRef || null,
      updatedBy: cancelPayload.owner.toLowerCase(),
      updatedAt,
    };
    updateInternalOrderState(db, updatedRow);
    try {
      saveCancellation(db, {
        id: crypto.randomUUID(),
        orderId: order.id,
        reason: cancelPayload.reason,
        actor: cancelPayload.owner.toLowerCase(),
        signatureHash: hashSignature(parsed.data.signature),
        payloadJson: cancelPayload,
        createdAt: updatedAt,
      });
    } catch {
      return res.json({ orderId: order.id, status: ORDER_STATUS.CANCELLED, idempotent: true });
    }

    saveOrderEvent(db, {
      id: crypto.randomUUID(),
      orderId: order.id,
      eventType: "order_cancelled",
      fromStatus: order.status,
      toStatus: ORDER_STATUS.CANCELLED,
      reason: cancelPayload.reason,
      actor: cancelPayload.owner.toLowerCase(),
      metadataJson: { cancelNonce: cancelPayload.nonce },
      createdAt: updatedAt,
    });

    return res.json({ orderId: order.id, status: ORDER_STATUS.CANCELLED, idempotent: false });
  });

  router.get("/:id", (req, res) => {
    const order = getInternalOrderById(db, req.params.id);
    if (!order) return res.status(404).json({ error: "internal_order_not_found" });
    const events = listOrderEvents(db, order.id);
    const decisions = listMatchDecisionsByOrder(db, order.id, 100);
    const complianceDecisions = listComplianceDecisionsByOrder(db, order.id, 100);
    return res.json({ order: asSafeOrder(order), events, decisions, complianceDecisions });
  });

  router.get("/", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !Object.values(ORDER_STATUS).includes(status)) {
      return res.status(400).json({ error: "invalid_status_filter" });
    }
    const rows = listInternalOrders(db, { status, limit, offset });
    return res.json({
      items: rows.map(asSafeOrder),
      page: { limit, offset, count: rows.length },
      orderBy: "createdAt_desc_id_desc",
    });
  });

  return router;
}

module.exports = {
  createInternalOrderRouter,
  INTERNAL_ORDER_TYPES,
  INTERNAL_CANCEL_TYPES,
  INTERNAL_MATCH_INTENT_TYPES,
  MATCH_INTENT_DOMAIN_NAME,
  MATCH_INTENT_DOMAIN_VERSION,
  computeOrderId,
  computeCiphertextHash,
};
