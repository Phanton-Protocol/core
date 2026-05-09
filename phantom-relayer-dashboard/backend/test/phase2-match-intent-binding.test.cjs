const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const { initDb } = require("../src/db");
const {
  createInternalOrderRouter,
  INTERNAL_ORDER_TYPES,
  INTERNAL_MATCH_INTENT_TYPES,
  MATCH_INTENT_DOMAIN_NAME,
  MATCH_INTENT_DOMAIN_VERSION,
  computeCiphertextHash,
} = require("../src/internalOrderRoutes");

const TEST_CHAIN_ID = 31337;
const TEST_VERIFYING_CONTRACT = "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";

function withApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase2-"));
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

async function buildSignedRequest({ wallet, side = "sell", amount = "100", limitPrice = "10", inputAssetID = "0", outputAssetID = "1", nonce = 1, matchNonce = 1001, ciphertext = { secret: "amount", v: "x" }, includeMatchIntent = true, mutateCiphertextBeforeSign = false }) {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(ethers.toUtf8Bytes(`replay-${wallet.address}-${nonce}-${Date.now()}`));
  const operatorIntent = {
    owner: wallet.address,
    signingKey: wallet.address,
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    side,
    amount,
    limitPrice,
    expiry,
    nonce: String(nonce),
    replayKey,
  };
  const opDomain = {
    name: "PhantomInternalOrder",
    version: "1",
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  };
  const opTyped = {
    owner: operatorIntent.owner,
    signingKey: operatorIntent.signingKey,
    baseAsset: operatorIntent.baseAsset,
    quoteAsset: operatorIntent.quoteAsset,
    side: operatorIntent.side,
    amount: BigInt(operatorIntent.amount),
    limitPrice: BigInt(operatorIntent.limitPrice),
    expiry: BigInt(operatorIntent.expiry),
    nonce: BigInt(operatorIntent.nonce),
    replayKey: operatorIntent.replayKey,
  };
  const opSig = await wallet.signTypedData(opDomain, INTERNAL_ORDER_TYPES, opTyped);

  if (!includeMatchIntent) {
    return { intent: operatorIntent, signature: opSig };
  }

  const ciphertextForHash = mutateCiphertextBeforeSign
    ? { ...ciphertext, tampered: true }
    : ciphertext;
  const ciphertextHash = computeCiphertextHash(ciphertextForHash);
  const matchIntent = {
    user: wallet.address,
    side: side === "sell" ? 0 : 1,
    inputAssetID,
    outputAssetID,
    amount,
    limitPrice,
    nonce: String(matchNonce),
    deadline: expiry,
    ciphertextHash,
  };
  const matchDomain = {
    name: MATCH_INTENT_DOMAIN_NAME,
    version: MATCH_INTENT_DOMAIN_VERSION,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  };
  const matchTyped = {
    user: matchIntent.user,
    side: matchIntent.side,
    inputAssetID: BigInt(matchIntent.inputAssetID),
    outputAssetID: BigInt(matchIntent.outputAssetID),
    amount: BigInt(matchIntent.amount),
    limitPrice: BigInt(matchIntent.limitPrice),
    nonce: BigInt(matchIntent.nonce),
    deadline: BigInt(matchIntent.deadline),
    ciphertextHash: matchIntent.ciphertextHash,
  };
  const matchSig = await wallet.signTypedData(matchDomain, INTERNAL_MATCH_INTENT_TYPES, matchTyped);
  return {
    intent: operatorIntent,
    signature: opSig,
    matchIntent,
    matchSignature: matchSig,
    ciphertext,
  };
}

async function postIntent(baseUrl, body) {
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

test("phase2 accepts intent with valid match intent + ciphertext binding", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const body = await buildSignedRequest({ wallet });
  const out = await postIntent(baseUrl, body);
  assert.equal(out.status, 201);
  assert.equal(out.body?.matchIntentBound, true);
});

test("phase2 rejects intent with mismatched ciphertext hash", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const body = await buildSignedRequest({ wallet });
  body.ciphertext = { secret: "amount", v: "y-different" };
  const out = await postIntent(baseUrl, body);
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, "CIPHERTEXT_HASH_MISMATCH");
});

test("phase2 rejects intent signed by a different wallet", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl } = await withApp(t);
  const owner = ethers.Wallet.createRandom();
  const body = await buildSignedRequest({ wallet: owner });
  const attacker = ethers.Wallet.createRandom();
  const matchDomain = {
    name: MATCH_INTENT_DOMAIN_NAME,
    version: MATCH_INTENT_DOMAIN_VERSION,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
  };
  const matchTyped = {
    user: body.matchIntent.user,
    side: body.matchIntent.side,
    inputAssetID: BigInt(body.matchIntent.inputAssetID),
    outputAssetID: BigInt(body.matchIntent.outputAssetID),
    amount: BigInt(body.matchIntent.amount),
    limitPrice: BigInt(body.matchIntent.limitPrice),
    nonce: BigInt(body.matchIntent.nonce),
    deadline: BigInt(body.matchIntent.deadline),
    ciphertextHash: body.matchIntent.ciphertextHash,
  };
  body.matchSignature = await attacker.signTypedData(matchDomain, INTERNAL_MATCH_INTENT_TYPES, matchTyped);
  const out = await postIntent(baseUrl, body);
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, "SIGNER_MISMATCH");
});

test("phase2 rejects expired match intent deadline", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const body = await buildSignedRequest({ wallet });
  body.matchIntent.deadline = "1";
  const out = await postIntent(baseUrl, body);
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, "MATCH_INTENT_EXPIRED");
});

test("phase2 rejects mismatched user (intent.owner != matchIntent.user)", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl } = await withApp(t);
  const owner = ethers.Wallet.createRandom();
  const body = await buildSignedRequest({ wallet: owner });
  const stranger = ethers.Wallet.createRandom();
  body.matchIntent.user = stranger.address;
  const out = await postIntent(baseUrl, body);
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, "USER_MISMATCH");
});

test("phase2 strict mode requires match intent or rejects request", async (t) => {
  process.env.MATCHING_REQUIRE_USER_INTENT = "true";
  t.after(() => { delete process.env.MATCHING_REQUIRE_USER_INTENT; });
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const bare = await buildSignedRequest({ wallet, includeMatchIntent: false });
  const out = await postIntent(baseUrl, bare);
  assert.equal(out.status, 400);
  assert.equal(out.body?.reason, "MATCH_INTENT_MISSING");
});

test("phase2 backward compatible: no match intent in dev mode still accepted", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  delete process.env.NODE_ENV;
  delete process.env.PHANTOM_DEPLOYMENT_TIER;
  const { baseUrl } = await withApp(t);
  const wallet = ethers.Wallet.createRandom();
  const bare = await buildSignedRequest({ wallet, includeMatchIntent: false });
  const out = await postIntent(baseUrl, bare);
  assert.equal(out.status, 201);
  assert.equal(out.body?.matchIntentBound, false);
});
