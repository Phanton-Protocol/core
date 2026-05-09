const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");

const STANDIN_PATH = path.resolve(__dirname, "../../../fhe-dev/standin-server.js");
const SERVICE_KEY = "0x" + "11".repeat(32);
const SERVICE_ADDR = new ethers.Wallet(SERVICE_KEY).address;

function pickPort() {
  return 9100 + Math.floor(Math.random() * 800);
}

function startStandin(t, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [STANDIN_PATH], {
      env: { ...process.env, FHE_STANDIN_PORT: String(port), MATCHING_SERVICE_PRIVATE_KEY: SERVICE_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onData = (chunk) => {
      buf += String(chunk);
      if (buf.includes("listening")) resolve(proc);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    setTimeout(() => reject(new Error("standin start timeout: " + buf)), 5000);
    t.after(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
    });
  });
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const txt = await res.text();
  let body;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: res.status, body };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function buildIntent(side /* 0 sell, 1 buy */, amount, limitPrice, user, nonce, ciphertextHash, deadlineSec) {
  return {
    user,
    side,
    inputAssetID: side === 0 ? "0" : "1",
    outputAssetID: side === 0 ? "1" : "0",
    amount: String(amount),
    limitPrice: String(limitPrice),
    nonce: String(nonce),
    deadline: String(deadlineSec),
    ciphertextHash,
  };
}

function buildBundle(intent, amount, price) {
  const ciphertext = {
    _ckksAmount: ethers.hexlify(ethers.toUtf8Bytes(String(amount))),
    _ckksPrice: ethers.hexlify(ethers.toUtf8Bytes(String(price))),
    amount: String(amount),
    limitPrice: String(price),
  };
  return { intent, ciphertext };
}

test("phase3 standin /attestation-pubkey exposes deterministic signer", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const out = await fetchJson(`http://127.0.0.1:${port}/attestation-pubkey`);
  assert.equal(out.status, 200);
  assert.equal(out.body?.signerAddress?.toLowerCase(), SERVICE_ADDR.toLowerCase());
});

test("phase3 standin /internal-match/compare signs a verifiable attestation on happy match", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const makerWallet = ethers.Wallet.createRandom();
  const takerWallet = ethers.Wallet.createRandom();
  const makerHash = ethers.keccak256(ethers.toUtf8Bytes("maker-cipher"));
  const takerHash = ethers.keccak256(ethers.toUtf8Bytes("taker-cipher"));
  const makerIntent = buildIntent(0, 100, 10, makerWallet.address, 1, makerHash, deadline);
  const takerIntent = buildIntent(1, 80, 12, takerWallet.address, 2, takerHash, deadline);
  const body = {
    maker: buildBundle(makerIntent, 100, 10),
    taker: buildBundle(takerIntent, 80, 12),
  };
  const out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(out.status, 200);
  assert.equal(out.body?.matched, true);
  assert.equal(out.body?.result?.execAmount, "80");
  assert.equal(out.body?.result?.execPrice, "11");

  const att = out.body.attestation;
  const recomputedDigest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(att.canonical)));
  assert.equal(recomputedDigest, att.decisionHash);
  const recovered = ethers.recoverAddress(att.decisionHash, att.signature);
  assert.equal(recovered.toLowerCase(), SERVICE_ADDR.toLowerCase());
  assert.equal(att.signerAddress.toLowerCase(), SERVICE_ADDR.toLowerCase());
});

test("phase3 standin rejects price-cross failure deterministically", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const m = ethers.Wallet.createRandom();
  const tk = ethers.Wallet.createRandom();
  const makerIntent = buildIntent(0, 100, 20, m.address, 1, ethers.ZeroHash, deadline);
  const takerIntent = buildIntent(1, 100, 10, tk.address, 2, ethers.ZeroHash, deadline);
  const body = {
    maker: buildBundle(makerIntent, 100, 20),
    taker: buildBundle(takerIntent, 100, 10),
  };
  const out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(out.status, 200);
  assert.equal(out.body?.matched, false);
  assert.equal(out.body?.reason, "price_cross_failed");
});

test("phase3 standin rejects same-side and asset mismatch", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const m = ethers.Wallet.createRandom().address;
  const tk = ethers.Wallet.createRandom().address;
  const makerIntent = buildIntent(0, 100, 10, m, 1, ethers.ZeroHash, deadline);
  const sameSide = buildIntent(0, 100, 12, tk, 2, ethers.ZeroHash, deadline);
  let out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maker: buildBundle(makerIntent, 100, 10), taker: buildBundle(sameSide, 100, 12) }),
  });
  assert.equal(out.body?.matched, false);
  assert.equal(out.body?.reason, "side_mismatch");

  const wrongAsset = { ...buildIntent(1, 100, 12, tk, 3, ethers.ZeroHash, deadline), inputAssetID: "9" };
  out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maker: buildBundle(makerIntent, 100, 10), taker: buildBundle(wrongAsset, 100, 12) }),
  });
  assert.equal(out.body?.matched, false);
  assert.equal(out.body?.reason, "asset_mismatch");
});

test("phase3 standin rejects expired intent deadline", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const m = ethers.Wallet.createRandom().address;
  const tk = ethers.Wallet.createRandom().address;
  const expired = 1n;
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const makerIntent = buildIntent(0, 100, 10, m, 1, ethers.ZeroHash, expired);
  const takerIntent = buildIntent(1, 100, 12, tk, 2, ethers.ZeroHash, future);
  const out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maker: buildBundle(makerIntent, 100, 10), taker: buildBundle(takerIntent, 100, 12) }),
  });
  assert.equal(out.body?.matched, false);
  assert.equal(out.body?.reason, "maker_expired");
});

test("phase3 standin attestation tampering is detectable (recoveredSigner mismatch)", async (t) => {
  const port = pickPort();
  await startStandin(t, port);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const m = ethers.Wallet.createRandom().address;
  const tk = ethers.Wallet.createRandom().address;
  const body = {
    maker: buildBundle(buildIntent(0, 100, 10, m, 1, ethers.ZeroHash, deadline), 100, 10),
    taker: buildBundle(buildIntent(1, 100, 12, tk, 2, ethers.ZeroHash, deadline), 100, 12),
  };
  const out = await fetchJson(`http://127.0.0.1:${port}/internal-match/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const att = out.body.attestation;
  const tampered = { ...att.canonical, execPrice: "999" };
  const tamperedDigest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(tampered)));
  assert.notEqual(tamperedDigest, att.decisionHash);
  const recoveredFromTampered = ethers.recoverAddress(tamperedDigest, att.signature);
  assert.notEqual(recoveredFromTampered.toLowerCase(), SERVICE_ADDR.toLowerCase());
});
