const path = require("path");
const os = require("os");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { ORDER_STATUS } = require("../src/internalOrderLifecycle");
const { saveInternalOrder, getInternalOrderById } = require("../src/db");
const {
  configureMatchingEngine,
  runDeterministicMatchForOrder,
} = require("../src/fheMatchingService");

let BetterSqlite3;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch {
  BetterSqlite3 = null;
}

function mkOrderRow({ id, side, amount, price, nonce, createdAt }) {
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  return {
    id,
    ownerAddress: owner,
    signingKey: owner,
    pairBase: "BUSD",
    pairQuote: "WBNB",
    side,
    status: ORDER_STATUS.OPEN,
    amount: String(amount),
    limitPrice: String(price),
    remainingAmount: String(amount),
    filledAmount: "0",
    reservedAmount: "0",
    nonce: String(nonce),
    replayKey: ethers.keccak256(ethers.toUtf8Bytes(`replay:${id}`)),
    signatureHash: ethers.keccak256(ethers.toUtf8Bytes(`sig:${id}`)),
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

test("module2 sqlite mode prevents double reservation under parallel workers", async (t) => {
  if (!BetterSqlite3) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m2-sqlite-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new BetterSqlite3(path.join(dir, "relayer.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, ownerAddress TEXT NOT NULL, signingKey TEXT NOT NULL, pairBase TEXT NOT NULL, pairQuote TEXT NOT NULL,
      side TEXT NOT NULL, status TEXT NOT NULL, amount TEXT NOT NULL, limitPrice TEXT, remainingAmount TEXT NOT NULL, filledAmount TEXT NOT NULL,
      reservedAmount TEXT NOT NULL, nonce TEXT NOT NULL, replayKey TEXT NOT NULL, signatureHash TEXT NOT NULL, expiryTs INTEGER NOT NULL,
      encryptedPayload TEXT NOT NULL, normalizedPayload TEXT NOT NULL, matchRef TEXT, createdBy TEXT, updatedBy TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY, orderId TEXT NOT NULL, eventType TEXT NOT NULL, fromStatus TEXT, toStatus TEXT, reason TEXT, actor TEXT, metadataJson TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, matchHash TEXT NOT NULL UNIQUE, executionKey TEXT NOT NULL, pairBase TEXT NOT NULL, pairQuote TEXT NOT NULL,
      makerOrderId TEXT NOT NULL, takerOrderId TEXT NOT NULL, makerSide TEXT NOT NULL, takerSide TEXT NOT NULL, executionPrice TEXT NOT NULL,
      quantity TEXT NOT NULL, status TEXT NOT NULL, metadataJson TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY, matchId TEXT NOT NULL, orderId TEXT NOT NULL, side TEXT NOT NULL, quantity TEXT NOT NULL, price TEXT NOT NULL, isMaker INTEGER NOT NULL, createdAt INTEGER NOT NULL
    );
  `);

  const takerId = ethers.keccak256(ethers.toUtf8Bytes("sqlite-taker"));
  const makerId = ethers.keccak256(ethers.toUtf8Bytes("sqlite-maker"));
  saveInternalOrder(db, mkOrderRow({ id: takerId, side: "buy", amount: "100", price: "11", nonce: "1", createdAt: 1000 }));
  saveInternalOrder(db, mkOrderRow({ id: makerId, side: "sell", amount: "100", price: "10", nonce: "2", createdAt: 900 }));

  configureMatchingEngine({ db, reservationTtlMs: 1000 });
  const [r1, r2] = await Promise.all([
    runDeterministicMatchForOrder(takerId, "w1"),
    runDeterministicMatchForOrder(takerId, "w2"),
  ]);
  const matchedCount = Number(Boolean(r1.matched)) + Number(Boolean(r2.matched));
  assert.equal(matchedCount, 1);
  const takerAfter = getInternalOrderById(db, takerId);
  assert.equal(takerAfter.status, ORDER_STATUS.FILLED);
});
