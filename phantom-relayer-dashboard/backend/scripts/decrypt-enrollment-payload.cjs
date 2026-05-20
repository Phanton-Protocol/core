#!/usr/bin/env node
/**
 * Owner audit helper: decrypt enrollment ciphertext copied to the relayer DB.
 * On-chain ciphertext is opaque; decryption uses PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX only.
 *
 * Usage:
 *   PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX=<64-hex> node scripts/decrypt-enrollment-payload.cjs 0x<hex>
 */
const { decryptEnrollmentMetadata } = require("../src/enrollmentCipher");

function main() {
  const hex = (process.argv[2] || "").trim();
  if (!hex) {
    console.error("Usage: node scripts/decrypt-enrollment-payload.cjs <encryptedPayloadHex>");
    process.exit(1);
  }
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const buf = Buffer.from(normalized, "hex");
  const out = decryptEnrollmentMetadata(buf);
  console.log(JSON.stringify(out, null, 2));
}

main();
