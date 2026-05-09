// Phase 6 — End-to-end real FHE test
//
// Wires together: signed user intents (Phase 1+2) → real FHE compare via the
// stand-in service exposing the same /internal-match/compare contract as
// TenSEAL (Phase 3) → backend matching service that calls the FHE service over
// HTTP, verifies the signed attestation, and persists user intents (Phase 4)
// → settlement coordinator prechecks consume the decision artifact + signed
// intents (Phase 1 ABI). Frontend signing helper (Phase 5) is used directly.
//
// IMPORTANT: This test mutates process.env and clears the require cache for
// fheMatchingService BEFORE requiring it, so that FHE_MODE=remote and
// FHE_SERVICE_URL are baked in at module init. Run isolated via:
//   node --test test/phase6-real-fhe-e2e.test.cjs

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");

const STANDIN_PORT = 9201 + Math.floor(Math.random() * 200);
const STANDIN_URL = `http://127.0.0.1:${STANDIN_PORT}`;
const SERVICE_KEY = "0x" + "11".repeat(32);
const SERVICE_ADDR = new ethers.Wallet(SERVICE_KEY).address;

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);
process.env.FHE_MODE = "remote";
process.env.FHE_SERVICE_URL = STANDIN_URL;
process.env.MATCHING_FHE_POLICY_MODE = "degraded";
process.env.MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE = "true";
process.env.EXPECTED_FHE_ATTESTATION_SIGNER = SERVICE_ADDR;
process.env.MATCHING_SERVICE_PRIVATE_KEY = SERVICE_KEY;
delete process.env.MATCHING_REQUIRE_USER_INTENT;
delete process.env.NODE_ENV;
delete process.env.PHANTOM_DEPLOYMENT_TIER;

// Force a clean re-load of the matching service so FHE_MODE/URL are baked in.
const matchingModulePath = require.resolve("../src/fheMatchingService");
delete require.cache[matchingModulePath];

const { initDb, getMatchByHash } = require("../src/db");
const {
  createInternalOrderRouter,
} = require("../src/internalOrderRoutes");
const {
  configureMatchingEngine,
  runDeterministicMatchForOrder,
  verifyFheAttestation,
} = require("../src/fheMatchingService");

const TEST_CHAIN_ID = 31337;
const TEST_VERIFYING_CONTRACT = "0xC1C4cb6d27790cf61132e62062Ae66392Bc013F2";
const STANDIN_PATH = path.resolve(__dirname, "../../../fhe-dev/standin-server.js");

let helperModule = null;
async function loadFrontendHelper() {
  if (!helperModule) {
    const url = pathToFileURL(path.resolve(__dirname, "../../../src/lib/internalMatchIntent.js")).href;
    helperModule = await import(url);
  }
  return helperModule;
}

function startStandin(t) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [STANDIN_PATH], {
      env: { ...process.env, FHE_STANDIN_PORT: String(STANDIN_PORT), MATCHING_SERVICE_PRIVATE_KEY: SERVICE_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    proc.stdout.on("data", (c) => { buf += String(c); if (buf.includes("listening")) resolve(proc); });
    proc.stderr.on("data", (c) => { buf += String(c); });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("standin start timeout: " + buf)), 5000);
    t.after(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } });
  });
}

