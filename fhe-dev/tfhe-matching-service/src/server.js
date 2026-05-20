"use strict";

/**
 * tfhe-matching-service HTTP entrypoint.
 *
 * Routes:
 *   GET  /health
 *   GET  /public-key
 *   GET  /attestation-pubkey
 *   POST /encrypt
 *   POST /internal-match/compare
 *
 * SECURITY NOTES:
 *  - Default bind is 127.0.0.1 — never expose this service to the public
 *    internet without mTLS / VPC isolation.
 *  - This service holds the TFHE secret key. Filesystem permissions on
 *    `keys/secret.key` must be locked down (the keystore writes with mode 0600).
 *  - Logs deliberately omit `value`, `amount`, `price`, and bundle contents.
 *    They emit ciphertext **lengths** and **hashes** only.
 */

try {
  // Optional in tests; required in standalone runs.
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch {
  // ignore — dotenv not installed
}

const express = require("express");
const { ethers } = require("ethers");
const { FheEngine, loadOrGenerateKeystore } = require("./fheEngine");
const { loadSigner } = require("./attestation");

const SERVICE_VERSION = "0.1.0";
const SERVICE_LIBRARY = "node-tfhe";

function safeLog(obj) {
  // Single-line JSON; never includes raw operand values.
  try {
    process.stdout.write(JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    process.stdout.write(`[fhe-svc] log_serialize_failed: ${obj?.event || "unknown"}\n`);
  }
}

function createApp(engine) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mode: "homomorphic", version: SERVICE_VERSION, library: SERVICE_LIBRARY });
  });

  app.get("/public-key", (_req, res) => {
    const publicKey = engine.publicKeyHex();
    if (!publicKey) return res.status(503).json({ error: "public_key_unavailable" });
    res.json({ publicKey, scheme: "TFHE", library: SERVICE_LIBRARY });
  });

  app.get("/attestation-pubkey", (_req, res) => {
    res.json({
      signerAddress: engine.signer.address,
      scheme: "ECDSA secp256k1",
      library: SERVICE_LIBRARY,
      fheScheme: "TFHE",
    });
  });

  app.post("/encrypt", (req, res) => {
    try {
      const body = req.body || {};
      const { bundle, ciphertextHash } = engine.encryptOrderBundle(body);
      const bundleSize = JSON.stringify(bundle).length;
      safeLog({
        event: "fhe.encrypt.ok",
        ciphertextHash,
        bundleBytes: bundleSize,
        amountCipherBytes: bundle._tfheAmountCipher.length,
        priceCipherBytes: bundle._tfhePriceCipher.length,
      });
      res.json({ ciphertext: bundle, ciphertextHash });
    } catch (e) {
      safeLog({ event: "fhe.encrypt.err", error: e?.message || String(e) });
      res.status(400).json({ error: e?.message || "encrypt_failed" });
    }
  });

  app.post("/internal-match/compare", (req, res) => {
    try {
      const body = req.body || {};
      const out = engine.compareOrders({
        maker: body.maker,
        taker: body.taker,
        traceId: body.traceId || null,
        context: body.context || null,
      });
      safeLog({
        event: out.matched ? "fhe.compare.match" : "fhe.compare.no_match",
        traceId: body.traceId || null,
        reason: out.reason || null,
        makerCiphertextHash: out.bindings?.makerCiphertextHash || null,
        takerCiphertextHash: out.bindings?.takerCiphertextHash || null,
        decisionHash: out.attestation?.decisionHash || null,
      });
      res.json(out);
    } catch (e) {
      safeLog({ event: "fhe.compare.err", error: e?.message || String(e) });
      res.status(400).json({ matched: false, reason: e?.message || "compare_failed" });
    }
  });

  app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));

  return app;
}

function buildEngine({
  privateKeyEnv = process.env.MATCHING_SERVICE_PRIVATE_KEY,
  publicKeyPath = process.env.TFHE_PUBLIC_KEY_PATH || "./keys/public.key",
  secretKeyPath = process.env.TFHE_SECRET_KEY_PATH || "./keys/secret.key",
  expectedFingerprint = process.env.TFHE_KEY_FINGERPRINT || null,
  log = safeLog,
} = {}) {
  const signer = loadSigner(privateKeyEnv);
  const ks = loadOrGenerateKeystore({ publicKeyPath, secretKeyPath, expectedFingerprint, log });
  const engine = new FheEngine({
    clientKey: ks.clientKey,
    compactPublicKey: ks.compactPublicKey,
    signer,
  });
  return { engine, fingerprint: ks.fingerprint };
}

function start({ port = Number(process.env.MATCHING_SERVICE_PORT || 4001),
                 bind = process.env.MATCHING_SERVICE_BIND || "127.0.0.1" } = {}) {
  const { engine, fingerprint } = buildEngine();
  const app = createApp(engine);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, bind, () => {
      safeLog({
        event: "fhe.service.ready",
        port,
        bind,
        signer: engine.signer.address,
        keyFingerprint: fingerprint,
      });
      resolve({ app, server, engine });
    });
    server.on("error", reject);
  });
}

if (require.main === module) {
  start().catch((e) => {
    safeLog({ event: "fhe.service.boot.err", error: e?.message || String(e) });
    process.exit(1);
  });
}

module.exports = { createApp, buildEngine, start, SERVICE_VERSION, SERVICE_LIBRARY };
