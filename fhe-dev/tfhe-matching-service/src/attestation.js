"use strict";

/**
 * attestation.js — ECDSA signer scaffold for the FHE service.
 *
 * The matching service signs `decisionHash = keccak256(stableStringify(canonical))`
 * with a secp256k1 key. The on-chain settlement contract (post-M3) and the
 * relayer backend (post-M4) verify this signature against
 * `EXPECTED_FHE_ATTESTATION_SIGNER`. The signer is loaded from
 * `MATCHING_SERVICE_PRIVATE_KEY` env (32-byte hex). Default `0x11..11` is
 * dev-only.
 */

const { ethers } = require("ethers");

function loadSigner(privateKeyEnv) {
  const pk = String(privateKeyEnv || "").trim();
  if (!pk) throw new Error("MATCHING_SERVICE_PRIVATE_KEY missing");
  const wallet = new ethers.Wallet(pk);
  const signingKey = new ethers.SigningKey(wallet.privateKey);
  return {
    address: wallet.address,
    signDigest(digestHex) {
      const sig = signingKey.sign(digestHex);
      return ethers.Signature.from(sig).serialized;
    },
  };
}

module.exports = { loadSigner };
