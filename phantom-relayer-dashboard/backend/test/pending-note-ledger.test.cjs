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
  getEncryptedNote,
  getInternalMatchAuditByMatchHash,
  listPendingNotesByMatchHash,
} = require("../src/db");
const { applyMatch, computeAuditEntryHash } = require("../src/pendingNoteLedger");
const { encryptJsonAtRest, decryptJsonAtRest } = require("../src/noteCipher");

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

function mkOrder(id, owner, envelopeNoteIds) {
  return {
    id,
    ownerAddress: owner.toLowerCase(),
    side: id.includes("maker") ? "sell" : "buy",
    pairBase: "WBNB",
    pairQuote: "USDT",
    encryptedPayload: encryptJsonAtRest({
      envelope: { inputNoteIds: envelopeNoteIds },
    }),
  };
}

test("applyMatch creates hash-chained audit log and pending notes without plaintext exec fields", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = initDb(path.join(dir, "relayer.db"));

  const maker = ethers.Wallet.createRandom().address;
  const taker = ethers.Wallet.createRandom().address;
  seedEnrollment(db, maker);
  seedEnrollment(db, taker);

  const inputNoteId = "note-input-1";
  saveEncryptedNote(db, inputNoteId, maker, "0x" + "11".repeat(32), "0xtx", encryptJsonAtRest({ amount: "100" }));

  const matchHash = "0x" + "22".repeat(32);
  const decisionHash = "0x" + "33".repeat(32);
  const makerSignedIntent = {
    intent: {
      user: maker,
      side: 0,
      inputAssetID: "0",
      outputAssetID: "1",
      amount: "100",
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
      amount: "80",
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
    makerOrder: mkOrder("maker-1", maker, [inputNoteId]),
    takerOrder: mkOrder("taker-1", taker, []),
    makerSignedIntent,
    takerSignedIntent,
    inputNoteIds: [inputNoteId],
    fillQty: "80",
  });

  assert.equal(out.ledgerStatus, "ledger_applied");
  assert.equal(out.pendingNotesCreated, 2);

  const audit = getInternalMatchAuditByMatchHash(db, matchHash);
  assert.ok(audit, "audit row required");
  assert.ok(audit.entry_hash);
  assert.equal(audit.prev_hash, ethers.ZeroHash);
  const payloadStr = JSON.stringify(audit.payload);
  assert.ok(!payloadStr.includes("execAmount"), "audit payload must not contain execAmount");
  assert.ok(!payloadStr.includes("execPrice"), "audit payload must not contain execPrice");

  const pending = listPendingNotesByMatchHash(db, matchHash);
  assert.equal(pending.length, 2);
  for (const row of pending) {
    const raw = JSON.stringify(row);
    assert.ok(!raw.includes('"execAmount"'), "pending_notes row must not store execAmount");
    assert.ok(!raw.includes('"execPrice"'), "pending_notes row must not store execPrice");
    const decoded = decryptJsonAtRest(row.payload_enc);
    assert.ok(decoded.netAmount, "encrypted payload carries bookkeeping netAmount");
    assert.equal(decoded.bookkeepingSource, "signed_intent");
  }

  const spent = decryptJsonAtRest(getEncryptedNote(db, inputNoteId).payloadEnc);
  assert.equal(spent.internalMatchSpend.status, "pending_spent");

  const out2 = applyMatch(db, {
    matchHash,
    decisionHash,
    attestation,
    makerOrder: mkOrder("maker-1", maker, [inputNoteId]),
    takerOrder: mkOrder("taker-1", taker, []),
    makerSignedIntent,
    takerSignedIntent,
    fillQty: "80",
  });
  assert.equal(out2.idempotent, true);

  const secondAudit = db
    .prepare("SELECT COUNT(*) AS c FROM internal_match_audit_log WHERE match_hash = ?")
    .get(matchHash);
  assert.equal(secondAudit.c, 1, "audit chain must not duplicate match entry");
});

test("audit entry hash matches H(prev‖match‖decision‖enrollments‖notes‖commits‖ts)", () => {
  const prevHash = ethers.ZeroHash;
  const matchHash = "0x" + "22".repeat(32);
  const decisionHash = "0x" + "33".repeat(32);
  const makerEnrollmentId = "0x" + "aa".repeat(32);
  const takerEnrollmentId = "0x" + "bb".repeat(32);
  const inputNoteIds = ["n1"];
  const outputNoteCommitments = ["0x" + "cc".repeat(32)];
  const ts = 1700000000000;
  const h = computeAuditEntryHash({
    prevHash,
    matchHash,
    decisionHash,
    makerEnrollmentId,
    takerEnrollmentId,
    inputNoteIds,
    outputNoteCommitments,
    ts,
  });
  assert.equal(h.length, 66);
});
