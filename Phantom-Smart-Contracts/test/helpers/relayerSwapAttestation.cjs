/**
 * EIP-712 "hash-first" relayer attestation for JoinSplitSwapData — matches
 * InternalMatchIntentLib / ShieldedPool._computeRelayerPublicInputHash.
 */
const path = require("path");
const { ethers } = require("hardhat");

const { mimc7 } = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "phantom-relayer-dashboard",
  "backend",
  "src",
  "mimc7.js"
));

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const RELAYER_SWAP_ATTESTATION_TYPES = {
  RelayerSwapAttestationHashFirst: [
    { name: "proofHash", type: "bytes32" },
    { name: "publicInputHash", type: "bytes32" },
    { name: "relayer", type: "address" },
    { name: "pool", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

function computeRoutingCommitmentFromPublicInputs(pi) {
  const withdrawMode = BigInt(pi.outputCommitmentSwap) === 0n ? 1n : 0n;
  const r0 = mimc7(pi.inputAssetID, pi.outputAssetIDSwap);
  const r1 = mimc7(r0, pi.outputAssetIDChange);
  const r2 = mimc7(r1, pi.inputAmount);
  const r3 = mimc7(r2, pi.swapAmount);
  const r4 = mimc7(r3, pi.changeAmount);
  const r5 = mimc7(r4, pi.outputAmountSwap);
  const r6 = mimc7(r5, pi.minOutputAmountSwap);
  const r7 = mimc7(r6, pi.protocolFee);
  const r8 = mimc7(r7, pi.gasRefund);
  return mimc7(r8, withdrawMode);
}

/** Placeholder fields so ethers can encode JoinSplitSwapData (Reduced pool ignores them). */
function joinSplitSwapDataDummyAttestation() {
  return {
    relayerAttestationSig: "0x",
    relayerAttestationDeadline: (1n << 64n) - 1n,
    relayerAttestationNonce: 0n,
    proofContextHash: ethers.ZeroHash,
  };
}

async function buildHashFirstRelayerAttestation({ signer, pool, proof, publicInputs, nonce, deadline }) {
  const proofHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], [proof.a, proof.b, proof.c])
  );
  const publicInputHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        publicInputs.nullifier,
        publicInputs.inputCommitment,
        publicInputs.outputCommitmentSwap,
        publicInputs.outputCommitmentChange,
        publicInputs.merkleRoot,
        computeRoutingCommitmentFromPublicInputs(publicInputs),
      ]
    )
  );
  const network = await ethers.provider.getNetwork();
  const poolAddr = typeof pool === "string" ? pool : await pool.getAddress();
  const domain = {
    name: "PhantomRelayerAttestation",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: poolAddr,
  };
  return signer.signTypedData(domain, RELAYER_SWAP_ATTESTATION_TYPES, {
    proofHash,
    publicInputHash,
    relayer: signer.address,
    pool: poolAddr,
    chainId: BigInt(network.chainId),
    deadline,
    nonce,
  });
}

/**
 * Add real relayer attestation (caller must be `signer` when relayer is zero address).
 */
async function attachJoinSplitRelayerAttestation(signer, pool, swapData, nonce = 1n) {
  const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 7200);
  const relayerAttestationSig = await buildHashFirstRelayerAttestation({
    signer,
    pool,
    proof: swapData.proof,
    publicInputs: swapData.publicInputs,
    nonce,
    deadline,
  });
  return {
    ...swapData,
    relayerAttestationSig,
    relayerAttestationDeadline: deadline,
    relayerAttestationNonce: nonce,
    proofContextHash: ethers.ZeroHash,
  };
}

module.exports = {
  FIELD,
  RELAYER_SWAP_ATTESTATION_TYPES,
  computeRoutingCommitmentFromPublicInputs,
  joinSplitSwapDataDummyAttestation,
  buildHashFirstRelayerAttestation,
  attachJoinSplitRelayerAttestation,
};
