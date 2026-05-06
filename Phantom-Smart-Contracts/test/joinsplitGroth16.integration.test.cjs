const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  merkleProofForFirstLeaf,
  totalJoinSplitFeeBnb,
} = require("./helpers/poolFixtures.cjs");
const {
  proveJoinSplitPublic9FromPublicInputs,
  deployPoolWithRealJoinSplitVerifier,
} = require("./helpers/joinsplitGroth16.cjs");
const { computeCommitment, computeNullifier } = require(path.join(
  __dirname,
  "..",
  "..",
  "phantom-relayer-dashboard",
  "backend",
  "src",
  "noteModel.js"
));
const { mimc7 } = require(path.join(
  __dirname,
  "..",
  "..",
  "phantom-relayer-dashboard",
  "backend",
  "src",
  "mimc7.js"
));

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

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

function randField() {
  while (true) {
    const x = BigInt(ethers.hexlify(ethers.randomBytes(32))) % FIELD;
    if (x > 0n) return x;
  }
}

function commitmentToBytes32(commitmentBn) {
  const h = BigInt(commitmentBn) % FIELD;
  return ethers.toBeHex(h, 32);
}

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
  const domain = {
    name: "PhantomRelayerAttestation",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: await pool.getAddress(),
  };
  return signer.signTypedData(domain, RELAYER_SWAP_ATTESTATION_TYPES, {
    proofHash,
    publicInputHash,
    relayer: signer.address,
    pool: await pool.getAddress(),
    chainId: BigInt(network.chainId),
    deadline,
    nonce,
  });
}

async function buildValidSwapPublicInputsAsync(feeOracle, inputAmount, swapAmount, gasRefund = 0n, outputAssetIDSwap = 1n) {
  const inputAssetID = 0n;
  const inputBlindingFactor = randField();
  const ownerPublicKey = randField();
  const swapBlindingFactor = randField();
  const changeBlindingFactor = randField();

  const inputCommitmentBn = computeCommitment(inputAssetID, inputAmount, inputBlindingFactor, ownerPublicKey);
  const nullifierBn = computeNullifier(inputCommitmentBn, ownerPublicKey);

  const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
  const changeAmount = inputAmount - swapAmount - totalPf - gasRefund;

  const outSwapBn = computeCommitment(outputAssetIDSwap, swapAmount, swapBlindingFactor, ownerPublicKey);
  const outChangeBn = computeCommitment(inputAssetID, changeAmount, changeBlindingFactor, ownerPublicKey);

  return {
    nullifier: commitmentToBytes32(nullifierBn),
    inputCommitment: commitmentToBytes32(inputCommitmentBn),
    outputCommitmentSwap: commitmentToBytes32(outSwapBn),
    outputCommitmentChange: commitmentToBytes32(outChangeBn),
    inputAssetID,
    outputAssetIDSwap,
    outputAssetIDChange: inputAssetID,
    inputAmount,
    swapAmount,
    changeAmount,
    outputAmountSwap: swapAmount,
    outputAmountSwapNote: swapAmount,
    minOutputAmountSwap: swapAmount,
    gasRefund,
    protocolFee: totalPf,
    inputBlindingFactor,
    ownerPublicKey,
    swapBlindingFactor,
    changeBlindingFactor,
    withdrawMode: "0",
  };
}

describe("Join-split Groth16 (real verifier)", function () {
  it("shieldedSwapJoinSplit succeeds with snarkjs-produced proof", async function () {
    const { deployer, pool, feeOracle } = await deployPoolWithRealJoinSplitVerifier();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await outTok.getAddress();
    await pool.connect(deployer).registerAsset(1n, outAddr);

    const inputAmount = ethers.parseEther("25");
    const swapAmount = ethers.parseEther("5");

    const base = await buildValidSwapPublicInputsAsync(feeOracle, inputAmount, swapAmount);
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, base.inputCommitment, 0n, {
      value: inputAmount,
    });

    const { root, path, indices } = await merkleProofForFirstLeaf(base.inputCommitment);
    const publicInputs = {
      ...base,
      merkleRoot: root,
      merklePath: path,
      merklePathIndices: indices,
    };

    const { poolProof } = await proveJoinSplitPublic9FromPublicInputs(publicInputs);
    const attestationNonce = 1n;
    const attestationDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const relayerAttestationSig = await buildHashFirstRelayerAttestation({
      signer: deployer,
      pool,
      proof: poolProof,
      publicInputs,
      nonce: attestationNonce,
      deadline: attestationDeadline,
    });

    const swapData = {
      proof: poolProof,
      publicInputs,
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: outAddr,
        amountIn: swapAmount,
        minAmountOut: swapAmount,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: ethers.ZeroAddress,
      commitment: ethers.ZeroHash,
      deadline: 0n,
      nonce: 0n,
      encryptedPayload: "0x",
      relayerAttestationSig,
      relayerAttestationDeadline: attestationDeadline,
      relayerAttestationNonce: attestationNonce,
      proofContextHash: ethers.ZeroHash,
    };

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.emit(pool, "ShieldedSwapJoinSplit");
    expect(await pool.nullifiers(publicInputs.nullifier)).to.equal(true);
  });

  it("reverts with PoolErr(6) when Groth16 proof is tampered", async function () {
    const { deployer, pool, feeOracle } = await deployPoolWithRealJoinSplitVerifier();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out2", "O2", 18);
    await outTok.waitForDeployment();
    await pool.connect(deployer).registerAsset(1n, await outTok.getAddress());

    const inputAmount = ethers.parseEther("25");
    const swapAmount = ethers.parseEther("5");

    const base = await buildValidSwapPublicInputsAsync(feeOracle, inputAmount, swapAmount);
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, base.inputCommitment, 0n, {
      value: inputAmount,
    });

    const { root, path, indices } = await merkleProofForFirstLeaf(base.inputCommitment);
    const publicInputs = {
      ...base,
      merkleRoot: root,
      merklePath: path,
      merklePathIndices: indices,
    };

    const { poolProof } = await proveJoinSplitPublic9FromPublicInputs(publicInputs);
    const cBytes = ethers.getBytes(poolProof.c);
    cBytes[cBytes.length - 1] ^= 1;
    const tamperedC = ethers.hexlify(cBytes);
    const tamperedProof = { ...poolProof, c: tamperedC };
    const attestationNonce = 2n;
    const attestationDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const relayerAttestationSig = await buildHashFirstRelayerAttestation({
      signer: deployer,
      pool,
      proof: tamperedProof,
      publicInputs,
      nonce: attestationNonce,
      deadline: attestationDeadline,
    });

    const swapData = {
      proof: tamperedProof,
      publicInputs,
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: await outTok.getAddress(),
        amountIn: swapAmount,
        minAmountOut: swapAmount,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: ethers.ZeroAddress,
      commitment: ethers.ZeroHash,
      deadline: 0n,
      nonce: 0n,
      encryptedPayload: "0x",
      relayerAttestationSig,
      relayerAttestationDeadline: attestationDeadline,
      relayerAttestationNonce: attestationNonce,
      proofContextHash: ethers.ZeroHash,
    };

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData))
      .to.be.revertedWithCustomError(pool, "PoolErr")
      .withArgs(6);
  });
});
