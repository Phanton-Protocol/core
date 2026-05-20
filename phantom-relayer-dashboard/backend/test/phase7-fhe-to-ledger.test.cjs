const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const { initDb, getMatchByHash, saveInternalMatchEnrollment, getInternalMatchAuditByMatchHash, listPendingNotesByMatchHash } = require("../src/db");
const {
  createInternalOrderRouter,
  INTERNAL_ORDER_TYPES,
  INTERNAL_MATCH_INTENT_TYPES,
  MATCH_INTENT_DOMAIN_NAME,
  MATCH_INTENT_DOMAIN_VERSION,
  computeCiphertextHash,
} = require("../src/internalOrderRoutes");
const { configureMatchingEngine, runDeterministicMatchForOrder } = require("../src/fheMatchingService");

const TEST_CHAIN_ID = 31337;
const TEST_VERIFYING_CONTRACT = "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";
const SERVICE_KEY = "0x" + "11".repeat(32);
const SERVICE_ADDR = new ethers.Wallet(SERVICE_KEY).address;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function signMatchAttestation(canonical, key = SERVICE_KEY) {
  const digest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
  const sk = new ethers.SigningKey(key);
  const sig = sk.sign(digest);
  return { decisionHash: digest, signature: ethers.Signature.from(sig).serialized, signerAddress: new ethers.Wallet(key).address, canonical };
}

function seedEnrollment(db, owner) {
  saveInternalMatchEnrollment(db, {
    userAddress: owner.toLowerCase(),
    enrollmentId: ethers.keccak256(ethers.toUtf8Bytes(`p7-${owner}`)),
    payloadHash: ethers.ZeroHash,
    encryptedPayload: null,
    txHash: "0x" + "ee".repeat(32),
    blockNumber: 1,
    createdAt: Date.now(),
  });
}

async function setupApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase7-"));
  const dbPath = path.join(dir, "relayer.db");
  const db = initDb(dbPath);
  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
    internalMatchCompareEvaluator: async ({ taker, maker }) => {
      const { extractMatchIntentBundleForTest } = require("./_phase4-helpers.cjs");
      const takerBundle = extractMatchIntentBundleForTest(taker);
      const makerBundle = extractMatchIntentBundleForTest(maker);
      if (!takerBundle || !makerBundle) return null;
      const canonical = {
        v: "phantom-fhe-attestation/v2",
        matched: true,
        makerCiphertextHash: makerBundle.intent.ciphertextHash,
        takerCiphertextHash: takerBundle.intent.ciphertextHash,
        makerUser: makerBundle.intent.user,
        takerUser: takerBundle.intent.user,
        makerNonce: String(makerBundle.intent.nonce),
        takerNonce: String(takerBundle.intent.nonce),
        inputAssetID: String(takerBundle.intent.inputAssetID),
        outputAssetID: String(takerBundle.intent.outputAssetID),
        execAmountCiphertextHash: "0x" + "66".repeat(32),
        execPriceCiphertextHash: "0x" + "77".repeat(32),
        ts: String(Date.now()),
      };
      const att = signMatchAttestation(canonical);
      return {
        availability: "available",
        compatible: true,
        code: "fhe_compare_match",
        attestationRef: att.decisionHash,
        attestationSignature: att.signature,
        attestationPayloadHash: att.decisionHash,
        decisionDomain: "phantom-fhe-attestation/v2",
        verifiedSigner: att.signerAddress,
        fheCanonical: canonical,
        makerSignedIntent: { intent: makerBundle.intent, signature: makerBundle.signature },
        takerSignedIntent: { intent: takerBundle.intent, signature: takerBundle.signature },
      };
    },
  });
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

test("phase7: FHE match applies pending note ledger and audit row", async (t) => {
  const { baseUrl, db } = await setupApp(t);
  const sellerWallet = ethers.Wallet.createRandom();
  const buyerWallet = ethers.Wallet.createRandom();
  seedEnrollment(db, sellerWallet.address);
  seedEnrollment(db, buyerWallet.address);

  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  async function post(wallet, side, amount, limitPrice, opNonce, matchNonce) {
    const replayKey = ethers.keccak256(ethers.toUtf8Bytes(`p7-${wallet.address}-${opNonce}-${Math.random()}`));
    const operatorIntent = {
      owner: wallet.address,
      signingKey: wallet.address,
      baseAsset: "WBNB",
      quoteAsset: "USDT",
      side,
      amount: String(amount),
      limitPrice: String(limitPrice),
      expiry,
      nonce: String(opNonce),
      replayKey,
    };
    const opDomain = { name: "PhantomInternalOrder", version: "1", chainId: TEST_CHAIN_ID, verifyingContract: TEST_VERIFYING_CONTRACT };
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
    const ciphertext = { blob: String(amount) };
    const ciphertextHash = computeCiphertextHash(ciphertext);
    const matchIntent = {
      user: wallet.address,
      side: side === "sell" ? 0 : 1,
      inputAssetID: side === "sell" ? "0" : "1",
      outputAssetID: side === "sell" ? "1" : "0",
      amount: String(amount),
      limitPrice: String(limitPrice),
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
    const res = await fetch(`${baseUrl}/intent/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: operatorIntent, signature: opSig, matchIntent, matchSignature: matchSig, ciphertext }),
    });
    return res.json();
  }

  const sell = await post(sellerWallet, "sell", 100, 10, 1, 1001);
  const buy = await post(buyerWallet, "buy", 80, 12, 1, 2001);
  assert.ok(sell.orderId);
  assert.ok(buy.orderId);

  const matchOut = await runDeterministicMatchForOrder(buy.orderId, "phase7");
  assert.equal(matchOut.matched, true);
  assert.equal(matchOut.ledgerStatus, "ledger_applied");
  assert.ok(matchOut.pendingNotesCreated >= 2);

  const match = getMatchByHash(db, matchOut.matchHash);
  assert.equal(match.metadataJson?.pathB?.ledger?.status, "ledger_applied");
  assert.ok(getInternalMatchAuditByMatchHash(db, matchOut.matchHash));
  assert.equal(listPendingNotesByMatchHash(db, matchOut.matchHash).length, 2);
  assert.equal(match.metadataJson?.onchain?.internalMatchData ?? null, null);
});
