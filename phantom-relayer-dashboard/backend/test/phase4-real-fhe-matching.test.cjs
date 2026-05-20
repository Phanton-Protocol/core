const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const { initDb, getMatchByHash, saveInternalMatchEnrollment } = require("../src/db");
const {
  createInternalOrderRouter,
  INTERNAL_ORDER_TYPES,
  INTERNAL_MATCH_INTENT_TYPES,
  MATCH_INTENT_DOMAIN_NAME,
  MATCH_INTENT_DOMAIN_VERSION,
  computeCiphertextHash,
} = require("../src/internalOrderRoutes");
const {
  configureMatchingEngine,
  runDeterministicMatchForOrder,
  REASON_CODES,
  verifyFheAttestation,
} = require("../src/fheMatchingService");

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

function seedEnrollment(db, ownerAddress) {
  saveInternalMatchEnrollment(db, {
    userAddress: ownerAddress.toLowerCase(),
    enrollmentId: ethers.keccak256(ethers.toUtf8Bytes(`phase4-${ownerAddress}`)),
    payloadHash: ethers.ZeroHash,
    encryptedPayload: null,
    txHash: "0x" + "dd".repeat(32),
    blockNumber: 1,
    createdAt: Date.now(),
  });
}

async function setupApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase4-"));
  const dbPath = path.join(dir, "relayer.db");
  const db = initDb(dbPath);
  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
    internalMatchCompareEvaluator: async ({ taker, maker, traceId }) => {
      const { extractMatchIntentBundleForTest } = require("./_phase4-helpers.cjs");
      const takerBundle = extractMatchIntentBundleForTest(taker);
      const makerBundle = extractMatchIntentBundleForTest(maker);
      if (!takerBundle || !makerBundle) return null;
      const exec = String(Math.min(Number(takerBundle.intent.amount), Number(makerBundle.intent.amount)));
      const canonical = {
        v: "phantom-fhe-attestation/v1",
        matched: true,
        makerCiphertextHash: makerBundle.intent.ciphertextHash,
        takerCiphertextHash: takerBundle.intent.ciphertextHash,
        makerUser: makerBundle.intent.user,
        takerUser: takerBundle.intent.user,
        makerNonce: String(makerBundle.intent.nonce),
        takerNonce: String(takerBundle.intent.nonce),
        inputAssetID: String(takerBundle.intent.inputAssetID),
        outputAssetID: String(takerBundle.intent.outputAssetID),
        execAmount: exec,
        execPrice: makerBundle.intent.limitPrice,
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
        decisionDomain: "phantom-fhe-attestation/v1",
        decisionNonce: canonical.ts,
        verifiedSigner: att.signerAddress,
        fheCanonical: canonical,
        fheResult: { execPrice: canonical.execPrice, execAmount: canonical.execAmount, ts: canonical.ts },
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

async function postSignedIntent({ baseUrl, wallet, side, amount, limitPrice, opNonce, matchNonce, baseAsset = "WBNB", quoteAsset = "USDT" }) {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(ethers.toUtf8Bytes(`replay-${wallet.address}-${opNonce}-${Date.now()}-${Math.random()}`));
  const operatorIntent = {
    owner: wallet.address,
    signingKey: wallet.address,
    baseAsset,
    quoteAsset,
    side,
    amount: String(amount),
    limitPrice: String(limitPrice),
    expiry,
    nonce: String(opNonce),
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

  const ciphertext = { _ckksAmount: ethers.hexlify(ethers.toUtf8Bytes(String(amount))), _ckksPrice: ethers.hexlify(ethers.toUtf8Bytes(String(limitPrice))), amount: String(amount), limitPrice: String(limitPrice) };
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
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, body: json };
}

test("phase4 matching service uses /internal-match/compare and persists user signed intents", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl, db } = await setupApp(t);
  const sellerWallet = ethers.Wallet.createRandom();
  const buyerWallet = ethers.Wallet.createRandom();
  seedEnrollment(db, sellerWallet.address);
  seedEnrollment(db, buyerWallet.address);
  const sellerOut = await postSignedIntent({ baseUrl, wallet: sellerWallet, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001 });
  assert.equal(sellerOut.status, 201);
  assert.equal(sellerOut.body.matchIntentBound, true);
  const buyerOut = await postSignedIntent({ baseUrl, wallet: buyerWallet, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001 });
  assert.equal(buyerOut.status, 201);

  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase4-test");
  assert.equal(matchOut.matched, true);
  assert.equal(matchOut.reasonCode, "FHE_ACCEPTED");
  const persisted = getMatchByHash(db, matchOut.matchHash);
  assert.ok(persisted, "match must be persisted");
  const meta = persisted.metadataJson || {};
  assert.ok(meta.fheAttestation, "fheAttestation must be persisted");
  // Path-B (M5): user signed intents now live under `pathB.*` instead of
  // `onchain.internalMatchData.*`; the on-chain settle blob has been removed.
  assert.ok(meta.pathB?.makerSignedIntent, "makerSignedIntent must be persisted (pathB)");
  assert.ok(meta.pathB?.takerSignedIntent, "takerSignedIntent must be persisted (pathB)");
  // The removed on-chain blob must NOT appear in match metadata.
  assert.equal(meta.onchain?.internalMatchData, undefined, "legacy onchain.internalMatchData must not be persisted under Path-B");
  const verification = verifyFheAttestation({
    decisionHash: meta.fheAttestation.decisionHash,
    signature: meta.fheAttestation.signature,
    signerAddress: meta.fheAttestation.signerAddress,
    canonical: meta.fheAttestation.canonical,
  });
  assert.equal(verification.valid, true, `attestation must verify: ${JSON.stringify(verification)}`);
  assert.equal(verification.recovered.toLowerCase(), SERVICE_ADDR.toLowerCase());
  assert.equal(meta.pathB?.ledger?.status, "ledger_applied");
  assert.ok(meta.pathB?.ledger?.auditEntryHash);
});

