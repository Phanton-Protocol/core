// Phase 5 — Frontend helper for signing the two EIP-712 typed data structures
// used by the internal matching pipeline:
//   1. InternalOrderIntent (relayer-side routing intent)
//   2. InternalMatchIntent (user-binding intent re-verified on-chain by
//      `_verifyInternalMatchUserIntent` in ShieldedPool)
//
// The schemas, domain names and ciphertext-hash canonicalisation here MUST
// stay byte-identical to:
//   - core/phantom-relayer-dashboard/backend/src/internalOrderRoutes.js
//   - core/Phantom-Smart-Contracts/contracts/_full/core/ShieldedPool.sol
// (Phase 1 contract / Phase 2 backend). Any change must be mirrored on both
// sides or signatures will fail to verify.

import { ethers } from "ethers";

export const INTERNAL_ORDER_TYPES = {
  InternalOrderIntent: [
    { name: "owner", type: "address" },
    { name: "signingKey", type: "address" },
    { name: "baseAsset", type: "string" },
    { name: "quoteAsset", type: "string" },
    { name: "side", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "replayKey", type: "bytes32" },
  ],
};

export const INTERNAL_MATCH_INTENT_TYPES = {
  InternalMatchIntent: [
    { name: "user", type: "address" },
    { name: "side", type: "uint8" },
    { name: "inputAssetID", type: "uint256" },
    { name: "outputAssetID", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "ciphertextHash", type: "bytes32" },
  ],
};

export const OPERATOR_DOMAIN_NAME = "PhantomInternalOrder";
export const OPERATOR_DOMAIN_VERSION = "1";
export const MATCH_INTENT_DOMAIN_NAME = "PhantomInternalMatchIntent";
export const MATCH_INTENT_DOMAIN_VERSION = "1";

export const INTERNAL_CANCEL_TYPES = {
  InternalOrderCancel: [
    { name: "orderId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "reason", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function computeCiphertextHash(ciphertext) {
  if (ciphertext == null) return null;
  if (typeof ciphertext === "string") {
    return ethers.keccak256(ethers.toUtf8Bytes(ciphertext));
  }
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(ciphertext)));
}

export function buildOperatorDomain({ chainId, verifyingContract }) {
  return {
    name: OPERATOR_DOMAIN_NAME,
    version: OPERATOR_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: verifyingContract || ethers.ZeroAddress,
  };
}

export function buildMatchIntentDomain({ chainId, verifyingContract }) {
  return {
    name: MATCH_INTENT_DOMAIN_NAME,
    version: MATCH_INTENT_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: verifyingContract || ethers.ZeroAddress,
  };
}

function asBigIntStr(v) {
  return BigInt(String(v)).toString();
}

export async function signOperatorIntent({ signer, params, chainId, verifyingContract }) {
  const intent = {
    owner: ethers.getAddress(params.owner),
    signingKey: ethers.getAddress(params.signingKey || params.owner),
    baseAsset: String(params.baseAsset),
    quoteAsset: String(params.quoteAsset),
    side: String(params.side),
    amount: asBigIntStr(params.amount),
    limitPrice: asBigIntStr(params.limitPrice),
    expiry: asBigIntStr(params.expiry),
    nonce: asBigIntStr(params.nonce),
    replayKey: ethers.hexlify(params.replayKey).toLowerCase(),
  };
  const typed = {
    owner: intent.owner,
    signingKey: intent.signingKey,
    baseAsset: intent.baseAsset,
    quoteAsset: intent.quoteAsset,
    side: intent.side,
    amount: BigInt(intent.amount),
    limitPrice: BigInt(intent.limitPrice),
    expiry: BigInt(intent.expiry),
    nonce: BigInt(intent.nonce),
    replayKey: intent.replayKey,
  };
  const signature = await signer.signTypedData(
    buildOperatorDomain({ chainId, verifyingContract }),
    INTERNAL_ORDER_TYPES,
    typed
  );
  return { intent, signature };
}

