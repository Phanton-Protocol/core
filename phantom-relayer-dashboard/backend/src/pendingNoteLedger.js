const crypto = require("crypto");
const { ethers } = require("ethers");
const { encryptJsonAtRest, decryptJsonAtRest } = require("./noteCipher");
const {
  getLatestInternalMatchAuditEntry,
  getInternalMatchAuditByMatchHash,
  appendInternalMatchAuditEntry,
  savePendingNote,
  listPendingNotesByOwner,
  listPendingNotesByMatchHash,
  getEncryptedNote,
  saveEncryptedNote,
  getInternalMatchEnrollmentByUser,
} = require("./db");

const DEFAULT_FEE_BPS = Number(process.env.PHANTOM_INTERNAL_MATCH_FEE_BPS || 20);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function b(v) {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
}

function computeOutputNoteCommitment({ noteId, owner, matchHash, role, inputNoteId }) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      stableStringify({
        schema: "phantom.pending-note.commitment.v1",
        noteId,
        owner: String(owner).toLowerCase(),
        matchHash,
        role,
        inputNoteId: inputNoteId || null,
      })
    )
  );
}

function computeAuditEntryHash({
  prevHash,
  matchHash,
  decisionHash,
  makerEnrollmentId,
  takerEnrollmentId,
  inputNoteIds,
  outputNoteCommitments,
  ts,
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        prevHash,
        matchHash,
        decisionHash,
        makerEnrollmentId,
        takerEnrollmentId,
        ethers.keccak256(ethers.toUtf8Bytes(stableStringify(inputNoteIds || []))),
        ethers.keccak256(ethers.toUtf8Bytes(stableStringify(outputNoteCommitments || []))),
        BigInt(ts),
      ]
    )
  );
}

/**
 * Operator bookkeeping uses signed intent amount/limitPrice (or v2 ciphertext hashes).
 * The FHE matcher never returns plaintext execAmount/execPrice — see pathB metadata.
 */
function deriveLedgerBookkeeping({
  signedIntent,
  fillQty,
  attestation,
  role,
}) {
  const canonical = attestation?.canonical || {};
  const gross = b(signedIntent?.intent?.amount ?? fillQty);
  const fill = b(fillQty);
  const execGross = gross < fill ? gross : fill;
  const feeBps = BigInt(Math.max(0, DEFAULT_FEE_BPS));
  const protocolFeeAccrued = (execGross * feeBps) / 10000n;
  const net = execGross - protocolFeeAccrued;

  const bookkeeping = {
    schema: "phantom.pending-note.bookkeeping.v1",
    role,
    grossAmount: execGross.toString(),
    netAmount: net.toString(),
    protocolFeeBps: DEFAULT_FEE_BPS,
    protocolFeeAccrued: protocolFeeAccrued.toString(),
    limitPrice: String(signedIntent?.intent?.limitPrice ?? "0"),
    inputAssetID: String(signedIntent?.intent?.inputAssetID ?? "0"),
    outputAssetID: String(signedIntent?.intent?.outputAssetID ?? "0"),
    bookkeepingSource: "signed_intent",
    bookkeepingDisclaimer:
      "Matcher attestation carries ciphertext hashes only; amounts derived from user-signed intents for operator ledger math.",
  };

  if (canonical.execAmountCiphertextHash) {
    bookkeeping.execAmountCiphertextHash = String(canonical.execAmountCiphertextHash);
  }
  if (canonical.execPriceCiphertextHash) {
    bookkeeping.execPriceCiphertextHash = String(canonical.execPriceCiphertextHash);
  }
  if (canonical.execAmount != null || canonical.execPrice != null) {
    bookkeeping.legacyV1CanonicalLeak = true;
  }

  return bookkeeping;
}

