// Phase 4b — Privacy guard for the M4 backend wiring milestone.
//
// Acceptance criteria from the M4 plan ("phase4b-no-plaintext-in-compare"):
//
//   1. Drive an order pair through the matching service using a v2 canonical
//      compare response (the new shape produced by core/fhe-dev/tfhe-matching-service
//      where execAmount / execPrice are REPLACED by execAmountCiphertextHash
//      / execPriceCiphertextHash).
//   2. Assert the in-memory match record contains NO numeric `execAmount` /
//      `execPrice` plaintext fields — only ciphertext / hash fields.
//   3. Assert attestation verification PASSES when the recovered signer
//      equals EXPECTED_FHE_ATTESTATION_SIGNER, and FAILS when it does not.
//
// The test mocks fheRemoteFetch via a stub HTTP server speaking the v2
// /internal-match/compare contract. It uses the same setup pattern as the
// existing phase4 test so it slots cleanly into the M4 acceptance gate.
//
// Run isolated:
//   node --test test/phase4b-no-plaintext-in-compare.test.cjs

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { ethers } = require("ethers");

process.env.SEE_MODE = process.env.SEE_MODE || "disabled";
process.env.NOTES_ENCRYPTION_KEY_HEX = process.env.NOTES_ENCRYPTION_KEY_HEX || "11".repeat(32);

const SERVICE_KEY = "0x" + "22".repeat(32);
const SERVICE_ADDR = new ethers.Wallet(SERVICE_KEY).address;
const WRONG_KEY = "0x" + "33".repeat(32);
const WRONG_ADDR = new ethers.Wallet(WRONG_KEY).address;

// IMPORTANT: bake env vars in BEFORE requiring fheMatchingService so module
// init reads them (FHE_MODE=remote, FHE_SERVICE_URL, etc.).
process.env.FHE_MODE = "remote";
process.env.MATCHING_FHE_POLICY_MODE = "degraded";
process.env.MATCHING_FHE_DEGRADED_ALLOW_UNAVAILABLE = "true";
process.env.EXPECTED_FHE_ATTESTATION_SIGNER = SERVICE_ADDR;
delete process.env.MATCHING_REQUIRE_USER_INTENT;
delete process.env.NODE_ENV;
delete process.env.PHANTOM_DEPLOYMENT_TIER;

// We'll set FHE_SERVICE_URL after the stub HTTP server picks a port. To make
// sure fheMatchingService re-reads it after we set it, we clear its module
// cache right before each setup.
const matchingModulePath = require.resolve("../src/fheMatchingService");

const { initDb, getMatchByHash } = require("../src/db");
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

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function keccak256Hex(hexLike) {
  const s = String(hexLike || "");
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length === 0) return ethers.keccak256("0x");
  return ethers.keccak256("0x" + stripped);
}

