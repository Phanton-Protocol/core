const { expect } = require("chai");
const { ethers } = require("hardhat");

async function deployPoolWithConfigurableVerifier() {
  const [deployer] = await ethers.getSigners();
  const ConfigurableVerifier = await ethers.getContractFactory("ConfigurableMockVerifier");
  const verifier = await ConfigurableVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
  const swapAdaptor = await MockSwapAdaptor.deploy();
  await swapAdaptor.waitForDeployment();

  const FeeOracle = await ethers.getContractFactory("MockFeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const ShieldedPool = await ethers.getContractFactory("ShieldedPool");
  const pool = await ShieldedPool.deploy(
    verifierAddr,
    verifierAddr,
    verifierAddr,
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await pool.waitForDeployment();
  return { deployer, pool };
}

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

async function buildSettlementData({ pool, deployer, overrides = {} }) {
  const network = await ethers.provider.getNetwork();
  const relayer = deployer.address;
  const matchHash = overrides.matchHash || ethers.keccak256(ethers.toUtf8Bytes("m6-match"));
  const executionKey = overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes("m6-exec"));
  const makerOrderId = overrides.makerOrderId || ethers.keccak256(ethers.toUtf8Bytes("m6-maker"));
  const takerOrderId = overrides.takerOrderId || ethers.keccak256(ethers.toUtf8Bytes("m6-taker"));
  const makerInputCommitment = overrides.makerInputCommitment || ethers.keccak256(ethers.toUtf8Bytes("m6-maker-in"));
  const takerInputCommitment = overrides.takerInputCommitment || ethers.keccak256(ethers.toUtf8Bytes("m6-taker-in"));
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
  };
}

describe("ShieldedPool.internalMatchSettle (Module 6)", function () {
  it("accepts valid internal settlement artifact and emits traceable event", async function () {
    const { pool, deployer } = await deployPoolWithConfigurableVerifier();
    const data = await buildSettlementData({ pool, deployer });
    await expect(pool.internalMatchSettle(data))
      .to.emit(pool, "InternalMatchSettled")
      .withArgs(data.matchHash, data.decisionHash, data.executionKey, data.artifact.makerOrderId, data.artifact.takerOrderId, deployer.address);
  });

  it("rejects bad signature/attestation", async function () {
    const { pool, deployer } = await deployPoolWithConfigurableVerifier();
    const attacker = ethers.Wallet.createRandom().connect(ethers.provider);
    const data = await buildSettlementData({ pool, deployer, overrides: { attestationSig: await attacker.signMessage("bad") } });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(51);
  });

  it("rejects stale deadline", async function () {
    const { pool, deployer } = await deployPoolWithConfigurableVerifier();
    const data = await buildSettlementData({
      pool,
      deployer,
      overrides: { attestationDeadline: 1n },
    });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(54);
  });

  it("rejects replayed matchHash", async function () {
    const { pool, deployer } = await deployPoolWithConfigurableVerifier();
    const first = await buildSettlementData({ pool, deployer });
    await pool.internalMatchSettle(first);
    const second = await buildSettlementData({
      pool,
      deployer,
      overrides: {
        matchHash: first.matchHash,
        decisionNonce: 77n,
      },
    });
    await expect(pool.internalMatchSettle(second)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(52);
  });

  it("rejects tampered decisionHash", async function () {
    const { pool, deployer } = await deployPoolWithConfigurableVerifier();
    const data = await buildSettlementData({
      pool,
      deployer,
      overrides: { decisionHash: "0x" + "ff".repeat(32) },
    });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(56);
  });
});
