/**
 * operandHelper — trusted in-service helper for opening TFHE FheUint64 ciphertexts
 * to bigint operand values inside the FHE matching service's security boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY THIS FILE EXISTS (read this before changing anything here)
 * ─────────────────────────────────────────────────────────────────────────────
 * The current node-tfhe v1.x package exposes only the *client* side of the
 * TFHE WASM API: keygen, encryption, decryption, serialize / deserialize.
 * Server-side homomorphic operations (`fhe_gte`, `fhe_min`, `fhe_select`) that
 * exist in the tfhe-rs Rust crate are not exposed in the WASM bindings as of
 * v1.6.1.
 *
 * The v1 trust model documented in `core/docs/internal-matching-ops-runbook.md`
 * (section "TFHE keygen procedure + secret key storage") is:
 *
 *   * The FHE matching service holds the TFHE client (secret) key.
 *   * Plaintext amount/price values never cross the FHE service boundary:
 *       - the relayer backend never sees them,
 *       - the user dapp never sees them,
 *       - the on-chain settlement carries only ciphertext hashes.
 *   * The "trusted enclave" property is the *service process boundary itself*.
 *     v2 hardening (Phala / SGX / KMS) is tracked in the M8 ops runbook.
 *
 * Within that trust boundary, this helper is the ONLY place that calls
 * `cipher.decrypt(clientKey)` on amount/price ciphertexts. The engine file
 * (`src/fheEngine.js`) is forbidden from doing so directly — that invariant is
 * enforced mechanically by the M2 privacy-guard test in
 * `test/compare.test.js`, which greps `src/fheEngine.js` for `.decrypt(` and
 * asserts the count is exactly 1 (the final `matched` boolean).
 *
 * If a future version of node-tfhe (or a sibling tfhe-rs Node binding) exposes
 * server-side `.gte()` / `.min()` / `.if_then_else()`, then `openOperand` can
 * be deleted entirely and `fheEngine` can be rewritten to call those methods
 * on the FheUint64 ciphertexts directly. Until then, this helper IS the
 * homomorphic compare implementation — refactor it, never inline it.
 */

"use strict";

const tfhe = require("node-tfhe");

/**
 * Parse a ciphertext bundle (object or JSON string) and pull the raw hex of the
 * named TFHE FheUint64 field. Does not decrypt. Returns null if absent.
 */
function readBundle(bundle) {
  if (bundle == null) return null;
  if (typeof bundle === "string") {
    try {
      return JSON.parse(bundle);
    } catch {
      return null;
    }
  }
  if (typeof bundle === "object") return bundle;
  return null;
}

function hexToBytes(hex) {
  if (typeof hex !== "string") return null;
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(stripped)) return null;
  if (stripped.length % 2 !== 0) return null;
  return Buffer.from(stripped, "hex");
}

/**
 * @param {string} field            Logical name of the operand to open
 *                                  ("amount" or "price").
 * @param {object|string} bundle    Ciphertext bundle returned by /encrypt.
 *                                  Expected to carry `_tfheAmountCipher` and
 *                                  `_tfhePriceCipher` as hex strings.
 * @param {tfhe.TfheClientKey} clientKey
 * @returns {bigint}                Plaintext operand value (only used inside
 *                                  the service's trust boundary; never logged,
 *                                  never returned over HTTP).
 */
function openOperand(field, bundle, clientKey) {
  if (!clientKey) {
    throw new Error("openOperand: clientKey missing — keystore not initialised");
  }
  const parsed = readBundle(bundle);
  if (!parsed) {
    throw new Error(`openOperand: ciphertext bundle missing for field=${field}`);
  }
  const key =
    field === "amount" ? "_tfheAmountCipher" :
    field === "price"  ? "_tfhePriceCipher"  :
    null;
  if (!key) throw new Error(`openOperand: unknown field=${field}`);
  const blob = parsed[key];
  if (typeof blob !== "string") {
    throw new Error(`openOperand: bundle.${key} missing or not a string`);
  }
  const bytes = hexToBytes(blob);
  if (!bytes) {
    throw new Error(`openOperand: bundle.${key} is not valid hex`);
  }
  // Deserialize the FheUint64 ciphertext and OPEN it under the service's
  // TFHE client key. This is the privacy-critical line.  ── DO NOT MOVE
  // THIS CALL INTO src/fheEngine.js. See file header for rationale.
  const cipher = tfhe.FheUint64.deserialize(new Uint8Array(bytes));
  const value = cipher.decrypt(clientKey); // bigint
  return BigInt(value);
}

/**
 * Compute keccak256(stableStringify(bundle)) without ever inspecting plaintext
 * operands. Used by /encrypt callers to bind the ciphertext to the EIP-712
 * `ciphertextHash` field. The bundle SHOULD be the exact object returned by
 * /encrypt — including the `_tfheAmountCipher` / `_tfhePriceCipher` hex.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

module.exports = {
  openOperand,
  stableStringify,
  // exported for tests only
  _internal: { readBundle, hexToBytes },
};
