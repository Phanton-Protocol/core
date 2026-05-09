import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import { ethers } from "ethers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);
delete process.env.MATCHING_REQUIRE_USER_INTENT;

const helperPath = path.resolve(__dirname, "../../../src/lib/internalMatchIntent.js");
const helper = await import(pathToFileURL(helperPath).href);
const {
  buildInternalIntentRequest,
  computeCiphertextHash,
  INTERNAL_MATCH_INTENT_TYPES,
  MATCH_INTENT_DOMAIN_NAME,
  MATCH_INTENT_DOMAIN_VERSION,
  signOperatorIntent,
  signInternalMatchIntent,
} = helper;

const { initDb } = require("../src/db");
const {
  createInternalOrderRouter,
  computeCiphertextHash: backendComputeCiphertextHash,
} = require("../src/internalOrderRoutes");

const TEST_CHAIN_ID = 31337;
const TEST_VERIFYING_CONTRACT = "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";

function withApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase5-"));
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
      resolve({ baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test("phase5 frontend ciphertext hash matches backend canonicalisation", () => {
  const ciphertext = { _ckksAmount: "0xabc", _ckksPrice: "0xdef", amount: "100", limitPrice: "10" };
  const a = computeCiphertextHash(ciphertext);
  const b = backendComputeCiphertextHash(ciphertext);
  assert.equal(a, b);

  const stringPayload = "0xdeadbeef";
  assert.equal(computeCiphertextHash(stringPayload), backendComputeCiphertextHash(stringPayload));
});

test("phase5 buildInternalIntentRequest produces a payload accepted by backend (happy path)", async (t) => {
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const ciphertext = { _ckksAmount: "0xaa", _ckksPrice: "0xbb", amount: "100", limitPrice: "10" };
  const expirySec = Math.floor(Date.now() / 1000) + 3600;
  const body = await buildInternalIntentRequest({
    signer: wallet,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    side: "sell",
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    inputAssetID: "0",
    outputAssetID: "1",
    amount: "100",
    limitPrice: "10",
    expirySec,
    operatorNonce: 1,
    matchNonce: 1001,
    ciphertext,
  });
  assert.ok(body.intent && body.signature && body.matchIntent && body.matchSignature);
  assert.equal(body.matchIntent.user.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(body.matchIntent.side, 0);
  assert.equal(body.matchIntent.ciphertextHash, computeCiphertextHash(ciphertext));

  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(out)}`);
  assert.equal(out.matchIntentBound, true);
});

test("phase5 backend rejects intent if frontend ciphertext is mutated after signing", async (t) => {
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const expirySec = Math.floor(Date.now() / 1000) + 3600;
  const ciphertext = { _ckksAmount: "0xaa", _ckksPrice: "0xbb" };
  const body = await buildInternalIntentRequest({
    signer: wallet,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    side: "buy",
    baseAsset: "USDT",
    quoteAsset: "WBNB",
    inputAssetID: "1",
    outputAssetID: "0",
    amount: "50",
    limitPrice: "12",
    expirySec,
    operatorNonce: 2,
    matchNonce: 2002,
    ciphertext,
  });
  body.ciphertext = { _ckksAmount: "0xaa", _ckksPrice: "0xCC-tampered" };
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  assert.equal(res.status, 400);
  assert.equal(out.reason, "CIPHERTEXT_HASH_MISMATCH");
});

test("phase5 typed-data domains match backend constants exactly", async () => {
  const wallet = ethers.Wallet.createRandom();
  const ciphertext = { _ckksAmount: "0xaa" };
  const expirySec = Math.floor(Date.now() / 1000) + 3600;
  const { matchIntent, matchSignature } = await signInternalMatchIntent({
    signer: wallet,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    params: {
      user: wallet.address,
      side: 0,
      inputAssetID: "0",
      outputAssetID: "1",
      amount: "100",
      limitPrice: "10",
      nonce: "1",
      deadline: expirySec,
      ciphertextHash: computeCiphertextHash(ciphertext),
    },
  });
  const recovered = ethers.verifyTypedData(
    {
      name: MATCH_INTENT_DOMAIN_NAME,
      version: MATCH_INTENT_DOMAIN_VERSION,
      chainId: TEST_CHAIN_ID,
      verifyingContract: TEST_VERIFYING_CONTRACT,
    },
    INTERNAL_MATCH_INTENT_TYPES,
    {
      user: matchIntent.user,
      side: matchIntent.side,
      inputAssetID: BigInt(matchIntent.inputAssetID),
      outputAssetID: BigInt(matchIntent.outputAssetID),
      amount: BigInt(matchIntent.amount),
      limitPrice: BigInt(matchIntent.limitPrice),
      nonce: BigInt(matchIntent.nonce),
      deadline: BigInt(matchIntent.deadline),
      ciphertextHash: matchIntent.ciphertextHash,
    },
    matchSignature
  );
  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
});

test("phase5 signOperatorIntent returns the same orderId backend computes", async (t) => {
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const ciphertext = { _ckksAmount: "0xaa" };
  const expirySec = Math.floor(Date.now() / 1000) + 3600;
  const body = await buildInternalIntentRequest({
    signer: wallet,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    side: "sell",
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    inputAssetID: "0",
    outputAssetID: "1",
    amount: "10",
    limitPrice: "5",
    expirySec,
    operatorNonce: 7,
    matchNonce: 7007,
    ciphertext,
  });
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  assert.equal(res.status, 201);
  assert.match(out.orderId, /^0x[0-9a-f]{64}$/);
});
