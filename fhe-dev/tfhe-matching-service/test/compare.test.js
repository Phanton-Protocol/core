"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { ethers } = require("ethers");

const TMP_KEYS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tfhe-cmp-"));
const SECRET_PATH = path.join(TMP_KEYS_DIR, "secret.key");
const PUBLIC_PATH = path.join(TMP_KEYS_DIR, "public.key");
const TEST_PRIVATE_KEY = "0x" + "22".repeat(32);
const TEST_SIGNER_ADDRESS = new ethers.Wallet(TEST_PRIVATE_KEY).address;

process.env.MATCHING_SERVICE_PRIVATE_KEY = TEST_PRIVATE_KEY;
process.env.TFHE_PUBLIC_KEY_PATH = PUBLIC_PATH;
process.env.TFHE_SECRET_KEY_PATH = SECRET_PATH;

const { createApp, buildEngine } = require("../src/server");
const { stableStringify } = require("../src/operandHelper");

let ENGINE;
let APP;
let SERVER;
let BASE_URL;

function fetchJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + urlPath);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  const built = buildEngine({ log: () => {} });
  ENGINE = built.engine;
  APP = createApp(ENGINE);
  await new Promise((resolve) => {
    SERVER = APP.listen(0, "127.0.0.1", () => {
      const addr = SERVER.address();
      BASE_URL = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => SERVER.close(resolve));
  fs.rmSync(TMP_KEYS_DIR, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────

// Side: 0 = sell, 1 = buy. inputAssetID is the asset the user is giving up.
// For buy A with quote B: side=1, inputAssetID=B (USDT), outputAssetID=A (BNB).
// For sell A: side=0, inputAssetID=A (BNB), outputAssetID=B (USDT).
function makeMakerSell({ amount, price, user = "0x1111111111111111111111111111111111111111", nonce = 1, deadline }) {
  return {
    user,
    side: 0,
    inputAssetID: 1,  // BNB
    outputAssetID: 2, // USDT
    amount: String(amount),
    limitPrice: String(price),
    nonce,
    deadline: deadline ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

function makeTakerBuy({ amount, price, user = "0x2222222222222222222222222222222222222222", nonce = 2, deadline }) {
  return {
    user,
    side: 1,
    inputAssetID: 2,  // USDT (counter of maker)
    outputAssetID: 1, // BNB
    amount: String(amount),
    limitPrice: String(price),
    nonce,
    deadline: deadline ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

async function buildSignedOrder(intent, { amount, price }) {
  // Use the local /encrypt endpoint to produce the TFHE ciphertext bundle.
  const r = await fetchJson("POST", "/encrypt", { amount, price });
  assert.equal(r.status, 200, "encrypt should succeed");
  const ciphertext = r.body.ciphertext;
  const ciphertextHash = r.body.ciphertextHash;
  intent.ciphertextHash = ciphertextHash;
  // For the FHE service, the user signature is opaque (verification happens
  // backend-side, M4). For M2 we only need a syntactically valid signature.
  const dummySig = "0x" + "ab".repeat(65);
  return { intent, ciphertext, signature: dummySig };
}

function recomputeDecisionHash(canonical) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
}

// ─────────────────────────────────────────────────────────────────────────
//  M2 — 5 required tests
// ─────────────────────────────────────────────────────────────────────────

test("M2 #1: buy 100 @ 300 vs sell 100 @ 300 → matched=true", async () => {
  const maker = await buildSignedOrder(makeMakerSell({ amount: 100, price: 300, nonce: 11 }), { amount: 100, price: 300 });
  const taker = await buildSignedOrder(makeTakerBuy({ amount: 100, price: 300, nonce: 12 }),  { amount: 100, price: 300 });
  const r = await fetchJson("POST", "/internal-match/compare", { maker, taker, traceId: "t1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.matched, true, `expected match, got reason=${r.body.reason}`);
  assert.equal(r.body.reason, null);
  assert.ok(r.body.attestation, "attestation present");
  assert.equal(r.body.attestation.canonical.v, "phantom-fhe-attestation/v2");
  assert.equal(r.body.attestation.canonical.matched, true);
  // signature recovery
  const recovered = ethers.recoverAddress(
    r.body.attestation.decisionHash,
    r.body.attestation.signature
  );
  assert.equal(recovered, TEST_SIGNER_ADDRESS);
  // decisionHash matches stableStringify(canonical)
  const rec = recomputeDecisionHash(r.body.attestation.canonical);
  assert.equal(rec, r.body.attestation.decisionHash);
});

test("M2 #2: buy 100 @ 290 vs sell 100 @ 300 → matched=false (price_cross_failed)", async () => {
  const maker = await buildSignedOrder(makeMakerSell({ amount: 100, price: 300, nonce: 21 }), { amount: 100, price: 300 });
  const taker = await buildSignedOrder(makeTakerBuy({ amount: 100, price: 290, nonce: 22 }),  { amount: 100, price: 290 });
  const r = await fetchJson("POST", "/internal-match/compare", { maker, taker, traceId: "t2" });
  assert.equal(r.status, 200);
  assert.equal(r.body.matched, false);
  assert.equal(r.body.reason, "price_cross_failed");
  assert.equal(r.body.attestation, undefined, "no attestation on no-match");
});

test("M2 #3: buy 200 @ 305 vs sell 100 @ 300 → matched=true (partial fill, ciphertext only)", async () => {
  const maker = await buildSignedOrder(makeMakerSell({ amount: 100, price: 300, nonce: 31 }), { amount: 100, price: 300 });
  const taker = await buildSignedOrder(makeTakerBuy({ amount: 200, price: 305, nonce: 32 }),  { amount: 200, price: 305 });
  const r = await fetchJson("POST", "/internal-match/compare", { maker, taker, traceId: "t3" });
  assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.matched, true, `expected match, got reason=${r.body.reason}`);
  assert.match(r.body.result.execAmountCipher, /^0x[0-9a-fA-F]+$/, "execAmountCipher is hex");
  assert.match(r.body.result.execPriceCipher, /^0x[0-9a-fA-F]+$/, "execPriceCipher is hex");
  assert.match(r.body.attestation.canonical.execAmountCiphertextHash, /^0x[0-9a-fA-F]{64}$/);
  assert.match(r.body.attestation.canonical.execPriceCiphertextHash, /^0x[0-9a-fA-F]{64}$/);
  // execAmountCiphertextHash is the keccak256 of the published execAmountCipher.
  const reH = ethers.keccak256(r.body.result.execAmountCipher);
  assert.equal(reH, r.body.attestation.canonical.execAmountCiphertextHash);
  const reHp = ethers.keccak256(r.body.result.execPriceCipher);
  assert.equal(reHp, r.body.attestation.canonical.execPriceCiphertextHash);
});

test("M2 #4: side or asset mismatch → matched=false", async () => {
  // Two SELLs (same side) → side_mismatch.
  const maker = await buildSignedOrder(makeMakerSell({ amount: 100, price: 300, nonce: 41 }), { amount: 100, price: 300 });
  const otherSell = await buildSignedOrder(
    { ...makeMakerSell({ amount: 100, price: 300, nonce: 42, user: "0x3333333333333333333333333333333333333333" }) },
    { amount: 100, price: 300 }
  );
  const r1 = await fetchJson("POST", "/internal-match/compare", { maker, taker: otherSell, traceId: "t4a" });
  assert.equal(r1.body.matched, false);
  assert.equal(r1.body.reason, "side_mismatch");

  // Asset mismatch: maker sells BNB→USDT, taker buys CAKE (asset id 3) with USDT.
  const takerBadAsset = await buildSignedOrder(
    { ...makeTakerBuy({ amount: 100, price: 300, nonce: 43 }), outputAssetID: 3 },
    { amount: 100, price: 300 }
  );
  const r2 = await fetchJson("POST", "/internal-match/compare", { maker, taker: takerBadAsset, traceId: "t4b" });
  assert.equal(r2.body.matched, false);
  assert.equal(r2.body.reason, "asset_mismatch");
});

test("M2 #5: privacy guard — response carries NO plaintext exec amount/price AND engine has exactly one .decrypt(", async () => {
  // (a) parse the JSON body and assert no numeric execAmount / execPrice fields.
  const maker = await buildSignedOrder(makeMakerSell({ amount: 100, price: 300, nonce: 51 }), { amount: 100, price: 300 });
  const taker = await buildSignedOrder(makeTakerBuy({ amount: 100, price: 300, nonce: 52 }),  { amount: 100, price: 300 });
  const r = await fetchJson("POST", "/internal-match/compare", { maker, taker, traceId: "t5" });
  assert.equal(r.body.matched, true);
  // Top-level result must not carry plaintext numeric fields.
  assert.equal(r.body.result.execAmount, undefined, "result.execAmount plaintext leak");
  assert.equal(r.body.result.execPrice, undefined,  "result.execPrice plaintext leak");
  // Canonical (used to recompute decisionHash) must use ciphertext hashes, not plaintext.
  const can = r.body.attestation.canonical;
  assert.equal(can.execAmount, undefined, "canonical.execAmount plaintext leak (v1 used this; v2 must use the hash variant)");
  assert.equal(can.execPrice, undefined,  "canonical.execPrice plaintext leak (v1 used this; v2 must use the hash variant)");
  assert.ok(typeof can.execAmountCiphertextHash === "string" && can.execAmountCiphertextHash.startsWith("0x"));
  assert.ok(typeof can.execPriceCiphertextHash === "string" && can.execPriceCiphertextHash.startsWith("0x"));
  // Sanity: the published numeric values 100 and 300 should not appear anywhere
  // in the response body as standalone numeric fields.
  const flat = JSON.stringify(r.body);
  // We can't blanket-ban the string "100" since it can appear inside hex
  // ciphertexts — but we can confirm no JSON field is literally
  // "execAmount":"100" or "execPrice":"300".
  assert.ok(!/"execAmount"\s*:\s*"?100"?/.test(flat), "execAmount=100 must not appear");
  assert.ok(!/"execPrice"\s*:\s*"?300"?/.test(flat), "execPrice=300 must not appear");

  // (b) Source-level static check: grep the engine for `.decrypt(` and assert
  // exactly one MATCH outside of comments. Block comments and line comments
  // are stripped before counting so the privacy guard reflects real code.
  const rawSource = fs.readFileSync(path.join(__dirname, "..", "src", "fheEngine.js"), "utf8");
  const stripped = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")    // strip /* ... */ block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // strip // ... line comments (avoid http://)
  const matches = stripped.match(/\.decrypt\(/g) || [];
  assert.equal(
    matches.length,
    1,
    `src/fheEngine.js must contain exactly one '.decrypt(' call (the matched-bit decrypt). Found ${matches.length} after stripping comments.`
  );

  // Confirm the single match is on a FheBool variable, not on a FheUint64
  // amount/price ciphertext. We look for the pattern matchedFheBool.decrypt.
  assert.ok(
    /matchedFheBool\.decrypt\(/.test(stripped),
    "the single .decrypt( in src/fheEngine.js (post-comment-strip) must be matchedFheBool.decrypt(...)"
  );

  // Also confirm src/fheEngine.js does NOT decrypt amount/price ciphertexts.
  // The token names amountCipher / priceCipher / makerAmountCt / takerPriceCt etc.
  // must never be followed by .decrypt(.
  const forbiddenDecryptTargets = [
    /amountCipher\.decrypt\(/,
    /priceCipher\.decrypt\(/,
    /amountCt\.decrypt\(/,
    /priceCt\.decrypt\(/,
    /maker(Amount|Price)\w*\.decrypt\(/i,
    /taker(Amount|Price)\w*\.decrypt\(/i,
  ];
  for (const pat of forbiddenDecryptTargets) {
    assert.ok(!pat.test(stripped), `src/fheEngine.js (post-comment-strip) must not match ${pat}`);
  }
});