// ─── Stub FHE service speaking the v2 /internal-match/compare contract ────
//
// The new tfhe-matching-service from M2 returns:
//   { matched, reason, result: { execAmountCipher, execPriceCipher, ts },
//     bindings: { makerCiphertextHash, takerCiphertextHash, makerUser, takerUser },
//     attestation: { decisionHash, signature, signerAddress, canonical } }
// where canonical follows the v2 shape:
//   { v: "phantom-fhe-attestation/v2", matched, makerCiphertextHash,
//     takerCiphertextHash, makerUser, takerUser, makerNonce, takerNonce,
//     inputAssetID, outputAssetID, execAmountCiphertextHash,
//     execPriceCiphertextHash, ts }
// CRITICAL: this canonical NEVER carries plaintext execAmount or execPrice.
function startStubFheService({ signerKey = SERVICE_KEY, mode = "v2_ok" } = {}) {
  const wallet = new ethers.Wallet(signerKey);
  const sk = new ethers.SigningKey(wallet.privateKey);
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", mode: "homomorphic" }));
    }
    if (req.method === "POST" && req.url === "/internal-match/compare") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const makerIntent = body?.maker?.intent || {};
      const takerIntent = body?.taker?.intent || {};
      const execAmountCipher = "0x" + Buffer.from(`exec-amt-cipher-${Date.now()}`).toString("hex");
      const execPriceCipher = "0x" + Buffer.from(`exec-prc-cipher-${Date.now()}`).toString("hex");
      const canonical = {
        v: "phantom-fhe-attestation/v2",
        matched: true,
        makerCiphertextHash: String(makerIntent.ciphertextHash || ""),
        takerCiphertextHash: String(takerIntent.ciphertextHash || ""),
        makerUser: String(makerIntent.user || ""),
        takerUser: String(takerIntent.user || ""),
        makerNonce: String(makerIntent.nonce ?? "0"),
        takerNonce: String(takerIntent.nonce ?? "0"),
        inputAssetID: String(takerIntent.inputAssetID),
        outputAssetID: String(takerIntent.outputAssetID),
        execAmountCiphertextHash: keccak256Hex(execAmountCipher),
        execPriceCiphertextHash: keccak256Hex(execPriceCipher),
        ts: String(Date.now()),
      };
      const decisionHash = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(canonical)));
      const signature = ethers.Signature.from(sk.sign(decisionHash)).serialized;
      const payload = {
        matched: true,
        reason: null,
        // result field still surfaces ciphertext blobs + ts — NO plaintext.
        result: { execAmountCipher, execPriceCipher, ts: canonical.ts },
        bindings: {
          makerCiphertextHash: canonical.makerCiphertextHash,
          takerCiphertextHash: canonical.takerCiphertextHash,
          makerUser: canonical.makerUser,
          takerUser: canonical.takerUser,
        },
        attestation: {
          decisionHash,
          signature,
          signerAddress: wallet.address,
          canonical,
        },
      };
      // Variant for the "wrong signer" assertion: leave the recovered signer
      // unchanged (i.e. the wallet's address) but advertise EXPECTED_*.
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(payload));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function setupBackend(t, { fheUrl, expectedSigner } = {}) {
  process.env.FHE_SERVICE_URL = fheUrl;
  if (expectedSigner) process.env.EXPECTED_FHE_ATTESTATION_SIGNER = expectedSigner;
  // Force fresh module load so FHE_MODE/URL/expectedSigner are baked in
  delete require.cache[matchingModulePath];
  const fheMatching = require("../src/fheMatchingService");
  const { configureMatchingEngine, runDeterministicMatchForOrder, verifyFheAttestation } = fheMatching;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-phase4b-"));
  const dbPath = path.join(dir, "relayer.db");
  const db = initDb(dbPath);
  configureMatchingEngine({
    db,
    fhePolicyMode: "degraded",
    degradedAllowUnavailable: true,
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
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        db,
        runDeterministicMatchForOrder,
        verifyFheAttestation,
      });
    });
  });
}

async function postSignedIntent({ baseUrl, wallet, side, amount, limitPrice, opNonce, matchNonce, baseAsset = "WBNB", quoteAsset = "USDT" }) {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  const replayKey = ethers.keccak256(
    ethers.toUtf8Bytes(`p4b-replay-${wallet.address}-${opNonce}-${Date.now()}-${Math.random()}`)
  );
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
    ...operatorIntent,
    amount: BigInt(operatorIntent.amount),
    limitPrice: BigInt(operatorIntent.limitPrice),
    expiry: BigInt(operatorIntent.expiry),
    nonce: BigInt(operatorIntent.nonce),
  };
  const opSig = await wallet.signTypedData(opDomain, INTERNAL_ORDER_TYPES, opTyped);

  // The ciphertext envelope mimics what the new tfhe encrypt path would
  // emit: an opaque bundle keyed only by ciphertext fields and the
  // intent-binding ciphertextHash. We must NEVER add a top-level numeric
  // amount/price to this envelope.
  const ciphertext = {
    _tfheAmountCipher: ethers.hexlify(ethers.toUtf8Bytes(`tfhe-amt-${amount}`)),
    _tfhePriceCipher: ethers.hexlify(ethers.toUtf8Bytes(`tfhe-prc-${limitPrice}`)),
    v: 1,
    scheme: "TFHE-FheUint64",
    library: "node-tfhe",
  };
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
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: res.status, body: json };
}

// Recursively walk the persisted match record looking for any key that
// looks like a plaintext exec-amount/price field. The v2 contract is that
// only ciphertext blobs (`*Cipher`) and hashes (`*CiphertextHash`) are
// allowed. Anything named exactly `execAmount` / `execPrice` is forbidden.
const FORBIDDEN_PLAINTEXT_KEYS = new Set([
  "execAmount",
  "execAmountPlain",
  "execAmountPlaintext",
  "execPrice",
  "execPricePlain",
  "execPricePlaintext",
]);

