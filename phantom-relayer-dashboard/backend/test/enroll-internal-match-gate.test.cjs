const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const { initDb, saveInternalMatchEnrollment } = require("../src/db");
const {
  createInternalOrderRouter,
  INTERNAL_ORDER_TYPES,
} = require("../src/internalOrderRoutes");

const TEST_CHAIN_ID = 31337;
const TEST_VERIFYING_CONTRACT = "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";

function seedEnrollment(db, ownerAddress) {
  saveInternalMatchEnrollment(db, {
    userAddress: ownerAddress.toLowerCase(),
    enrollmentId: ethers.keccak256(ethers.toUtf8Bytes(`enroll-${ownerAddress}`)),
    payloadHash: ethers.ZeroHash,
    encryptedPayload: null,
    txHash: "0x" + "cc".repeat(32),
    blockNumber: 1,
    createdAt: Date.now(),
  });
}

function withApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-enroll-gate-"));
  const dbPath = path.join(dir, "relayer.db");
  const db = initDb(dbPath);
  const router = createInternalOrderRouter({
    db,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  });
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/intent/internal", router);
  const server = app.listen(0);
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new Promise((resolve) => {
    server.once("listening", () => {
      const port = server.address().port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, db });
    });
  });
}

async function postIntent(baseUrl, body) {
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test("POST /intent/internal returns 403 enrollment_required without DB enrollment", async (t) => {
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(ethers.toUtf8Bytes("gate-no-enroll"));
  const intent = {
    owner: wallet.address,
    signingKey: wallet.address,
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    side: "sell",
    amount: "100",
    limitPrice: "10",
    expiry,
    nonce: "1",
    replayKey,
  };
  const domain = {
    name: "PhantomInternalOrder",
    version: "1",
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  };
  const typed = {
    owner: intent.owner,
    signingKey: intent.signingKey,
    baseAsset: intent.baseAsset,
    quoteAsset: intent.quoteAsset,
    side: intent.side,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
    replayKey: intent.replayKey,
  };
  const signature = await wallet.signTypedData(domain, INTERNAL_ORDER_TYPES, typed);
  const out = await postIntent(baseUrl, { intent, signature });
  assert.equal(out.status, 403);
  assert.equal(out.body?.error, "enrollment_required");
});

test("POST /intent/internal accepts order when enrollment row exists", async (t) => {
  const { baseUrl, db } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  seedEnrollment(db, wallet.address);
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(ethers.toUtf8Bytes("gate-with-enroll"));
  const intent = {
    owner: wallet.address,
    signingKey: wallet.address,
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    side: "sell",
    amount: "100",
    limitPrice: "10",
    expiry,
    nonce: "2",
    replayKey,
  };
  const domain = {
    name: "PhantomInternalOrder",
    version: "1",
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  };
  const typed = {
    owner: intent.owner,
    signingKey: intent.signingKey,
    baseAsset: intent.baseAsset,
    quoteAsset: intent.quoteAsset,
    side: intent.side,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
    replayKey: intent.replayKey,
  };
  const signature = await wallet.signTypedData(domain, INTERNAL_ORDER_TYPES, typed);
  const out = await postIntent(baseUrl, { intent, signature });
  assert.equal(out.status, 201);
});
