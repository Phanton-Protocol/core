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
  getPendingNoteById,
  updatePendingNoteStatus,
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

/**
 * Returns the decrypted bookkeeping payload for a pending note.
 *
 * V2_CIRCUIT_NEEDED:
 *   In v1 we cannot expose the matched output amount on-chain as a fresh commitment
 *   (the existing join-split circuit does not natively express the matched-output
 *   amount transformation without an internal-match settle on chain). The withdraw
 *   planner therefore returns the pre-match deposit note as the spendable input
 *   and the operator bookkeeping (netAmount, protocolFeeAccrued) as the off-chain
 *   adjustment that the proof's swap/output amounts MUST equal. The proof's
 *   protocolFee public input MUST equal `protocolFeeAccrued`. See
 *   `docs/internal-matching-path-b-architecture.md` §M8.
 */
function getPendingNoteBookkeeping(db, noteId) {
  const row = getPendingNoteById(db, noteId);
  if (!row) return null;
  let payload = {};
  try {
    payload = decryptJsonAtRest(row.payload_enc);
  } catch {
    payload = {};
  }
  return {
    noteId: row.note_id,
    owner: row.owner,
    matchHash: row.match_hash,
    status: row.status,
    inputNoteId: row.input_note_id,
    createdAt: row.created_at,
    withdrawTxHash: row.withdraw_tx_hash || null,
    withdrawnAt: row.withdrawn_at || null,
    bookkeeping: payload,
  };
}

/**
 * Build a withdraw plan view of all spendable pending notes for an owner.
 * Surfaces only the fields the frontend needs to construct the join-split proof
 * (asset IDs + net + fee). NEVER returns plaintext exec amount/price from the
 * matcher attestation; bookkeeping fields come from the user-signed intent.
 */
function getWithdrawPlan(db, owner) {
  const rows = listPendingNotesByOwner(db, owner, "pending");
  return rows
    .map((row) => {
      const detail = getPendingNoteBookkeeping(db, row.note_id);
      if (!detail) return null;
      const bk = detail.bookkeeping || {};
      return {
        noteId: detail.noteId,
        owner: detail.owner,
        matchHash: detail.matchHash,
        status: detail.status,
        inputNoteId: detail.inputNoteId,
        role: bk.role || null,
        inputAssetID: bk.inputAssetID || null,
        outputAssetID: bk.outputAssetID || null,
        grossAmount: bk.grossAmount || null,
        netAmount: bk.netAmount || null,
        protocolFeeAccrued: bk.protocolFeeAccrued || null,
        protocolFeeBps: bk.protocolFeeBps || null,
        limitPrice: bk.limitPrice || null,
        bookkeepingSource: bk.bookkeepingSource || "signed_intent",
        createdAt: detail.createdAt,
        v2CircuitNeeded: true,
      };
    })
    .filter(Boolean);
}

/**
 * Validate that the withdraw proof public inputs honor the pending note's
 * accrued bookkeeping (fee math). v1 contract: the proof's `protocolFee`
 * MUST equal `protocolFeeAccrued` (in token wei) and the proof's
 * `outputAmountSwap` (or `swapAmount`) MUST equal `netAmount`.
 * The relayer rejects the withdraw on mismatch before it touches chain.
 */
function validatePendingNoteAgainstProof({ pendingNote, publicInputs }) {
  if (!pendingNote || !pendingNote.bookkeeping) {
    return { ok: false, reason: "pending_note_missing" };
  }
  if (pendingNote.status !== "pending") {
    return { ok: false, reason: `pending_note_status_${pendingNote.status}` };
  }
  const bk = pendingNote.bookkeeping;
  const pi = publicInputs || {};
  const proofFee = b(pi.protocolFee);
  const ledgerFee = b(bk.protocolFeeAccrued);
  if (proofFee !== ledgerFee) {
    return {
      ok: false,
      reason: "withdraw_fee_mismatch_ledger_vs_proof",
      ledgerFee: ledgerFee.toString(),
      proofFee: proofFee.toString(),
    };
  }
  const proofOut = b(pi.outputAmountSwap ?? pi.swapAmount ?? "0");
  const ledgerNet = b(bk.netAmount);
  if (ledgerNet > 0n && proofOut !== ledgerNet) {
    return {
      ok: false,
      reason: "withdraw_amount_mismatch_ledger_vs_proof",
      ledgerNet: ledgerNet.toString(),
      proofOut: proofOut.toString(),
    };
  }
  return { ok: true };
}

/**
 * Mark pending notes withdrawn AND extend the hash-chained audit log with
 * a `withdraw_finalized` entry that ties the off-chain ledger row to the
 * on-chain withdraw tx hash. Same chaining rules as `applyMatch`.
 */
function markPendingNotesWithdrawn(db, noteIds, withdrawTxHash) {
  const finalized = [];
  const skipped = [];
  for (const rawId of noteIds || []) {
    const noteId = String(rawId);
    if (!noteId) continue;
    const row = getPendingNoteById(db, noteId);
    if (!row) {
      skipped.push({ noteId, reason: "not_found" });
      continue;
    }
    if (row.status === "withdrawn") {
      finalized.push({
        noteId,
        owner: row.owner,
        matchHash: row.match_hash,
        idempotent: true,
        withdrawTxHash: row.withdraw_tx_hash,
      });
      continue;
    }
    if (row.status !== "pending") {
      skipped.push({ noteId, reason: `status_${row.status}` });
      continue;
    }
    const now = Date.now();
    updatePendingNoteStatus(db, noteId, "withdrawn", withdrawTxHash, now);

    const prevEntry = getLatestInternalMatchAuditEntry(db);
    const prevHash = prevEntry?.entry_hash || ethers.ZeroHash;
    const auditPayload = {
      kind: "withdraw_finalized",
      noteId,
      owner: row.owner,
      matchHash: row.match_hash,
      withdrawTxHash: String(withdrawTxHash || "").toLowerCase(),
      ts: now,
    };
    const entryHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
        [
          prevHash,
          row.match_hash,
          ethers.ZeroHash,
          ethers.keccak256(ethers.toUtf8Bytes("phantom.audit.withdraw_finalized.v1")),
          ethers.keccak256(ethers.toUtf8Bytes(noteId)),
          BigInt(now),
        ]
      )
    );
    appendInternalMatchAuditEntry(db, {
      id: crypto.randomUUID(),
      prevHash,
      entryHash,
      matchHash: row.match_hash,
      decisionHash: ethers.ZeroHash,
      payloadJson: auditPayload,
      createdAt: now,
    });
    finalized.push({
      noteId,
      owner: row.owner,
      matchHash: row.match_hash,
      withdrawTxHash: auditPayload.withdrawTxHash,
      auditEntryHash: entryHash,
      idempotent: false,
    });
  }
  return { finalized, skipped };
}

module.exports = {
  applyMatch,
  getPendingNotes,
  getMatchLedgerStatus,
  computeAuditEntryHash,
  extractInputNoteIdsFromOrder,
  deriveLedgerBookkeeping,
  getPendingNoteBookkeeping,
  getWithdrawPlan,
  validatePendingNoteAgainstProof,
  markPendingNotesWithdrawn,
};
