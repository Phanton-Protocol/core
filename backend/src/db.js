const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      intentId TEXT PRIMARY KEY,
      userAddress TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      intentId TEXT PRIMARY KEY,
      userAddress TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      userAddress TEXT,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commitments (
      commitment TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      txHash TEXT,
      createdAt INTEGER NOT NULL
    );
  `);

  return db;
}

function saveIntent(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO intents(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getIntent(db, intentId) {
  const row = db.prepare("SELECT * FROM intents WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return { intentId: row.intentId, userAddress: row.userAddress, payload: JSON.parse(row.payload) };
}

function saveReceipt(db, intentId, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO receipts(intentId, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(intentId, userAddress, JSON.stringify(payload), Date.now());
}

function getReceipt(db, intentId) {
  const row = db.prepare("SELECT * FROM receipts WHERE intentId = ?").get(intentId);
  if (!row) return null;
  return JSON.parse(row.payload);
}

function listReceipts(db, userAddress, limit = 50) {
  const rows = db
    .prepare(
      "SELECT payload FROM receipts WHERE userAddress = ? ORDER BY createdAt DESC LIMIT ?"
    )
    .all(userAddress, limit);
  return rows.map((r) => JSON.parse(r.payload));
}

function saveQuote(db, id, userAddress, payload) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO quotes(id, userAddress, payload, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(id, userAddress || null, JSON.stringify(payload), Date.now());
}

function saveCommitment(db, idx, commitment, txHash) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO commitments(commitment, idx, txHash, createdAt) VALUES (?, ?, ?, ?)"
  );
  stmt.run(commitment, idx, txHash || null, Date.now());
}

function listCommitments(db) {
  return db.prepare("SELECT commitment, idx FROM commitments ORDER BY idx ASC").all();
}

function getCommitment(db, commitment) {
  return db.prepare("SELECT commitment, idx FROM commitments WHERE commitment = ?").get(commitment);
}

function exportAll(db) {
  const intents = db.prepare("SELECT payload FROM intents ORDER BY createdAt DESC").all();
  const receipts = db.prepare("SELECT payload FROM receipts ORDER BY createdAt DESC").all();
  const quotes = db.prepare("SELECT payload FROM quotes ORDER BY createdAt DESC").all();
  const commitments = db.prepare("SELECT commitment, idx, txHash, createdAt FROM commitments ORDER BY idx ASC").all();
  return {
    intents: intents.map((r) => JSON.parse(r.payload)),
    receipts: receipts.map((r) => JSON.parse(r.payload)),
    quotes: quotes.map((r) => JSON.parse(r.payload)),
    commitments
  };
}

module.exports = {
  initDb,
  saveIntent,
  getIntent,
  saveReceipt,
  getReceipt,
  listReceipts,
  saveQuote,
  exportAll,
  saveCommitment,
  listCommitments,
  getCommitment
};
