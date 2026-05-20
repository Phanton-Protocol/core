const crypto = require("crypto");

function getOwnerDecryptKey() {
  const raw = (process.env.PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX || "").trim();
  if (!raw) {
    throw new Error(
      "Owner decrypt key missing. Set PHANTOM_PROTOCOL_OWNER_DECRYPT_KEY_HEX (32-byte hex)."
    );
  }
  const normalized = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Invalid owner decrypt key. Expected 32-byte hex (64 chars).");
  }
  return Buffer.from(normalized, "hex");
}

function encryptEnrollmentMetadata(obj) {
  const key = getOwnerDecryptKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decryptEnrollmentMetadata(buf) {
  const key = getOwnerDecryptKey();
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 28) throw new Error("encrypted enrollment payload too short");
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct = b.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

module.exports = {
  getOwnerDecryptKey,
  encryptEnrollmentMetadata,
  decryptEnrollmentMetadata,
};
