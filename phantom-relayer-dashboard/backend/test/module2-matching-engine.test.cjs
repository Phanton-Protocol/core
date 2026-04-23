const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { initDb, saveInternalOrder, getInternalOrderById } = require("../src/db");
const { ORDER_STATUS } = require("../src/internalOrderLifecycle");
const {
  configureMatchingEngine,
  runDeterministicMatchForOrder,
  reconcileStaleReservations,
} = require("../src/fheMatchingService");

function mkOrderRow({
  id,
  side,
  amount = "100",
  filledAmount = "0",
  remainingAmount = amount,
  price = "10",
  nonce = "1",
  createdAt = Date.now(),
  status = ORDER_STATUS.OPEN,
  matchRef = null,
  updatedAt = createdAt,
  expiryTs = Math.floor(Date.now() / 1000) + 3600,
}) {
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  return {
    id: id || ethers.keccak256(ethers.toUtf8Bytes(`${side}:${nonce}:${createdAt}`)),
    ownerAddress: owner,
    signingKey: owner,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    side,
    status,
    amount: String(amount),
    limitPrice: String(price),
    remainingAmount: String(remainingAmount),
    filledAmount: String(filledAmount),
    reservedAmount: status === ORDER_STATUS.RESERVED ? String(remainingAmount) : "0",
    nonce: String(nonce),
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`replay:${owner}:${nonce}`)),
    signatureHash: ethers.keccak256(ethers.toUtf8Bytes(`sig:${owner}:${nonce}`)),
    expiryTs,
    encryptedPayload: "{}",
    normalizedPayload: { side, amount: String(amount), limitPrice: String(price) },
    matchRef,
    createdBy: owner,
    updatedBy: owner,
    createdAt,
    updatedAt,
  };
}

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m2-"));
  const db = initDb(path.join(dir, "relayer.db"));
  return { db, dir };
}

test("module2 deterministic price-time-nonce priority picks stable maker", async (t) => {
  const { db, dir } = createTempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  configureMatchingEngine({ db, reservationTtlMs: 1000 });

  const taker = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("taker")),
    side: "buy",
    amount: "100",
    remainingAmount: "100",
    price: "11",
    nonce: "9",
    createdAt: 2000,
  });
  const makerWorse = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("maker-worse")),
    side: "sell",
    amount: "100",
    remainingAmount: "100",
    price: "10",
    nonce: "1",
    createdAt: 1000,
  });
  const makerBest = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("maker-best")),
    side: "sell",
    amount: "100",
    remainingAmount: "100",
    price: "9",
    nonce: "2",
    createdAt: 1001,
  });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, makerWorse);
  saveInternalOrder(db, makerBest);

  const out = await runDeterministicMatchForOrder(taker.id, "determinism");
  assert.equal(out.matched, true);
  assert.equal(out.makerOrderId, makerBest.id);
});

test("module2 partial fills update residual order state correctly", async (t) => {
  const { db, dir } = createTempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  configureMatchingEngine({ db, reservationTtlMs: 1000 });

  const taker = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("partial-taker")),
    side: "sell",
    amount: "200",
    remainingAmount: "200",
    price: "9",
    nonce: "1",
    createdAt: 1000,
  });
  const maker = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("partial-maker")),
    side: "buy",
    amount: "50",
    remainingAmount: "50",
    price: "10",
    nonce: "2",
    createdAt: 900,
  });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, maker);

  const out = await runDeterministicMatchForOrder(taker.id, "partial");
  assert.equal(out.matched, true);
  const takerAfter = getInternalOrderById(db, taker.id);
  const makerAfter = getInternalOrderById(db, maker.id);
  assert.equal(takerAfter.status, ORDER_STATUS.PARTIALLY_FILLED);
  assert.equal(takerAfter.remainingAmount, "150");
  assert.equal(makerAfter.status, ORDER_STATUS.FILLED);
  assert.equal(makerAfter.remainingAmount, "0");
});

test("module2 JSON fallback retries are idempotent and stale reservations reconcile", async (t) => {
  const { db, dir } = createTempDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  configureMatchingEngine({ db, reservationTtlMs: 1 });

  const stale = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("stale-order")),
    side: "buy",
    status: ORDER_STATUS.RESERVED,
    amount: "10",
    remainingAmount: "10",
    filledAmount: "0",
    price: "8",
    nonce: "33",
    createdAt: 100,
    updatedAt: 100,
    matchRef: "exec:stale",
  });
  saveInternalOrder(db, stale);
  const rec = await reconcileStaleReservations("recovery");
  assert.ok(rec.released >= 1);
  const staleAfter = getInternalOrderById(db, stale.id);
  assert.equal(staleAfter.status, ORDER_STATUS.OPEN);

  const taker = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("retry-taker")),
    side: "buy",
    amount: "20",
    remainingAmount: "20",
    price: "10",
    nonce: "100",
    createdAt: 1000,
  });
  const maker = mkOrderRow({
    id: ethers.keccak256(ethers.toUtf8Bytes("retry-maker")),
    side: "sell",
    amount: "20",
    remainingAmount: "20",
    price: "9",
    nonce: "101",
    createdAt: 900,
  });
  saveInternalOrder(db, taker);
  saveInternalOrder(db, maker);

  const first = await runDeterministicMatchForOrder(taker.id, "retry");
  const second = await runDeterministicMatchForOrder(taker.id, "retry");
  assert.equal(first.matched, true);
  assert.equal(second.matched, false);
});