export async function signInternalMatchIntent({ signer, params, chainId, verifyingContract }) {
  const matchIntent = {
    user: ethers.getAddress(params.user),
    side: Number(params.side),
    inputAssetID: asBigIntStr(params.inputAssetID),
    outputAssetID: asBigIntStr(params.outputAssetID),
    amount: asBigIntStr(params.amount),
    limitPrice: asBigIntStr(params.limitPrice),
    nonce: asBigIntStr(params.nonce),
    deadline: asBigIntStr(params.deadline),
    ciphertextHash: ethers.hexlify(params.ciphertextHash).toLowerCase(),
  };
  const typed = {
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
  const signature = await signer.signTypedData(
    buildMatchIntentDomain({ chainId, verifyingContract }),
    INTERNAL_MATCH_INTENT_TYPES,
    typed
  );
  return { matchIntent, matchSignature: signature };
}

function deriveReplayKey(owner, nonce) {
  const seed = `${owner}:${nonce}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return ethers.keccak256(ethers.toUtf8Bytes(seed));
}

/**
 * Build the request body for `POST /intent/internal/cancel`.
 * Signs an `InternalOrderCancel` EIP-712 typed-data so the backend can verify
 * the cancel was authorized by the order owner.
 */
export async function signCancel({
  signer,
  chainId,
  verifyingContract,
  orderId,
  reason = "user_cancel",
  deadlineSec,
}) {
  if (!signer || typeof signer.signTypedData !== "function") {
    throw new Error("wallet_signer_required");
  }
  const owner = ethers.getAddress(await signer.getAddress());
  const deadline = Math.max(
    Math.floor(Date.now() / 1000) + 600,
    Number(deadlineSec) || 0
  );
  const nonce = Date.now();
  const cancel = {
    owner,
    reason: String(reason).slice(0, 280),
    nonce: String(nonce),
    deadline: String(deadline),
  };
  const typed = {
    orderId,
    owner: cancel.owner,
    reason: cancel.reason,
    nonce: BigInt(cancel.nonce),
    deadline: BigInt(cancel.deadline),
  };
  const signature = await signer.signTypedData(
    buildOperatorDomain({ chainId, verifyingContract }),
    INTERNAL_CANCEL_TYPES,
    typed
  );
  return { orderId, cancel, signature };
}

/**
 * Builds the full request body expected by `POST /intent/internal`.
 *
 * The caller is responsible for providing the FHE ciphertext (bundle returned
 * by `POST /fhe/encrypt`); this helper computes its canonical hash and binds
 * it into the EIP-712 InternalMatchIntent signature.
 */
export async function buildInternalIntentRequest({
  signer,
  chainId,
  verifyingContract,
  side,
  baseAsset,
  quoteAsset,
  inputAssetID,
  outputAssetID,
  amount,
  limitPrice,
  expirySec,
  operatorNonce,
  matchNonce,
  ciphertext,
  replayKey,
}) {
  if (!signer || typeof signer.signTypedData !== "function") {
    throw new Error("wallet_signer_required");
  }
  if (ciphertext == null) {
    throw new Error("ciphertext_required");
  }
  const owner = ethers.getAddress(await signer.getAddress());
  const ciphertextHash = computeCiphertextHash(ciphertext);
  if (!ciphertextHash) throw new Error("ciphertext_hash_failed");
  const opReplayKey = replayKey || deriveReplayKey(owner, operatorNonce);

  const { intent, signature } = await signOperatorIntent({
    signer,
    chainId,
    verifyingContract,
    params: {
      owner,
      signingKey: owner,
      baseAsset,
      quoteAsset,
      side,
      amount,
      limitPrice,
      expiry: expirySec,
      nonce: operatorNonce,
      replayKey: opReplayKey,
    },
  });

  const { matchIntent, matchSignature } = await signInternalMatchIntent({
    signer,
    chainId,
    verifyingContract,
    params: {
      user: owner,
      side: side === "sell" ? 0 : 1,
      inputAssetID,
      outputAssetID,
      amount,
      limitPrice,
      nonce: matchNonce,
      deadline: expirySec,
      ciphertextHash,
    },
  });

  return { intent, signature, matchIntent, matchSignature, ciphertext };
}
