const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { initDb, saveInternalOrder, getMatchByHash, listMatchDecisionsByOrder } = require("../src/db");
const {
  configureMatchingEngine,
  runDeterministicMatchForOrder,
  computeStableMatchHash,
  computeFheDecisionHash,
  REASON_CODES,
} = require("../src/fheMatchingService");
const { ORDER_STATUS } = require("../src/internalOrderLifecycle");

function mkOrderRow({
  id,
  side,
  amount = "100",
  remainingAmount = amount,
  filledAmount = "0",
  price = "10",
  nonce = "1",
  createdAt = Date.now(),
}) {
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  return {
    id: id || ethers.keccak256(ethers.toUtf8Bytes(`${side}:${nonce}:${createdAt}`)),
    ownerAddress: owner,
    signingKey: owner,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    side,
    status: ORDER_STATUS.OPEN,
    amount: String(amount),
    limitPrice: String(price),
    remainingAmount: String(remainingAmount),
    filledAmount: String(filledAmount),
    reservedAmount: "0",
    nonce: String(nonce),
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`rk:${owner}:${nonce}`)),
    signatureHash: ethers.keccak256(ethers.toUtf8Bytes(`sg:${owner}:${nonce}`)),
    expiryTs: Math.floor(Date.now() / 1000) + 3600,
    encryptedPayload: "{}",
    normalizedPayload: { side, amount: String(amount), limitPrice: String(price) },
    matchRef: null,
    createdBy: owner,
    updatedBy: owner,
    createdAt,
    updatedAt: createdAt,
  };
}

function withDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m3-"));
  const db = initDb(path.join(dir, "relayer.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return db;
}

test("module3 strict mode blocks when FHE unavailable", async (t) => {
  const db = withDb(t);
  configureMatchingEngine({
    db,
    fhePolicyMode: "strict",
    fheCompatibilityEvaluator: async () => {
      throw new Error("fhe down");
    },
  });
  const taker = mkOrderRow({ id: ethers.keccak256(ethers.toUtf8Bytes("m3-strict-taker")), side: "buy", price: "11", nonce: "1", createdAt: 2000 });
  const maker = mkOrderRow({ id: ethers.keccak256(ethers.toUtf8Bytes("m3-strict-maker")), side: "sell", price: "10", nonce: "2", createdAt: 1000 });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, maker);

  const out = await runDeterministicMatchForOrder(taker.id, "strict");
  assert.equal(out.matched, false);
  assert.equal(out.reasonCode, REASON_CODES.NO_COMPATIBLE_COUNTERPARTY);
  const decisions = listMatchDecisionsByOrder(db, taker.id, 20);
  assert.ok(decisions.some((d) => d.reasonCode === REASON_CODES.FHE_UNAVAILABLE));
});

test("module3 degraded mode can allow unavailable FHE and persists binding fields", async (t) => {
  const db = withDb(t);
  let firstAttempt = true;
  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
    fheCompatibilityEvaluator: async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("timeout");
      }
      return { compatible: true, code: "ok", attestationRef: "att:1" };
    },
  });

  const taker = mkOrderRow({ id: ethers.keccak256(ethers.toUtf8Bytes("m3-degraded-taker")), side: "buy", price: "11", nonce: "1", createdAt: 2000 });
  const maker = mkOrderRow({ id: ethers.keccak256(ethers.toUtf8Bytes("m3-degraded-maker")), side: "sell", price: "10", nonce: "2", createdAt: 1000 });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, maker);

  const out = await runDeterministicMatchForOrder(taker.id, "degraded");
  assert.equal(out.matched, true);
  const match = getMatchByHash(db, out.matchHash);
  assert.ok(match);
  assert.ok(match.fheResultHash);
  assert.ok(match.fheDecisionHash);
  assert.equal(match.decisionReasonCode, REASON_CODES.POLICY_DEGRADED_ALLOW);
});

test("module3 keeps matchHash stable while fheDecisionHash changes with metadata", () => {
  const stableInput = {
    pairBase: "BUSD",
    pairQuote: "WBNB",
    makerOrderId: "0x" + "11".repeat(32),
    takerOrderId: "0x" + "22".repeat(32),
    quantity: "10",
    executionPrice: "9",
  };
  const m1 = computeStableMatchHash(stableInput);
  const m2 = computeStableMatchHash(stableInput);
  assert.equal(m1, m2);

  const d1 = computeFheDecisionHash({
    matchHash: m1,
    executionKey: "0x" + "33".repeat(32),
    policyMode: "strict",
    degradedAllowUnavailable: false,
    reasonCode: "FHE_ACCEPTED",
    fheResultHash: "0x" + "44".repeat(32),
    fheAttestationRef: "att:a",
  });
  const d2 = computeFheDecisionHash({
    matchHash: m1,
    executionKey: "0x" + "33".repeat(32),
    policyMode: "strict",
    degradedAllowUnavailable: false,
    reasonCode: "FHE_ACCEPTED",
    fheResultHash: "0x" + "55".repeat(32),
    fheAttestationRef: "att:b",
  });
  assert.notEqual(d1, d2);
});

test("module3 continues matching loop after one FHE failure", async (t) => {
  const db = withDb(t);
  configureMatchingEngine({
    db,
    fhePolicyMode: "strict",
    fheCompatibilityEvaluator: async ({ candidate }) => {
      if (candidate.id === ethers.keccak256(ethers.toUtf8Bytes("m3-maker-best-price"))) {
        throw new Error("temporary_fhe_error");
      }
      return { compatible: true, code: "ok", attestationRef: "att:ok" };
    },
  });

  const taker = mkOrderRow({ id: ethers.keccak256(ethers.toUtf8Bytes("m3-loop-taker")), side: "buy", price: "11", nonce: "1", createdAt: 3000 });
  const makerBestPrice = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("m3-maker-best-price")),
    side: "sell",
    price: "9",
    nonce: "2",
    createdAt: 1000,
  });
  const makerSecond = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("m3-maker-second")),
    side: "sell",
    price: "10",
    nonce: "3",
    createdAt: 1001,
  });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, makerBestPrice);
  saveInternalOrder(db, makerSecond);

  const out = await runDeterministicMatchForOrder(taker.id, "loop");
  assert.equal(out.matched, true);
  assert.equal(out.makerOrderId, makerSecond.id);
});
