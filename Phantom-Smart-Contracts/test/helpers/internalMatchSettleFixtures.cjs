/**
 * Shared EIP-712 + settlement-data builders for the two `internalMatchSettle`
 * test files:
 *   - test/internalMatchSettle.integration.test.cjs  (legacy ShieldedPool)
 *   - test/internalMatchSettle.reduced.test.cjs      (UUPS-upgraded Reduced pool, M3)
 *
 * Keeping the canonical fixture in one place means the legacy and the
 * upgraded-Reduced settlement paths are exercised against **byte-identical**
 * inputs — required by the M3 acceptance criterion "asserts upgraded Reduced
 * settles a happy-path internal match identically to the legacy ShieldedPool".
 */
const { ethers } = require("hardhat");

function decisionHashFromArtifact(artifact) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    [
      "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256",
      "bool", "bool", "bool", "uint256", "uint256", "bytes32",
    ],
    [
      artifact.makerOrderId,
      artifact.takerOrderId,
      artifact.makerInputCommitment,
      artifact.takerInputCommitment,
      artifact.makerInputAssetID,
      artifact.takerInputAssetID,
      artifact.executionPrice,
      artifact.quantity,
      artifact.makerIsSell,
      artifact.takerIsBuy,
      artifact.approved,
      artifact.decidedAt,
      artifact.decisionNonce,
      artifact.signerSetHash,
    ]
  );
  return ethers.keccak256(encoded);
}

async function signInternalMatchAttestation({
  signer,
  poolAddress,
  chainId,
  decisionHash,
  matchHash,
  executionKey,
  relayer,
  signerSetHash,
  deadline,
  nonce,
}) {
  const domain = {
    name: "PhantomInternalMatchAttestation",
    version: "1",
    chainId,
    verifyingContract: poolAddress,
  };
  const types = {
    InternalMatchAttestation: [
      { name: "decisionHash", type: "bytes32" },
      { name: "matchHash", type: "bytes32" },
      { name: "executionKey", type: "bytes32" },
      { name: "relayer", type: "address" },
      { name: "signerSetHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, {
    decisionHash,
    matchHash,
    executionKey,
    relayer,
    signerSetHash,
    deadline,
    nonce,
  });
}

async function signInternalMatchIntent({ signer, poolAddress, chainId, intent }) {
  const domain = {
    name: "PhantomInternalMatchIntent",
    version: "1",
    chainId,
    verifyingContract: poolAddress,
  };
  const types = {
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
  return signer.signTypedData(domain, types, intent);
}

function computeProofContextHash({ decisionHash, matchHash, executionKey, publicInputs }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
      ],
      [
        ethers.id("PHANTOM_INTERNAL_MATCH_PROOF_CONTEXT_V1"),
        decisionHash,
        matchHash,
        executionKey,
        publicInputs.nullifier,
        publicInputs.inputCommitment,
        publicInputs.outputCommitmentSwap,
        publicInputs.outputCommitmentChange,
        publicInputs.inputAssetID,
        publicInputs.outputAssetIDSwap,
        publicInputs.outputAssetIDChange,
        publicInputs.swapAmount,
      ]
    )
  );
}

/**
 * Build a fully-signed `InternalMatchSettlementData` ready to submit to
 * `internalMatchSettle` on either ShieldedPool or ShieldedPoolUpgradeableReduced.
 * EIP-712 signatures are bound to the pool address that is passed in.
 */