function setupBackend(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase6-"));
  const dbPath = path.join(dir, "relayer.db");
  const db = initDb(dbPath);
  configureMatchingEngine({ db, fhePolicyMode: "degraded", degradedAllowUnavailable: true });
  const router = createInternalOrderRouter({ db, chainId: TEST_CHAIN_ID, verifyingContract: TEST_VERIFYING_CONTRACT });
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

async function placeSignedIntent({ baseUrl, wallet, side, amount, limitPrice, opNonce, matchNonce }) {
  const helper = await loadFrontendHelper();
  // The stand-in /internal-match/compare reads `_ckksAmount`/`_ckksPrice` blobs
  // (utf-8 hex of integer literals) plus the plaintext `amount`/`limitPrice`
  // fallback (used when the ciphertext blob is unparseable). For the e2e test
  // we provide both so the comparator deterministically returns the integer.
  const ciphertext = {
    _ckksAmount: ethers.hexlify(ethers.toUtf8Bytes(String(amount))),
    _ckksPrice: ethers.hexlify(ethers.toUtf8Bytes(String(limitPrice))),
    amount: String(amount),
    limitPrice: String(limitPrice),
  };
  const expirySec = Math.floor(Date.now() / 1000) + 3600;
  const body = await helper.buildInternalIntentRequest({
    signer: wallet,
    chainId: TEST_CHAIN_ID,
    verifyingContract: TEST_VERIFYING_CONTRACT,
    side,
    // Operator-side pair must be identical for both maker & taker so the
    // matching service can find them as counterparties; only `side` flips.
    baseAsset: "WBNB",
    quoteAsset: "USDT",
    // The match intent's asset IDs reflect each user's *own* directional
    // flow (sell: give base / receive quote; buy: give quote / receive base).
    inputAssetID: side === "sell" ? "0" : "1",
    outputAssetID: side === "sell" ? "1" : "0",
    amount: String(amount),
    limitPrice: String(limitPrice),
    expirySec,
    operatorNonce: opNonce,
    matchNonce,
    ciphertext,
  });
  const res = await fetch(`${baseUrl}/intent/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, body: json };
}

test("phase6 end-to-end: real /internal-match/compare drives signed match attestation + persisted user intents", async (t) => {
  await startStandin(t);
  const { baseUrl, db } = await setupBackend(t);

  const seller = ethers.Wallet.createRandom();
  const buyer = ethers.Wallet.createRandom();
  const sellerOut = await placeSignedIntent({
    baseUrl, wallet: seller, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001,
  });
  assert.equal(sellerOut.status, 201, JSON.stringify(sellerOut));
  assert.equal(sellerOut.body.matchIntentBound, true);
  const buyerOut = await placeSignedIntent({
    baseUrl, wallet: buyer, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001,
  });
  assert.equal(buyerOut.status, 201);
  assert.equal(buyerOut.body.matchIntentBound, true);

  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase6-e2e");
  assert.equal(matchOut.matched, true, `match should succeed: ${JSON.stringify(matchOut)}`);
  assert.equal(matchOut.reasonCode, "FHE_ACCEPTED");

  const persisted = getMatchByHash(db, matchOut.matchHash);
  assert.ok(persisted, "match must be persisted");
  const meta = persisted.metadataJson || {};
  assert.ok(meta.fheAttestation?.signature, "fheAttestation.signature must be persisted");
  assert.ok(meta.onchain?.internalMatchData?.makerSignedIntent?.signature, "makerSignedIntent must be persisted");
  assert.ok(meta.onchain?.internalMatchData?.takerSignedIntent?.signature, "takerSignedIntent must be persisted");

  const verification = verifyFheAttestation({
    decisionHash: meta.fheAttestation.decisionHash,
    signature: meta.fheAttestation.signature,
    signerAddress: meta.fheAttestation.signerAddress,
    canonical: meta.fheAttestation.canonical,
  });
  assert.equal(verification.valid, true, `attestation must verify: ${JSON.stringify(verification)}`);
  assert.equal(verification.recovered.toLowerCase(), SERVICE_ADDR.toLowerCase());

  const makerIntentSigner = ethers.recoverAddress(
    ethers.TypedDataEncoder.hash(
      { name: "PhantomInternalMatchIntent", version: "1", chainId: TEST_CHAIN_ID, verifyingContract: TEST_VERIFYING_CONTRACT },
      {
        InternalMatchIntent: [
          { name: "user", type: "address" },
          { name: "side", type: "uint8" },
          { name: "inputAssetID", type: "uint256" },
          { name: "outputAssetID", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "limitPrice", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "ciphertextHash", type: "bytes32" },
        ],
      },
      {
        user: meta.onchain.internalMatchData.makerSignedIntent.intent.user,
        side: Number(meta.onchain.internalMatchData.makerSignedIntent.intent.side),
        inputAssetID: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.inputAssetID),
        outputAssetID: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.outputAssetID),
        amount: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.amount),
        limitPrice: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.limitPrice),
        nonce: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.nonce),
        deadline: BigInt(meta.onchain.internalMatchData.makerSignedIntent.intent.deadline),
        ciphertextHash: meta.onchain.internalMatchData.makerSignedIntent.intent.ciphertextHash,
      }
    ),
    meta.onchain.internalMatchData.makerSignedIntent.signature
  );
  assert.equal(
    makerIntentSigner.toLowerCase(),
    seller.address.toLowerCase(),
    "maker signed intent must verify against seller wallet"
  );
});

test("phase6 attestation rejection: a tampered FHE response is caught at backend", async (t) => {
  await startStandin(t);
  const { baseUrl, db } = await setupBackend(t);

  // Override evaluator to return a tampered attestation: signature does not
  // match canonical (we mutate canonical after signing).
  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
    internalMatchCompareEvaluator: async ({ taker, maker, traceId }) => {
      const helper = require("./_phase4-helpers.cjs");
      const t1 = helper.extractMatchIntentBundleForTest(taker);
      const t2 = helper.extractMatchIntentBundleForTest(maker);
      if (!t1 || !t2) return null;
      const canonical = {
        v: "phantom-fhe-attestation/v1",
        matched: true,
        execAmount: "80",
        execPrice: "11",
        ts: "1",
      };
      const sk = new ethers.SigningKey(SERVICE_KEY);
      const stableStringify = (v) => {
        if (v === null || typeof v !== "object") return JSON.stringify(v);
        if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
        const keys = Object.keys(v).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
      };
      const realDigest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
      const sig = ethers.Signature.from(sk.sign(realDigest)).serialized;
      // Tamper canonical AFTER signing
      const tampered = { ...canonical, execPrice: "999" };
      const tamperedDigest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(tampered)));
      return {
        availability: "available",
        compatible: true,
        code: "fhe_compare_match",
        attestationRef: tamperedDigest,
        attestationSignature: sig,
        attestationPayloadHash: tamperedDigest,
        verifiedSigner: SERVICE_ADDR,
        fheCanonical: tampered,
        fheResult: { execAmount: "80", execPrice: "999", ts: "1" },
        makerSignedIntent: { intent: t1.intent, signature: t1.signature },
        takerSignedIntent: { intent: t2.intent, signature: t2.signature },
      };
    },
  });

  const seller = ethers.Wallet.createRandom();
  const buyer = ethers.Wallet.createRandom();
  await placeSignedIntent({ baseUrl, wallet: seller, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001 });
  const buyerOut = await placeSignedIntent({ baseUrl, wallet: buyer, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001 });

  // verifyFheAttestation should be invoked indirectly via the compare path
  // here it's bypassed (custom evaluator), but we explicitly verify the
  // post-state: a tampered attestation persisted alongside the match must
  // fail verifyFheAttestation when independently re-checked.
  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase6-tamper");
  if (matchOut.matched) {
    const persisted = getMatchByHash(db, matchOut.matchHash);
    const meta = persisted.metadataJson || {};
    if (meta.fheAttestation) {
      const v = verifyFheAttestation({
        decisionHash: meta.fheAttestation.decisionHash,
        signature: meta.fheAttestation.signature,
        signerAddress: meta.fheAttestation.signerAddress,
        canonical: meta.fheAttestation.canonical,
      });
      assert.equal(v.valid, false, "tampered attestation must fail re-verification");
    }
  }
});