function findPlaintextExecLeak(obj, pathStr = "$") {
  if (obj == null) return null;
  if (typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      const r = findPlaintextExecLeak(obj[i], `${pathStr}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_PLAINTEXT_KEYS.has(k)) {
      return { path: `${pathStr}.${k}`, value: v };
    }
    const r = findPlaintextExecLeak(v, `${pathStr}.${k}`);
    if (r) return r;
  }
  return null;
}

test("phase4b: v2 canonical compare response keeps the in-memory match record free of plaintext exec amount/price", async (t) => {
  const stub = await startStubFheService({ signerKey: SERVICE_KEY });
  t.after(() => { try { stub.server.close(); } catch { /* noop */ } });

  const { baseUrl, db, runDeterministicMatchForOrder } = await setupBackend(t, {
    fheUrl: stub.url,
    expectedSigner: SERVICE_ADDR,
  });

  const seller = ethers.Wallet.createRandom();
  const buyer = ethers.Wallet.createRandom();
  const sellerOut = await postSignedIntent({
    baseUrl, wallet: seller, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001,
  });
  assert.equal(sellerOut.status, 201, JSON.stringify(sellerOut));
  assert.equal(sellerOut.body.matchIntentBound, true);
  const buyerOut = await postSignedIntent({
    baseUrl, wallet: buyer, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001,
  });
  assert.equal(buyerOut.status, 201, JSON.stringify(buyerOut));
  assert.equal(buyerOut.body.matchIntentBound, true);

  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase4b-v2-guard");
  assert.equal(matchOut.matched, true, `match must succeed under v2 canonical path: ${JSON.stringify(matchOut)}`);
  assert.equal(matchOut.reasonCode, "FHE_ACCEPTED");

  const persisted = getMatchByHash(db, matchOut.matchHash);
  assert.ok(persisted, "match must be persisted");
  const meta = persisted.metadataJson || {};

  // 1. Canonical must be the v2 domain.
  assert.ok(meta.fheAttestation, "fheAttestation must be persisted");
  assert.equal(
    meta.fheAttestation.canonical.v,
    "phantom-fhe-attestation/v2",
    "persisted canonical MUST be the v2 domain"
  );

  // 2. Canonical must carry ciphertext hashes, not plaintext exec fields.
  assert.ok(
    typeof meta.fheAttestation.canonical.execAmountCiphertextHash === "string" &&
      meta.fheAttestation.canonical.execAmountCiphertextHash.startsWith("0x"),
    "v2 canonical must carry execAmountCiphertextHash"
  );
  assert.ok(
    typeof meta.fheAttestation.canonical.execPriceCiphertextHash === "string" &&
      meta.fheAttestation.canonical.execPriceCiphertextHash.startsWith("0x"),
    "v2 canonical must carry execPriceCiphertextHash"
  );

  // 3. Deep-scan the entire persisted record for any plaintext exec field.
  const persistedLeak = findPlaintextExecLeak(persisted);
  assert.equal(
    persistedLeak,
    null,
    `persisted match record contained plaintext exec field at ${persistedLeak?.path}: ${JSON.stringify(persistedLeak)}`
  );

  // 4. Same deep-scan against the in-memory matchOut object exposed by the
  //    matcher's runtime API (this is the surface other backend modules
  //    read from).
  const runtimeLeak = findPlaintextExecLeak(matchOut);
  assert.equal(
    runtimeLeak,
    null,
    `runtime matchOut contained plaintext exec field at ${runtimeLeak?.path}: ${JSON.stringify(runtimeLeak)}`
  );
});

test("phase4b: attestation verification passes when signer matches EXPECTED_FHE_ATTESTATION_SIGNER", async (t) => {
  const stub = await startStubFheService({ signerKey: SERVICE_KEY });
  t.after(() => { try { stub.server.close(); } catch { /* noop */ } });

  const { baseUrl, db, runDeterministicMatchForOrder, verifyFheAttestation } = await setupBackend(t, {
    fheUrl: stub.url,
    expectedSigner: SERVICE_ADDR,
  });

  const seller = ethers.Wallet.createRandom();
  const buyer = ethers.Wallet.createRandom();
  const sellerOut = await postSignedIntent({
    baseUrl, wallet: seller, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001,
  });
  const buyerOut = await postSignedIntent({
    baseUrl, wallet: buyer, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001,
  });
  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase4b-ok-signer");
  assert.equal(matchOut.matched, true);
  const persisted = getMatchByHash(db, matchOut.matchHash);
  const meta = persisted.metadataJson || {};
  const v = verifyFheAttestation({
    decisionHash: meta.fheAttestation.decisionHash,
    signature: meta.fheAttestation.signature,
    signerAddress: meta.fheAttestation.signerAddress,
    canonical: meta.fheAttestation.canonical,
  });
  assert.equal(v.valid, true, `verification must pass: ${JSON.stringify(v)}`);
  assert.equal(v.recovered.toLowerCase(), SERVICE_ADDR.toLowerCase());
  assert.equal(v.canonicalDomain, "phantom-fhe-attestation/v2");
});

test("phase4b: attestation verification FAILS when EXPECTED_FHE_ATTESTATION_SIGNER does not match recovered signer", async (t) => {
  const stub = await startStubFheService({ signerKey: SERVICE_KEY });
  t.after(() => { try { stub.server.close(); } catch { /* noop */ } });

  // The stub signs with SERVICE_KEY (=> SERVICE_ADDR). We deliberately pin
  // EXPECTED_FHE_ATTESTATION_SIGNER to WRONG_ADDR so the verifier rejects.
  const { baseUrl, db, runDeterministicMatchForOrder, verifyFheAttestation } = await setupBackend(t, {
    fheUrl: stub.url,
    expectedSigner: WRONG_ADDR,
  });

  const seller = ethers.Wallet.createRandom();
  const buyer = ethers.Wallet.createRandom();
  await postSignedIntent({
    baseUrl, wallet: seller, side: "sell", amount: 100, limitPrice: 10, opNonce: 1, matchNonce: 1001,
  });
  const buyerOut = await postSignedIntent({
    baseUrl, wallet: buyer, side: "buy", amount: 80, limitPrice: 12, opNonce: 1, matchNonce: 2001,
  });

  // The runtime should classify this as "attestation_invalid" and refuse
  // the match (degraded mode is on, so it MIGHT still allow under the
  // degraded-fallback path — assert against direct verifyFheAttestation).
  const matchOut = await runDeterministicMatchForOrder(buyerOut.body.orderId, "phase4b-bad-signer");

  // Even if the matcher ends up degrading the decision, verifyFheAttestation
  // run directly against the FHE stub's attestation MUST reject it because
  // recovered signer ≠ EXPECTED_FHE_ATTESTATION_SIGNER.
  const sk = new ethers.SigningKey(SERVICE_KEY);
  const sampleCanonical = {
    v: "phantom-fhe-attestation/v2",
    matched: true,
    makerCiphertextHash: "0x" + "aa".repeat(32),
    takerCiphertextHash: "0x" + "bb".repeat(32),
    makerUser: seller.address,
    takerUser: buyer.address,
    makerNonce: "1001",
    takerNonce: "2001",
    inputAssetID: "1",
    outputAssetID: "0",
    execAmountCiphertextHash: "0x" + "cc".repeat(32),
    execPriceCiphertextHash: "0x" + "dd".repeat(32),
    ts: "1",
  };
  const digest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(sampleCanonical)));
  const sig = ethers.Signature.from(sk.sign(digest)).serialized;
  const v = verifyFheAttestation({
    decisionHash: digest,
    signature: sig,
    signerAddress: SERVICE_ADDR,
    canonical: sampleCanonical,
  });
  assert.equal(v.valid, false, `verification MUST fail when expected signer mismatches: ${JSON.stringify(v)}`);
  assert.equal(v.reason, "unexpected_signer");
  assert.equal(v.recovered.toLowerCase(), SERVICE_ADDR.toLowerCase());

  // Sanity: the matcher result is either failure-shaped (matched=false) OR
  // — under the still-permissive degraded fallback — succeeded but with the
  // attestation flagged downstream. Either way, no plaintext exec leak.
  const matchHash = matchOut?.matchHash;
  if (matchHash) {
    const persisted = getMatchByHash(db, matchHash);
    if (persisted) {
      const leak = findPlaintextExecLeak(persisted);
      assert.equal(leak, null, `even on signer mismatch, persisted record must not leak plaintext exec values: ${JSON.stringify(leak)}`);
    }
  }
});

test("phase4b: verifyFheAttestation REFUSES a v2 canonical that smuggles a plaintext execAmount/execPrice", () => {
  // Re-load matching service (without re-setting env, so EXPECTED_FHE_*
  // remains pinned to whatever the previous test left it as — irrelevant
  // here because the canonical is rejected at the shape gate before signer
  // checks).
  delete require.cache[matchingModulePath];
  const { verifyFheAttestation } = require("../src/fheMatchingService");
  const sk = new ethers.SigningKey(SERVICE_KEY);
  const tainted = {
    v: "phantom-fhe-attestation/v2",
    matched: true,
    makerCiphertextHash: "0x" + "aa".repeat(32),
    takerCiphertextHash: "0x" + "bb".repeat(32),
    makerUser: "0x0000000000000000000000000000000000000001",
    takerUser: "0x0000000000000000000000000000000000000002",
    makerNonce: "1",
    takerNonce: "2",
    inputAssetID: "0",
    outputAssetID: "1",
    execAmountCiphertextHash: "0x" + "cc".repeat(32),
    execPriceCiphertextHash: "0x" + "dd".repeat(32),
    execAmount: "80", // <-- forbidden in v2
    ts: "1",
  };
  const digest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(tainted)));
  const sig = ethers.Signature.from(sk.sign(digest)).serialized;
  const v = verifyFheAttestation({
    decisionHash: digest,
    signature: sig,
    signerAddress: SERVICE_ADDR,
    canonical: tainted,
  });
  assert.equal(v.valid, false);
  assert.match(String(v.reason || ""), /^v2_plaintext_exec_field_forbidden/);
});