async function buildSettlementData({ pool, deployer, overrides = {} }) {
  const network = await ethers.provider.getNetwork();
  const relayer = deployer.address;
  const makerWallet = overrides.makerWallet || ethers.Wallet.createRandom();
  const takerWallet = overrides.takerWallet || ethers.Wallet.createRandom();
  const matchHash = overrides.matchHash || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-match"));
  const executionKey = overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-exec"));
  const makerOrderId = overrides.makerOrderId || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-maker"));
  const takerOrderId = overrides.takerOrderId || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-taker"));
  const makerInputCommitment = overrides.makerInputCommitment || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-maker-in"));
  const takerInputCommitment = overrides.takerInputCommitment || ethers.keccak256(ethers.toUtf8Bytes("m3-reduced-taker-in"));
  const signerSetHash = overrides.signerSetHash || ethers.keccak256(ethers.solidityPacked(["address"], [relayer]));
  const artifact = {
    makerOrderId,
    takerOrderId,
    makerInputCommitment,
    takerInputCommitment,
    makerInputAssetID: overrides.makerInputAssetID ?? 1n,
    takerInputAssetID: overrides.takerInputAssetID ?? 0n,
    executionPrice: overrides.executionPrice ?? 10n,
    quantity: overrides.quantity ?? 100n,
    makerIsSell: overrides.makerIsSell ?? true,
    takerIsBuy: overrides.takerIsBuy ?? true,
    approved: overrides.approved ?? true,
    decidedAt: overrides.decidedAt ?? BigInt(Math.floor(Date.now() / 1000)),
    decisionNonce: overrides.decisionNonce ?? 9n,
    signerSetHash,
  };
  const decisionHash = overrides.decisionHash || decisionHashFromArtifact(artifact);
  const attestationDeadline = overrides.attestationDeadline ?? BigInt(Math.floor(Date.now() / 1000) + 900);
  const attestationNonce = overrides.attestationNonce ?? 33n;
  const attestationSig = overrides.attestationSig || await signInternalMatchAttestation({
    signer: deployer,
    poolAddress: await pool.getAddress(),
    chainId: Number(network.chainId),
    decisionHash,
    matchHash,
    executionKey,
    relayer,
    signerSetHash,
    deadline: attestationDeadline,
    nonce: attestationNonce,
  });
  const blankLeg = {
    proof: { a: "0x", b: "0x", c: "0x" },
    publicInputs: {
      nullifier: ethers.ZeroHash,
      inputCommitment: takerInputCommitment,
      outputCommitmentSwap: ethers.ZeroHash,
      outputCommitmentChange: ethers.ZeroHash,
      merkleRoot: ethers.ZeroHash,
      inputAssetID: 0,
      outputAssetIDSwap: 1,
      outputAssetIDChange: 0,
      inputAmount: 100,
      swapAmount: 100,
      changeAmount: 0,
      outputAmountSwap: 100,
      minOutputAmountSwap: 100,
      gasRefund: 0,
      protocolFee: 0,
      merklePath: Array(10).fill(0),
      merklePathIndices: Array(10).fill(0),
    },
    swapParams: {
      tokenIn: ethers.ZeroAddress,
      tokenOut: relayer,
      amountIn: 0,
      minAmountOut: 0,
      fee: 3000,
      sqrtPriceLimitX96: 0,
      path: "0x",
    },
    relayer,
    encryptedPayload: "0x",
    commitment: ethers.ZeroHash,
    deadline: Number(attestationDeadline),
    nonce: Number(attestationNonce),
    relayerAttestationSig: "0x",
    relayerAttestationDeadline: Number(attestationDeadline),
    relayerAttestationNonce: Number(attestationNonce),
  };
  const makerLeg = {
    ...blankLeg,
    publicInputs: {
      ...blankLeg.publicInputs,
      inputCommitment: makerInputCommitment,
      inputAssetID: Number(artifact.makerInputAssetID),
      swapAmount: Number(artifact.quantity),
    },
    nonce: Number(attestationNonce) + 1,
    relayerAttestationNonce: Number(attestationNonce) + 1,
  };
  const takerLeg = {
    ...blankLeg,
    publicInputs: {
      ...blankLeg.publicInputs,
      inputCommitment: takerInputCommitment,
      inputAssetID: Number(artifact.takerInputAssetID),
      swapAmount: Number(artifact.quantity),
    },
  };
  takerLeg.proofContextHash = computeProofContextHash({
    decisionHash,
    matchHash,
    executionKey,
    publicInputs: takerLeg.publicInputs,
  });
  makerLeg.proofContextHash = computeProofContextHash({
    decisionHash,
    matchHash,
    executionKey,
    publicInputs: makerLeg.publicInputs,
  });
  const intentDeadline = overrides.intentDeadline ?? attestationDeadline;
  const ciphertextHash = overrides.ciphertextHash ?? ethers.keccak256(ethers.toUtf8Bytes("ct-bundle"));
  const makerIntent = {
    user: makerWallet.address,
    side: 0,
    inputAssetID: artifact.makerInputAssetID,
    outputAssetID: artifact.takerInputAssetID,
    amount: artifact.quantity,
    limitPrice: overrides.makerLimitPrice ?? artifact.executionPrice,
    nonce: overrides.makerIntentNonce ?? 1001n,
    deadline: intentDeadline,
    ciphertextHash,
  };
  const takerIntent = {
    user: takerWallet.address,
    side: 1,
    inputAssetID: artifact.takerInputAssetID,
    outputAssetID: artifact.makerInputAssetID,
    amount: artifact.quantity,
    limitPrice: overrides.takerLimitPrice ?? artifact.executionPrice,
    nonce: overrides.takerIntentNonce ?? 2002n,
    deadline: intentDeadline,
    ciphertextHash,
  };
  const makerSig = overrides.makerIntentSig || await signInternalMatchIntent({
    signer: makerWallet,
    poolAddress: await pool.getAddress(),
    chainId: Number(network.chainId),
    intent: makerIntent,
  });
  const takerSig = overrides.takerIntentSig || await signInternalMatchIntent({
    signer: takerWallet,
    poolAddress: await pool.getAddress(),
    chainId: Number(network.chainId),
    intent: takerIntent,
  });
  return {
    takerSwapData: takerLeg,
    makerSwapData: makerLeg,
    matchHash,
    executionKey,
    decisionHash,
    artifact,
    attestationSig,
    attestationDeadline,
    attestationNonce,
    makerSignedIntent: { intent: makerIntent, signature: makerSig },
    takerSignedIntent: { intent: takerIntent, signature: takerSig },
  };
}

module.exports = {
  decisionHashFromArtifact,
  signInternalMatchAttestation,
  signInternalMatchIntent,
  computeProofContextHash,
  buildSettlementData,
};