test("phase4 fallback to legacy compatibility path when matchIntent missing", async (t) => {
  delete process.env.MATCHING_REQUIRE_USER_INTENT;
  const { baseUrl, db } = await setupApp(t);

  const sellerWallet = ethers.Wallet.createRandom();
  const buyerWallet = ethers.Wallet.createRandom();
  seedEnrollment(db, sellerWallet.address);
  seedEnrollment(db, buyerWallet.address);
  const sellerOut = await postBareIntent({ baseUrl, wallet: sellerWallet, side: "sell", amount: 100, limitPrice: 10, opNonce: 1 });
  assert.equal(sellerOut.status, 201);
  assert.equal(sellerOut.body.matchIntentBound, false);
  const buyerOut = await postBareIntent({ baseUrl, wallet: buyerWallet, side: "buy", amount: 80, limitPrice: 12, opNonce: 1 });
  assert.equal(buyerOut.status, 201);

  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
    fheCompatibilityEvaluator: async () => ({ compatible: true, code: "ok", attestationRef: "legacy-ref" }),
  });
  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase4-fallback");
  assert.equal(matchOut.matched, true);
  const persisted = getMatchByHash(db, matchOut.matchHash);
  const meta = persisted.metadataJson || {};
  // Path-B: legacy `onchain.internalMatchData` is no longer written; the
  // fallback (no signed intents) leaves `pathB.makerSignedIntent` null.
  assert.equal(meta.onchain?.internalMatchData, undefined);
  assert.equal(meta.pathB?.makerSignedIntent ?? null, null);
  assert.equal(meta.pathB?.takerSignedIntent ?? null, null);
  assert.equal(meta.fheAttestation, null);
});

test("phase4 verifyFheAttestation rejects tampered canonical", () => {
  const canonical = {
    v: "phantom-fhe-attestation/v1",
    matched: true,
    execPrice: "11",
    execAmount: "80",
    ts: "1",
  };
  const sk = new ethers.SigningKey(SERVICE_KEY);
  const digest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
  const sig = ethers.Signature.from(sk.sign(digest)).serialized;

  const ok = verifyFheAttestation({ decisionHash: digest, signature: sig, signerAddress: SERVICE_ADDR, canonical });
  assert.equal(ok.valid, true);

  const bad = verifyFheAttestation({ decisionHash: digest, signature: sig, signerAddress: SERVICE_ADDR, canonical: { ...canonical, execPrice: "999" } });
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, "decision_hash_canonical_mismatch");
});

async function postBareIntent({ baseUrl, wallet, side, amount, limitPrice, opNonce }) {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(ethers.toUtf8Bytes(`bare-${wallet.address}-${opNonce}-${Date.now()}-${Math.random()}`));
  const intent = {
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
  const sig = await wallet.signTypedData(
    { name: "PhantomInternalOrder", version: "1", chainId: TEST_CHAIN_ID, verifyingContract: TEST_VERIFYING_CONTRACT },
    INTERNAL_ORDER_TYPES,
    {
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
    }
  );
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent, signature: sig }),
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, body: json };
}
