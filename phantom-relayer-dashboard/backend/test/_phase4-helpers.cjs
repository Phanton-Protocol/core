const { decryptJsonAtRest } = require("../src/noteCipher");

function safeDecrypt(order) {
  try {
    if (!order?.encryptedPayload) return null;
    return decryptJsonAtRest(order.encryptedPayload);
  } catch {
    return null;
  }
}

function extractMatchIntentBundleForTest(order) {
  const normalized = order?.normalizedPayload || {};
  const intent = normalized?.matchIntent?.intent || null;
  if (!intent) return null;
  const env = safeDecrypt(order) || {};
  const ciphertext = env?.matchIntent?.ciphertext ?? null;
  const signature = env?.matchIntent?.signature ?? normalized?.matchIntent?.signature ?? null;
  if (!ciphertext || !signature) return null;
  return { intent, ciphertext, signature };
}

module.exports = { extractMatchIntentBundleForTest };
