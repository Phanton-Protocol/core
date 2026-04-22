const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");
const { initDb } = require("../src/db");
const { createInternalOrderRouter, INTERNAL_ORDER_TYPES, computeOrderId, INTERNAL_CANCEL_TYPES } = require("../src/internalOrderRoutes");

process.env.NOTES_ENCRYPTION_KEY_HEX =
  process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const DOMAIN = {
  name: "PhantomInternalOrder",
  version: "1",
  chainId: 97,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

function mkIntent(overrides = {}) {
  return {
    owner: overrides.owner,
    signingKey: overrides.signingKey,
    baseAsset: "BUSD",
    quoteAsset: "WBNB",
    side: "sell",
    amount: "1000000000000000000",
    limitPrice: "500000000",
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: "7",
    replayKey: "0x" + "33".repeat(32),
    ...overrides,
  };
}

async function withServer(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-m1-"));
  const dbPath = path.join(tmpDir, "relayer.db");
  const db = initDb(dbPath);
  const app = express();
  app.use(express.json());
  app.use("/intent/internal", createInternalOrderRouter({ db, chainId: DOMAIN.chainId, verifyingContract: DOMAIN.verifyingContract }));
  const server = app.listen(0);
  t.after(() => server.close());
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { baseUrl: `http://127.0.0.1:${port}`, db };
}

test("module1 create -> query -> cancel lifecycle", async (t) => {
  const { baseUrl } = await withServer(t);
  const wallet = ethers.Wallet.createRandom();
  const intent = mkIntent({ owner: wallet.address, signingKey: wallet.address });
  const typed = {
    ...intent,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
  };
  const sig = await wallet.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, typed);
  const createRes = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent,
      signature: sig,
      envelope: { sealed: "payload" },
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.status, "open");
  const expectedId = computeOrderId(intent, DOMAIN);
  assert.equal(created.orderId, expectedId);

  const getRes = await fetch(`${baseUrl}/intent/internal/${created.orderId}`);
  assert.equal(getRes.status, 200);
  const snapshot = await getRes.json();
  assert.equal(snapshot.order.status, "open");
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventType, "order_created");

  const cancelPayload = {
    owner: wallet.address,
    reason: "user_request",
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const cancelSig = await wallet.signTypedData(DOMAIN, INTERNAL_CANCEL_TYPES, {
    orderId: created.orderId,
    owner: cancelPayload.owner,
    reason: cancelPayload.reason,
    nonce: BigInt(cancelPayload.nonce),
    deadline: BigInt(cancelPayload.deadline),
  });
  const cancelRes = await fetch(`${baseUrl}/intent/internal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: created.orderId, cancel: cancelPayload, signature: cancelSig }),
  });
  assert.equal(cancelRes.status, 200);
  const cancelled = await cancelRes.json();
  assert.equal(cancelled.status, "cancelled");
});

test("module1 rejects duplicate replay and duplicate nonce", async (t) => {
  const { baseUrl } = await withServer(t);
  const wallet = ethers.Wallet.createRandom();
  const intent = mkIntent({ owner: wallet.address, signingKey: wallet.address, nonce: "10", replayKey: "0x" + "44".repeat(32) });
  const sig = await wallet.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, {
    ...intent,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
  });
  const first = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature: sig }),
  });
  assert.equal(first.status, 201);
  const sameReq = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature: sig }),
  });
  assert.equal(sameReq.status, 200);
  assert.equal((await sameReq.json()).idempotent, true);

  const replayConflictIntent = mkIntent({
    owner: wallet.address,
    signingKey: wallet.address,
    nonce: "11",
    replayKey: intent.replayKey,
  });
  const replaySig = await wallet.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, {
    ...replayConflictIntent,
    amount: BigInt(replayConflictIntent.amount),
    limitPrice: BigInt(replayConflictIntent.limitPrice),
    expiry: BigInt(replayConflictIntent.expiry),
    nonce: BigInt(replayConflictIntent.nonce),
  });
  const replayConflict = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: replayConflictIntent, signature: replaySig }),
  });
  assert.equal(replayConflict.status, 409);
});

test("module1 rejects expired order and invalid signer", async (t) => {
  const { baseUrl } = await withServer(t);
  const owner = ethers.Wallet.createRandom();
  const signer = ethers.Wallet.createRandom();
  const expiredIntent = mkIntent({
    owner: owner.address,
    signingKey: owner.address,
    expiry: String(Math.floor(Date.now() / 1000) - 1),
    replayKey: "0x" + "55".repeat(32),
  });
  const expiredSig = await owner.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, {
    ...expiredIntent,
    amount: BigInt(expiredIntent.amount),
    limitPrice: BigInt(expiredIntent.limitPrice),
    expiry: BigInt(expiredIntent.expiry),
    nonce: BigInt(expiredIntent.nonce),
  });
  const expiredRes = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: expiredIntent, signature: expiredSig }),
  });
  assert.equal(expiredRes.status, 400);

  const invalidIntent = mkIntent({
    owner: owner.address,
    signingKey: owner.address,
    replayKey: "0x" + "66".repeat(32),
  });
  const invalidSig = await signer.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, {
    ...invalidIntent,
    amount: BigInt(invalidIntent.amount),
    limitPrice: BigInt(invalidIntent.limitPrice),
    expiry: BigInt(invalidIntent.expiry),
    nonce: BigInt(invalidIntent.nonce),
  });
  const invalidSignerRes = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: invalidIntent, signature: invalidSig }),
  });
  assert.equal(invalidSignerRes.status, 400);
});

test("module1 cancel enforces owner auth and state", async (t) => {
  const { baseUrl } = await withServer(t);
  const owner = ethers.Wallet.createRandom();
  const attacker = ethers.Wallet.createRandom();
  const intent = mkIntent({
    owner: owner.address,
    signingKey: owner.address,
    nonce: "20",
    replayKey: "0x" + "77".repeat(32),
  });
  const sig = await owner.signTypedData(DOMAIN, INTERNAL_ORDER_TYPES, {
    ...intent,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
  });
  const created = await (await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature: sig }),
  })).json();

  const cancelBody = {
    orderId: created.orderId,
    cancel: {
      owner: owner.address,
      reason: "stop",
      nonce: "1",
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
    },
  };
  const badSig = await attacker.signTypedData(DOMAIN, INTERNAL_CANCEL_TYPES, {
    orderId: cancelBody.orderId,
    owner: cancelBody.cancel.owner,
    reason: cancelBody.cancel.reason,
    nonce: BigInt(cancelBody.cancel.nonce),
    deadline: BigInt(cancelBody.cancel.deadline),
  });
  const unauthorized = await fetch(`${baseUrl}/intent/internal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...cancelBody, signature: badSig }),
  });
  assert.equal(unauthorized.status, 403);

  const ownerSig = await owner.signTypedData(DOMAIN, INTERNAL_CANCEL_TYPES, {
    orderId: cancelBody.orderId,
    owner: cancelBody.cancel.owner,
    reason: cancelBody.cancel.reason,
    nonce: BigInt(cancelBody.cancel.nonce),
    deadline: BigInt(cancelBody.cancel.deadline),
  });
  const ok = await fetch(`${baseUrl}/intent/internal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...cancelBody, signature: ownerSig }),
  });
  assert.equal(ok.status, 200);

  const alreadyCancelled = await fetch(`${baseUrl}/intent/internal/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...cancelBody, signature: ownerSig }),
  });
  assert.equal(alreadyCancelled.status, 409);
});