function extractInputNoteIdsFromOrder(order) {
  if (!order?.encryptedPayload) return [];
  try {
    const env = decryptJsonAtRest(order.encryptedPayload);
    const envelope = env?.envelope;
    if (!envelope || typeof envelope !== "object") return [];
    if (Array.isArray(envelope.inputNoteIds)) {
      return envelope.inputNoteIds.map((id) => String(id)).filter(Boolean);
    }
    if (Array.isArray(envelope.noteRefs)) {
      return envelope.noteRefs.map((r) => (r && r.noteId ? String(r.noteId) : null)).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

function collectInputNoteIds(makerOrder, takerOrder, explicitIds) {
  const fromExplicit = Array.isArray(explicitIds) ? explicitIds.map(String).filter(Boolean) : [];
  if (fromExplicit.length > 0) return [...new Set(fromExplicit)];
  const makerIds = extractInputNoteIdsFromOrder(makerOrder);
  const takerIds = extractInputNoteIdsFromOrder(takerOrder);
  return [...new Set([...makerIds, ...takerIds])];
}

function markInputNotePendingSpent(db, noteId, matchHash) {
  const row = getEncryptedNote(db, noteId);
  if (!row) return false;
  let payload;
  try {
    payload = decryptJsonAtRest(row.payloadEnc);
  } catch {
    payload = {};
  }
  payload.internalMatchSpend = {
    status: "pending_spent",
    matchHash,
    markedAt: Date.now(),
  };
  const enc = encryptJsonAtRest(payload);
  saveEncryptedNote(db, row.noteId, row.ownerAddress, row.commitment, row.txHash, enc);
  return true;
}

function buildPendingNotePayload({
  role,
  matchHash,
  decisionHash,
  order,
  signedIntent,
  fillQty,
  attestation,
  inputNoteId,
}) {
  return {
    schema: "phantom.pending-note.v1",
    role,
    matchHash,
    decisionHash,
    orderId: order.id,
    owner: order.ownerAddress,
    side: order.side,
    pairBase: order.pairBase,
    pairQuote: order.pairQuote,
    inputNoteId: inputNoteId || null,
    ...deriveLedgerBookkeeping({ signedIntent, fillQty, attestation, role }),
  };
}

function applyMatch(db, params) {
  const {
    matchHash,
    decisionHash,
    attestation,
    makerOrder,
    takerOrder,
    makerSignedIntent,
    takerSignedIntent,
    inputNoteIds,
    fillQty,
  } = params;

  const existingAudit = getInternalMatchAuditByMatchHash(db, matchHash);
  if (existingAudit) {
    const pending = listPendingNotesByMatchHash(db, matchHash);
    return {
      idempotent: true,
      ledgerStatus: "ledger_applied",
      pendingNotesCreated: pending.length,
      auditEntryHash: existingAudit.entry_hash,
      pendingNoteIds: pending.map((n) => n.note_id),
      inputNoteIds: existingAudit.payload?.inputNoteIds || [],
    };
  }

  const makerEnrollment = getInternalMatchEnrollmentByUser(db, makerOrder.ownerAddress);
  const takerEnrollment = getInternalMatchEnrollmentByUser(db, takerOrder.ownerAddress);
  const makerEnrollmentId = makerEnrollment?.enrollmentId || ethers.ZeroHash;
  const takerEnrollmentId = takerEnrollment?.enrollmentId || ethers.ZeroHash;

  const resolvedInputNoteIds = collectInputNoteIds(makerOrder, takerOrder, inputNoteIds);
  for (const noteId of resolvedInputNoteIds) {
    markInputNotePendingSpent(db, noteId, matchHash);
  }

  const makerInputNoteId = extractInputNoteIdsFromOrder(makerOrder)[0] || resolvedInputNoteIds[0] || null;
  const takerInputNoteId = extractInputNoteIdsFromOrder(takerOrder)[0] || resolvedInputNoteIds[1] || resolvedInputNoteIds[0] || null;

  const now = Date.now();
  const makerNoteId = crypto.randomUUID();
  const takerNoteId = crypto.randomUUID();

  const makerPayload = buildPendingNotePayload({
    role: "maker",
    matchHash,
    decisionHash,
    order: makerOrder,
    signedIntent: makerSignedIntent,
    fillQty,
    attestation,
    inputNoteId: makerInputNoteId,
  });
  const takerPayload = buildPendingNotePayload({
    role: "taker",
    matchHash,
    decisionHash,
    order: takerOrder,
    signedIntent: takerSignedIntent,
    fillQty,
    attestation,
    inputNoteId: takerInputNoteId,
  });

  const makerCommitment = computeOutputNoteCommitment({
    noteId: makerNoteId,
    owner: makerOrder.ownerAddress,
    matchHash,
    role: "maker",
    inputNoteId: makerInputNoteId,
  });
  const takerCommitment = computeOutputNoteCommitment({
    noteId: takerNoteId,
    owner: takerOrder.ownerAddress,
    matchHash,
    role: "taker",
    inputNoteId: takerInputNoteId,
  });

  savePendingNote(db, {
    noteId: makerNoteId,
    owner: makerOrder.ownerAddress,
    matchHash,
    status: "pending",
    payloadEnc: encryptJsonAtRest(makerPayload),
    inputNoteId: makerInputNoteId,
    createdAt: now,
  });
  savePendingNote(db, {
    noteId: takerNoteId,
    owner: takerOrder.ownerAddress,
    matchHash,
    status: "pending",
    payloadEnc: encryptJsonAtRest(takerPayload),
    inputNoteId: takerInputNoteId,
    createdAt: now,
  });

  const prevEntry = getLatestInternalMatchAuditEntry(db);
  const prevHash = prevEntry?.entry_hash || ethers.ZeroHash;
  const outputNoteCommitments = [makerCommitment, takerCommitment];
  const auditPayload = {
    matchHash,
    decisionHash,
    makerEnrollmentId,
    takerEnrollmentId,
    inputNoteIds: resolvedInputNoteIds,
    outputNoteCommitments,
    pendingNoteIds: [makerNoteId, takerNoteId],
    ts: now,
  };
  const entryHash = computeAuditEntryHash({
    prevHash,
    matchHash,
    decisionHash,
    makerEnrollmentId,
    takerEnrollmentId,
    inputNoteIds: resolvedInputNoteIds,
    outputNoteCommitments,
    ts: now,
  });

  appendInternalMatchAuditEntry(db, {
    id: crypto.randomUUID(),
    prevHash,
    entryHash,
    matchHash,
    decisionHash,
    payloadJson: auditPayload,
    createdAt: now,
  });

  return {
    idempotent: false,
    ledgerStatus: "ledger_applied",
    pendingNotesCreated: 2,
    auditEntryHash: entryHash,
    pendingNoteIds: [makerNoteId, takerNoteId],
    outputNoteCommitments,
    inputNoteIds: resolvedInputNoteIds,
  };
}

function getPendingNotes(db, owner) {
  const rows = listPendingNotesByOwner(db, owner, "pending");
  return rows.map((row) => ({
    noteId: row.note_id,
    owner: row.owner,
    matchHash: row.match_hash,
    status: row.status,
    inputNoteId: row.input_note_id,
    createdAt: row.created_at,
  }));
}

function getMatchLedgerStatus(db, matchHash) {
  const audit = getInternalMatchAuditByMatchHash(db, matchHash);
  if (!audit) return null;
  const pending = listPendingNotesByMatchHash(db, matchHash);
  return {
    matchHash,
    status: pending.length > 0 ? "pending_notes_created" : "ledger_applied",
    ledgerApplied: true,
    ledgerStatus: "ledger_applied",
    audit: {
      entryHash: audit.entry_hash,
      prevHash: audit.prev_hash,
      decisionHash: audit.decision_hash,
      createdAt: audit.created_at,
    },
    pendingNotes: pending.map((row) => ({
      noteId: row.note_id,
      owner: row.owner,
      status: row.status,
      inputNoteId: row.input_note_id,
      createdAt: row.created_at,
    })),
    inputNoteIds: audit.payload?.inputNoteIds || [],
    outputNoteCommitments: audit.payload?.outputNoteCommitments || [],
    mode: "off_chain",
    txHash: null,
  };
}

module.exports = {
  applyMatch,
  getPendingNotes,
  getMatchLedgerStatus,
  computeAuditEntryHash,
  extractInputNoteIdsFromOrder,
  deriveLedgerBookkeeping,
};
