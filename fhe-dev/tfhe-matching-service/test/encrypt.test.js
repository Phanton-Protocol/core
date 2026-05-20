"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { ethers } = require("ethers");

// Use an isolated temp keystore for tests so the repo's keys/ stays empty.
const TMP_KEYS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tfhe-test-"));
const SECRET_PATH = path.join(TMP_KEYS_DIR, "secret.key");
const PUBLIC_PATH = path.join(TMP_KEYS_DIR, "public.key");
const TEST_PRIVATE_KEY = "0x" + "11".repeat(32);
const TEST_SIGNER_ADDRESS = new ethers.Wallet(TEST_PRIVATE_KEY).address;

process.env.MATCHING_SERVICE_PRIVATE_KEY = TEST_PRIVATE_KEY;
process.env.TFHE_PUBLIC_KEY_PATH = PUBLIC_PATH;
process.env.TFHE_SECRET_KEY_PATH = SECRET_PATH;

const { createApp, buildEngine } = require("../src/server");
const tfhe = require("node-tfhe");

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

test("GET /health returns ok mode=homomorphic", async () => {
  const r = await fetchJson("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.equal(r.body.mode, "homomorphic");
  assert.equal(r.body.library, "node-tfhe");
});

test("GET /public-key returns TFHE compact public key hex", async () => {
  const r = await fetchJson("GET", "/public-key");
  assert.equal(r.status, 200);
  assert.equal(r.body.scheme, "TFHE");
  assert.equal(r.body.library, "node-tfhe");
  assert.match(r.body.publicKey, /^0x[0-9a-fA-F]+$/);
  assert.ok(r.body.publicKey.length > 100, "public key should be non-trivial");
});

test("GET /attestation-pubkey returns the ECDSA signer address", async () => {
  const r = await fetchJson("GET", "/attestation-pubkey");
  assert.equal(r.status, 200);
  assert.equal(r.body.scheme, "ECDSA secp256k1");
  assert.equal(r.body.signerAddress, TEST_SIGNER_ADDRESS);
});

test("POST /encrypt round-trips: serialize -> deserialize without business-field decrypt", async () => {
  const r = await fetchJson("POST", "/encrypt", { amount: 100, price: 300, side: 1 });
  assert.equal(r.status, 200);
  const bundle = r.body.ciphertext;
  assert.ok(bundle, "response.ciphertext present");
  assert.equal(bundle.scheme, "TFHE-FheUint64");
  assert.equal(bundle.library, "node-tfhe");
  assert.match(bundle._tfheAmountCipher, /^0x[0-9a-fA-F]+$/);
  assert.match(bundle._tfhePriceCipher, /^0x[0-9a-fA-F]+$/);

  // The response MUST NOT echo plaintext amount / price.
  assert.equal(bundle.amount, undefined, "bundle must not echo plaintext amount");
  assert.equal(bundle.price, undefined, "bundle must not echo plaintext price");
  assert.equal(bundle.limitPrice, undefined, "bundle must not echo plaintext limitPrice");
  assert.equal(bundle.value, undefined, "bundle must not echo plaintext value");

  // ciphertextHash on the response is deterministic over the bundle.
  assert.match(r.body.ciphertextHash, /^0x[0-9a-fA-F]{64}$/);

  // Round-trip: serialize -> deserialize the TFHE FheUint64 ciphertexts WITHOUT
  // calling decrypt on the business operand fields.
  const amtBytes = Buffer.from(bundle._tfheAmountCipher.slice(2), "hex");
  const ctRoundTripped = tfhe.FheUint64.deserialize(new Uint8Array(amtBytes));
  // Re-serialize and compare.
  const reSer = Buffer.from(ctRoundTripped.serialize());
  assert.equal(reSer.toString("hex"), amtBytes.toString("hex"), "round-trip preserves bytes");

  // No decrypt call here. We only verify the ciphertext is well-formed.
});

test("POST /encrypt logs do not contain plaintext operand values", async () => {
  // Capture stdout while doing a fresh encrypt call.
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    try { captured.push(String(chunk)); } catch {}
    return originalWrite(chunk, ...rest);
  };
  try {
    await fetchJson("POST", "/encrypt", { amount: 42424242, price: 31415926, secretField: "should-not-appear" });
  } finally {
    process.stdout.write = originalWrite;
  }
  const joined = captured.join("");
  assert.ok(!joined.includes("42424242"), "stdout must not contain plaintext amount");
  assert.ok(!joined.includes("31415926"), "stdout must not contain plaintext price");
  // We also want to ensure no `amount:` or `price:` style field exists in log lines.
  for (const line of joined.split(/\n/)) {
    if (!line.trim()) continue;
    // Must be parseable as JSON since safeLog writes JSON.
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && typeof obj === "object") {
      assert.equal(obj.amount, undefined, "log line must not include amount");
      assert.equal(obj.price, undefined, "log line must not include price");
      assert.equal(obj.value, undefined, "log line must not include value");
      assert.equal(obj.limitPrice, undefined, "log line must not include limitPrice");
    }
  }
});

test(".gitignore covers keys/*.key and .env", () => {
  const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.ok(/keys\/\*\.key/.test(gi), ".gitignore must ignore keys/*.key");
  assert.ok(/^\.env$/m.test(gi), ".gitignore must ignore .env");
});

test("keys/ contains a .gitkeep but no .key files in the repo", () => {
  const keysDir = path.join(__dirname, "..", "keys");
  const entries = fs.readdirSync(keysDir);
  assert.ok(entries.includes(".gitkeep"));
  const leaked = entries.filter((e) => e.endsWith(".key") || e.endsWith(".bin"));
  assert.deepEqual(leaked, [], `key material leaked into repo: ${leaked.join(",")}`);
});
