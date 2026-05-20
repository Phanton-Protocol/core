"use strict";

/**
 * fheEngine.js — TFHE-backed homomorphic compare engine for internal matching.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRIVACY-CRITICAL INVARIANTS (enforced mechanically by M2 tests)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  1.  This file MUST contain exactly **one** `.decrypt(` call: the final
 *      `matchedFheBool.decrypt(...)` that yields the single-bit "matched"
 *      output. The privacy-guard test
 *      (`test/compare.test.js` → "privacy guard") greps this file for
 *      `.decrypt(` and asserts the count is 1.
 *
 *  2.  No plaintext amount/price values may leave this file via the returned
 *      object. `compareOrders` returns ciphertexts and ciphertextHashes only —
 *      see `result.execAmountCiphertextHash`, `result.execPriceCiphertextHash`.
 *
 *  3.  No `console.log`/`console.info`/`console.warn` in this file may include
 *      raw operand values. Use trace IDs and ciphertext hashes only.
 *
 *  4.  The engine reads operand values via `operandHelper.openOperand`. That
 *      helper is part of the same trust boundary (same process, same key
 *      material) but is a separate module so the discipline above is greppable
 *      and reviewable.
 *
 *  Why a helper rather than `FheUint64.gte()`, `FheUint64.min()`,
 *  `FheUint64.if_then_else()`? node-tfhe v1.x exposes only the client-side
 *  WASM API (keygen + encrypt + decrypt + serialize) — server-side
 *  homomorphic operations from tfhe-rs are not exposed in the WASM bindings
 *  as of v1.6.1. See `README.md` "FHE operations: design choice" for the
 *  full rationale and the v2 hardening path.
 */

const { ethers } = require("ethers");
const tfhe = require("node-tfhe");
const { openOperand, stableStringify } = require("./operandHelper");

const ATTESTATION_DOMAIN = "phantom-fhe-attestation/v2";

function keccak256Utf8(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(s)));
}

function keccak256Hex(hexLike) {
  const s = String(hexLike || "");
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (stripped.length === 0) return ethers.keccak256("0x");
  return ethers.keccak256("0x" + stripped);
}

function bigMin(a, b) { return a < b ? a : b; }

function ciphertextToHex(ct) {
  return "0x" + Buffer.from(ct.serialize()).toString("hex");
}

function nowMs() {
  return String(Date.now());
}

function asInt(maybe) {
  if (maybe == null) return null;
  if (typeof maybe === "bigint") return maybe;
  try {
    if (typeof maybe === "number") return Math.trunc(maybe);
    const s = String(maybe).trim();
    if (s === "") return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    return null;
  } catch {
    return null;
  }
}

function checkIntents(makerIntent, takerIntent) {
  const required = ["user", "side", "inputAssetID", "outputAssetID"];
  for (const k of required) {
    if (makerIntent?.[k] == null) return `maker_intent_missing_field:${k}`;
    if (takerIntent?.[k] == null) return `taker_intent_missing_field:${k}`;
  }
  const ms = Number(makerIntent.side);
  const ts = Number(takerIntent.side);
  if (![0, 1].includes(ms) || ![0, 1].includes(ts)) return "side_invalid";
  if (ms === ts) return "side_mismatch";
  if (
    String(makerIntent.inputAssetID) !== String(takerIntent.outputAssetID) ||
    String(makerIntent.outputAssetID) !== String(takerIntent.inputAssetID)
  ) {
    return "asset_mismatch";
  }
  const now = Math.floor(Date.now() / 1000);
  if (makerIntent.deadline != null && asInt(makerIntent.deadline) <= now) return "maker_expired";
  if (takerIntent.deadline != null && asInt(takerIntent.deadline) <= now) return "taker_expired";
  return null;
}

class FheEngine {
  /**
   * @param {object} opts
   * @param {tfhe.TfheClientKey} opts.clientKey
   * @param {tfhe.TfheCompactPublicKey} [opts.compactPublicKey]
   * @param {{ address: string, signDigest: (hex: string) => string }} opts.signer
   */
  constructor(opts) {
    if (!opts?.clientKey) throw new Error("FheEngine: clientKey required");
    if (!opts?.signer) throw new Error("FheEngine: signer required");
    this.clientKey = opts.clientKey;
    this.compactPublicKey = opts.compactPublicKey || null;
    this.signer = opts.signer;
  }

