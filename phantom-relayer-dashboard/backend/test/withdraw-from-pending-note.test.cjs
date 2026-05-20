// M8 — pending-note → withdraw integration test.
//
// Exercises the off-chain ledger ↔ on-chain proof gate:
//   1. Seed a pending note (status=pending) with known netAmount + fee.
//   2. Pre-validate a "good" proof's public inputs → ok.
//   3. Pre-validate a "tampered" proof (lower fee) → rejected with explicit reason.
//   4. Mark the note withdrawn → status=withdrawn, audit log gets a
//      `withdraw_finalized` entry chained off the previous match entry.
//   5. Idempotency: a second mark on the same note is a no-op.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { ethers } = require("ethers");

process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const {
  initDb,
  saveInternalMatchEnrollment,
  saveEncryptedNote,
  getInternalMatchAuditByMatchHash,
  listPendingNotesByMatchHash,
  getPendingNoteById,
} = require("../src/db");
const {
  applyMatch,
  getWithdrawPlan,
  getPendingNoteBookkeeping,
  validatePendingNoteAgainstProof,
  markPendingNotesWithdrawn,
} = require("../src/pendingNoteLedger");
const { encryptJsonAtRest } = require("../src/noteCipher");

function seedEnrollment(db, owner) {
  saveInternalMatchEnrollment(db, {
    userAddress: owner.toLowerCase(),
    enrollmentId: ethers.keccak256(ethers.toUtf8Bytes(`enroll-${owner}`)),
    payloadHash: ethers.ZeroHash,
    encryptedPayload: null,
    txHash: "0x" + "aa".repeat(32),
    blockNumber: 1,
    createdAt: Date.now(),
  });
}

function mkOrder(id, owner) {
  return {
    id,
    ownerAddress: owner.toLowerCase(),
    side: id.includes("maker") ? "sell" : "buy",
    pairBase: "WBNB",
    pairQuote: "USDT",
    encryptedPayload: encryptJsonAtRest({
      envelope: { inputNoteIds: [`input-${id}`] },
    }),
  };
}

async function setupLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m8-withdraw-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = initDb(path.join(dir, "relayer.db"));
  const maker = ethers.Wallet.createRandom().address;
  const taker = ethers.Wallet.createRandom().address;
  seedEnrollment(db, maker);
  seedEnrollment(db, taker);
  saveEncryptedNote(db, "input-maker-1", maker, "0x" + "12".repeat(32), "0xtx", encryptJsonAtRest({ amount: "100" }));

  const matchHash = "0x" + "22".repeat(32);
  const decisionHash = "0x" + "33".repeat(32);

  // Use amounts large enough that the 0.2% fee rounds to a non-zero integer
  // (anything < 5000 floors to 0 fee under integer math).
  const makerSignedIntent = {
    intent: {
      user: maker,
      side: 0,
      inputAssetID: "0",
      outputAssetID: "1",
      amount: "100000",
      limitPrice: "10",
      nonce: "1",
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      ciphertextHash: "0x" + "44".repeat(32),
    },
    signature: "0x",
  };
  const takerSignedIntent = {
    intent: {
      user: taker,
      side: 1,
      inputAssetID: "1",
      outputAssetID: "0",
      amount: "80000",
      limitPrice: "12",
      nonce: "2",
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      ciphertextHash: "0x" + "55".repeat(32),
    },
    signature: "0x",
  };
  const attestation = {
    decisionHash,
    canonical: {
      v: "phantom-fhe-attestation/v2",
      matched: true,
      execAmountCiphertextHash: "0x" + "66".repeat(32),
      execPriceCiphertextHash: "0x" + "77".repeat(32),
    },
  };
  const out = applyMatch(db, {
    matchHash,
    decisionHash,
    attestation,
    makerOrder: mkOrder("maker-1", maker),
    takerOrder: mkOrder("taker-1", taker),
    makerSignedIntent,
    takerSignedIntent,
    inputNoteIds: ["input-maker-1"],
    fillQty: "80000",
  });
  assert.equal(out.ledgerStatus, "ledger_applied");

  const pending = listPendingNotesByMatchHash(db, matchHash);
  return { db, matchHash, decisionHash, maker, taker, pending };
}

