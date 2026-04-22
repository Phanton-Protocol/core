const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { initDb, saveMatch, saveFill } = require("../src/db");
const { createSettlementCoordinator, PRECHECK_REASON, SETTLEMENT_STATUS } = require("../src/settlementCoordinator");

function withDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m4-"));
  const db = initDb(path.join(dir, "relayer.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

function seedMatch(db, overrides = {}) {
  const matchHash = overrides.matchHash || ethers.keccak256(ethers.toUtf8Bytes(`m4:${Math.random()}`));
  const matchId = overrides.id || cryptoRandomId();
  saveMatch(db, {
    id: matchId,
    matchHash,
    executionKey: overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes(`exec:${matchHash}`)),
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerOrderId: "0x" + "11".repeat(32),
    takerOrderId: "0x" + "22".repeat(32),
    makerSide: "sell",
    takerSide: "buy",
    executionPrice: "10",
    quantity: overrides.quantity || "100",
    status: "finalized",
    decisionReasonCode: "FHE_ACCEPTED",
    fheResultHash: overrides.fheResultHash || "0x" + "33".repeat(32),
    fheDecisionHash: overrides.fheDecisionHash || "0x" + "44".repeat(32),
    fheAttestationRef: "att:1",
    metadataJson: overrides.metadataJson || {
      noteRefs: [{ noteId: "n1" }],
      witness: { merkleRoot: "0x" + "55".repeat(32) },
      changeAmount: "0",
    },
    createdAt: Date.now(),
  });
  saveFill(db, {
    id: cryptoRandomId(),
    matchId,
    orderId: "0x" + "11".repeat(32),
    side: "sell",
    quantity: overrides.quantity || "100",
    price: "10",
    isMaker: true,
    createdAt: Date.now(),
  });
  saveFill(db, {
    id: cryptoRandomId(),
    matchId,
    orderId: "0x" + "22".repeat(32),
    side: "buy",
    quantity: overrides.quantity || "100",
    price: "10",
    isMaker: false,
    createdAt: Date.now(),
  });
  return { matchHash, executionKey: overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes(`exec:${matchHash}`)) };
}

function cryptoRandomId() {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

test("module4 conservation and fee math precheck passes coherent payload", (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, { quantity: "100" });
  const coordinator = createSettlementCoordinator({ db });
  const status = coordinator.start(matchHash, {
    policy: { protocolFeeBps: 100, gasRefundWei: "0", submissionMode: "dry_run" },
  });
  assert.equal(status.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  const out = coordinator.getStatus(matchHash);
  assert.ok(out.execution.payloadJson);
  const p = out.execution.payloadJson;
  assert.equal(
    BigInt(p.amounts.inputAmount).toString(),
    (BigInt(p.amounts.matchedOut) + BigInt(p.amounts.changeAmount) + BigInt(p.amounts.protocolFee) + BigInt(p.amounts.gasRefund)).toString()
  );
});

test("module4 precheck failure taxonomy persists without corrupting match/fill", (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    metadataJson: {
      noteRefs: [],
      witness: null,
      changeAmount: "0",
    },
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = coordinator.start(matchHash, {
    policy: { allowFallback: false, fallbackMode: "none" },
  });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.FAILED);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.MISSING_NOTE_REFERENCES);
  const status = coordinator.getStatus(matchHash);
  assert.ok(status.events.some((e) => e.reasonCode === PRECHECK_REASON.MISSING_NOTE_REFERENCES));
});

test("module4 idempotent re-trigger returns already submitted without duplicate submit", (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {});
  let submits = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: ({ payload }) => {
      submits += 1;
      return { txHash: ethers.keccak256(ethers.toUtf8Bytes(payload.matchHash)) };
    },
  });
  const first = coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  const second = coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(first.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
  assert.equal(second.idempotent, true);
  assert.equal(submits, 1);
});

test("module4 transient failure -> retriable then explicit retry succeeds", (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {});
  let calls = 0;
  const coordinator = createSettlementCoordinator({
    db,
    submitter: ({ payload }) => {
      calls += 1;
      if (calls === 1) throw new Error("network timeout");
      return { txHash: ethers.keccak256(ethers.toUtf8Bytes(`${payload.matchHash}:ok`)) };
    },
  });
  const first = coordinator.start(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(first.settlementStatus, SETTLEMENT_STATUS.RETRIABLE);
  assert.equal(first.decisionReasonCode, PRECHECK_REASON.SUBMIT_TRANSIENT_ERROR);
  const second = coordinator.retry(matchHash, { policy: { submissionMode: "live" } });
  assert.equal(second.settlementStatus, SETTLEMENT_STATUS.SUBMITTED);
});

test("module4 explicit fallback enabled routes deterministically and persists reason", (t) => {
  const db = withDb(t);
  const { matchHash } = seedMatch(db, {
    metadataJson: {
      noteRefs: [],
      witness: null,
      changeAmount: "0",
    },
  });
  const coordinator = createSettlementCoordinator({ db });
  const out = coordinator.start(matchHash, {
    policy: { allowFallback: true, fallbackMode: "shieldedSwapJoinSplit" },
  });
  assert.equal(out.settlementStatus, SETTLEMENT_STATUS.RETRIABLE);
  assert.equal(out.decisionReasonCode, PRECHECK_REASON.FALLBACK_ROUTED);
  const status = coordinator.getStatus(matchHash);
  assert.ok(status.execution.fallbackMode === "shieldedSwapJoinSplit");
  assert.ok(status.events.some((e) => e.eventType === "settlement_fallback_routed"));
});