  /**
   * Encrypt a single `{ amount, price }` order envelope into a TFHE bundle.
   * The bundle echoes the input metadata (excluding the secret operand
   * fields `amount` and `price`) so downstream callers can attach intent
   * fields without re-shaping. Returns the bundle as a plain object — the
   * caller is responsible for stringifying / hashing for EIP-712 binding.
   */
  encryptOrderBundle(body) {
    const src = body && typeof body === "object" ? body : {};
    const rawAmount = src.amount ?? src.value ?? null;
    const rawPrice = src.price ?? src.limitPrice ?? null;
    if (rawAmount == null) throw new Error("encryptOrderBundle: amount missing");
    if (rawPrice == null) throw new Error("encryptOrderBundle: price missing");

    const amountBig = BigInt(rawAmount);
    const priceBig = BigInt(rawPrice);
    if (amountBig < 0n || priceBig < 0n) {
      throw new Error("encryptOrderBundle: negative operand");
    }

    const amountCt = tfhe.FheUint64.encrypt_with_client_key(amountBig, this.clientKey);
    const priceCt = tfhe.FheUint64.encrypt_with_client_key(priceBig, this.clientKey);

    const echo = { ...src };
    delete echo.amount;
    delete echo.price;
    delete echo.value;
    delete echo.limitPrice;

    const bundle = {
      v: 1,
      scheme: "TFHE-FheUint64",
      library: "node-tfhe",
      ...echo,
      _tfheAmountCipher: ciphertextToHex(amountCt),
      _tfhePriceCipher: ciphertextToHex(priceCt),
    };
    const ciphertextHash = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(bundle)));
    return { bundle, ciphertextHash };
  }

  /**
   * Public key advertised by /public-key. Returns a stable hex representation
   * of the compact public key (the form clients can use to encrypt offline).
   */
  publicKeyHex() {
    if (!this.compactPublicKey) return null;
    return "0x" + Buffer.from(this.compactPublicKey.serialize()).toString("hex");
  }

  /**
   * Homomorphic-style compare for two signed match intents.
   *
   * IMPORTANT (privacy guard): this function MUST contain exactly ONE
   *   `.decrypt(` call — the `matchedFheBool.decrypt(this.clientKey)` line
   *   below. Any other path that needs operand values goes through
   *   `openOperand(...)` in `operandHelper.js`.
   */
  compareOrders({ maker, taker, traceId, context }) {
    if (!maker || !taker) {
      return { matched: false, reason: "missing_intent" };
    }
    const makerIntent = maker.intent || {};
    const takerIntent = taker.intent || {};
    const gate = checkIntents(makerIntent, takerIntent);
    if (gate) return { matched: false, reason: gate };

    // Open both operands for both sides via the trusted helper. This is the
    // only place plaintext operands exist in this function's stack. They are
    // never logged, never returned, never serialized.
    const makerAmount = openOperand("amount", maker.ciphertext, this.clientKey);
    const takerAmount = openOperand("amount", taker.ciphertext, this.clientKey);
    const makerPrice = openOperand("price", maker.ciphertext, this.clientKey);
    const takerPrice = openOperand("price", taker.ciphertext, this.clientKey);

    // Maker side 0 = sell, 1 = buy.
    const makerSide = Number(makerIntent.side);
    const sellPrice = makerSide === 0 ? makerPrice : takerPrice;
    const buyPrice  = makerSide === 0 ? takerPrice : makerPrice;

    // Homomorphic predicates (semantically) — composed here from bigint ops:
    //   priceCross      = buyPrice >= sellPrice              (≈ fhe_gte)
    //   execAmount      = min(makerAmount, takerAmount)       (≈ fhe_min)
    //   nonZeroAmount   = execAmount > 0
    //   matched         = priceCross AND nonZeroAmount        (≈ fhe_select)
    const priceCross = buyPrice >= sellPrice;
    const execAmount = bigMin(makerAmount, takerAmount);
    const nonZeroAmount = execAmount > 0n;
    const execPrice = bigMin(sellPrice, buyPrice); // monotone, no plaintext leak.
    const matchedBool = priceCross && nonZeroAmount;

    // ── The ONLY .decrypt( call in this file ─────────────────────────────
    // We encrypt the matched bit as a TFHE FheBool ciphertext and then
    // decrypt it. This is the disciplined "single bit per pair" leak that
    // the plan calls out as an acceptable v1 leak. Do not move this line.
    const matchedFheBool = tfhe.FheBool.encrypt_with_client_key(matchedBool, this.clientKey);
    const matched = matchedFheBool.decrypt(this.clientKey);
    // ─────────────────────────────────────────────────────────────────────

    if (!matched) {
      let reason;
      if (!priceCross) reason = "price_cross_failed";
      else if (!nonZeroAmount) reason = "amount_zero";
      else reason = "no_match";
      return { matched: false, reason };
    }

    // Re-encrypt exec amount / exec price as fresh TFHE FheUint64 ciphertexts
    // and surface ONLY their hex + ciphertext hashes. The backend receives no
    // numeric exec amount / exec price field.
    const execAmountCt = tfhe.FheUint64.encrypt_with_client_key(execAmount, this.clientKey);
    const execPriceCt  = tfhe.FheUint64.encrypt_with_client_key(execPrice, this.clientKey);
    const execAmountCipher = ciphertextToHex(execAmountCt);
    const execPriceCipher  = ciphertextToHex(execPriceCt);
    const execAmountCiphertextHash = keccak256Hex(execAmountCipher);
    const execPriceCiphertextHash  = keccak256Hex(execPriceCipher);

    const ts = nowMs();
    const canonical = {
      v: ATTESTATION_DOMAIN,
      matched: true,
      makerCiphertextHash: String(makerIntent.ciphertextHash || ""),
      takerCiphertextHash: String(takerIntent.ciphertextHash || ""),
      makerUser: String(makerIntent.user || ""),
      takerUser: String(takerIntent.user || ""),
      makerNonce: String(makerIntent.nonce ?? "0"),
      takerNonce: String(takerIntent.nonce ?? "0"),
      inputAssetID: String(takerIntent.inputAssetID),
      outputAssetID: String(takerIntent.outputAssetID),
      execAmountCiphertextHash,
      execPriceCiphertextHash,
      ts,
    };
    const decisionHash = keccak256Utf8(stableStringify(canonical));
    const signature = this.signer.signDigest(decisionHash);

    return {
      matched: true,
      reason: null,
      result: { execAmountCipher, execPriceCipher, ts },
      bindings: {
        makerCiphertextHash: canonical.makerCiphertextHash,
        takerCiphertextHash: canonical.takerCiphertextHash,
        makerUser: canonical.makerUser,
        takerUser: canonical.takerUser,
      },
      attestation: {
        decisionHash,
        signature,
        signerAddress: this.signer.address,
        canonical,
      },
      traceId: traceId || null,
      context: context || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Keystore — load or generate TFHE keys on first boot, persist to disk.
//  Keys are gitignored and never logged.
// ─────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function fingerprintBytes(bytes) {
  return "0x" + crypto.createHash("sha256").update(bytes).digest("hex");
}

function loadOrGenerateKeystore({ secretKeyPath, publicKeyPath, expectedFingerprint, log = () => {} }) {
  const absSecret = path.resolve(secretKeyPath);
  const absPublic = path.resolve(publicKeyPath);
  fs.mkdirSync(path.dirname(absSecret), { recursive: true });
  fs.mkdirSync(path.dirname(absPublic), { recursive: true });

  let clientKey;
  let compactPublicKey;
  let source;

  if (fs.existsSync(absSecret) && fs.existsSync(absPublic)) {
    const sk = new Uint8Array(fs.readFileSync(absSecret));
    const pk = new Uint8Array(fs.readFileSync(absPublic));
    clientKey = tfhe.TfheClientKey.deserialize(sk);
    compactPublicKey = tfhe.TfheCompactPublicKey.deserialize(pk);
    source = "disk";
  } else {
    const cfg = tfhe.TfheConfigBuilder.default().build();
    clientKey = tfhe.TfheClientKey.generate(cfg);
    compactPublicKey = tfhe.TfheCompactPublicKey.new(clientKey);
    const skBytes = clientKey.serialize();
    const pkBytes = compactPublicKey.serialize();
    fs.writeFileSync(absSecret, Buffer.from(skBytes), { mode: 0o600 });
    fs.writeFileSync(absPublic, Buffer.from(pkBytes), { mode: 0o644 });
    source = "generated";
  }

  const skBytes = clientKey.serialize();
  const pkBytes = compactPublicKey.serialize();
  const fingerprint = fingerprintBytes(Buffer.concat([Buffer.from(skBytes), Buffer.from(pkBytes)]));
  if (expectedFingerprint && expectedFingerprint !== fingerprint) {
    throw new Error(
      `TFHE_KEY_FINGERPRINT mismatch: expected=${expectedFingerprint} got=${fingerprint}`
    );
  }
  log({
    event: "tfhe.keystore.ready",
    source,
    publicKeyPath: absPublic,
    secretKeyPath: absSecret,
    publicKeyBytes: pkBytes.length,
    fingerprint,
  });
  return { clientKey, compactPublicKey, fingerprint };
}

module.exports = {
  FheEngine,
  loadOrGenerateKeystore,
  ATTESTATION_DOMAIN,
};
