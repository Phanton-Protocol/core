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
const { FIELD, buildHashFirstRelayerAttestation } = require("./helpers/relayerSwapAttestation.cjs");

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

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