test("M8 withdraw-plan surfaces pending notes with v2CircuitNeeded + bookkeeping", async (t) => {
  const { db, maker, pending } = await setupLedger(t);
  const plan = getWithdrawPlan(db, maker);
  assert.equal(plan.length, 1, "maker has one pending note");
  const note = plan[0];
  assert.equal(note.role, "maker");
  assert.equal(note.v2CircuitNeeded, true);
  assert.equal(note.bookkeepingSource, "signed_intent");
  // 80 fill * 20 bps = 16 fee on a grossExecAmount of 80 (signedIntent.amount=100; fillQty=80; execGross=min(100,80)=80)
  const grossBig = BigInt(note.grossAmount);
  const feeBig = BigInt(note.protocolFeeAccrued);
  const netBig = BigInt(note.netAmount);
  assert.equal(feeBig, (grossBig * 20n) / 10000n, "0.2% fee applied");
  assert.equal(netBig, grossBig - feeBig, "net = gross - fee");
  // ledger bookkeeping must NOT leak plaintext exec amount/price from the matcher
  const decoded = note;
  for (const k of Object.keys(decoded)) {
    assert.ok(!/^execAmount$|^execPrice$/.test(k), `plan must not surface ${k}`);
  }
  const rowOnDisk = getPendingNoteById(db, pending[0].note_id);
  assert.equal(rowOnDisk.status, "pending");
});

test("M8 proof validator accepts matching fee+net, rejects tampered fee", async (t) => {
  const { db, maker } = await setupLedger(t);
  const plan = getWithdrawPlan(db, maker);
  const note = plan[0];
  const detail = getPendingNoteBookkeeping(db, note.noteId);

  // Good proof: matches ledger.
  const ok = validatePendingNoteAgainstProof({
    pendingNote: detail,
    publicInputs: {
      protocolFee: note.protocolFeeAccrued,
      outputAmountSwap: note.netAmount,
    },
  });
  assert.equal(ok.ok, true);

  // Bad: relayer/operator tries to silently zero the fee.
  const badFee = validatePendingNoteAgainstProof({
    pendingNote: detail,
    publicInputs: {
      protocolFee: "0",
      outputAmountSwap: note.netAmount,
    },
  });
  assert.equal(badFee.ok, false);
  assert.equal(badFee.reason, "withdraw_fee_mismatch_ledger_vs_proof");

  // Bad: user tries to drain more than the ledger allowed.
  const badNet = validatePendingNoteAgainstProof({
    pendingNote: detail,
    publicInputs: {
      protocolFee: note.protocolFeeAccrued,
      outputAmountSwap: (BigInt(note.netAmount) + 1n).toString(),
    },
  });
  assert.equal(badNet.ok, false);
  assert.equal(badNet.reason, "withdraw_amount_mismatch_ledger_vs_proof");
});

test("M8 markPendingNotesWithdrawn flips status, links txHash, extends audit chain", async (t) => {
  const { db, matchHash, maker } = await setupLedger(t);
  const plan = getWithdrawPlan(db, maker);
  const noteId = plan[0].noteId;

  const mockTxHash = "0x" + "ab".repeat(32);
  const result = markPendingNotesWithdrawn(db, [noteId], mockTxHash);
  assert.equal(result.finalized.length, 1);
  assert.equal(result.finalized[0].withdrawTxHash, mockTxHash.toLowerCase());
  assert.ok(result.finalized[0].auditEntryHash);

  const after = getPendingNoteById(db, noteId);
  assert.equal(after.status, "withdrawn");
  assert.equal(String(after.withdraw_tx_hash || "").toLowerCase(), mockTxHash.toLowerCase());

  // audit chain — match entry + withdraw_finalized entry both exist for this matchHash
  const matchAudit = getInternalMatchAuditByMatchHash(db, matchHash);
  assert.ok(matchAudit);
  // re-query the audit table directly via the raw db to find the withdraw entry
  const rows = db
    .prepare("SELECT * FROM internal_match_audit_log WHERE match_hash = ? ORDER BY created_at ASC, id ASC")
    .all(matchHash);
  assert.ok(rows.length >= 2, "audit log gets a second entry for the withdraw");
  const withdrawRow = rows[rows.length - 1];
  const payload =
    typeof withdrawRow.payload_json === "string"
      ? JSON.parse(withdrawRow.payload_json)
      : withdrawRow.payload_json;
  assert.equal(payload.kind, "withdraw_finalized");
  assert.equal(payload.noteId, noteId);
  assert.equal(payload.withdrawTxHash, mockTxHash.toLowerCase());
  // chain: withdraw entry's prevHash == previous match entry's entry_hash
  assert.equal(withdrawRow.prev_hash, matchAudit.entry_hash);

  // Idempotent retry — second mark on the same note must NOT add another audit row.
  const second = markPendingNotesWithdrawn(db, [noteId], mockTxHash);
  assert.equal(second.finalized.length, 1);
  assert.equal(second.finalized[0].idempotent, true);
  const rowsAfter = db
    .prepare("SELECT COUNT(*) AS c FROM internal_match_audit_log WHERE match_hash = ?")
    .get(matchHash);
  assert.equal(rowsAfter.c, rows.length, "idempotent finalize does not duplicate audit entries");
});

test("M8 markPendingNotesWithdrawn skips unknown / already-withdrawn note ids without throwing", async (t) => {
  const { db } = await setupLedger(t);
  const result = markPendingNotesWithdrawn(db, ["does-not-exist"], "0xdead");
  assert.equal(result.finalized.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "not_found");
});
