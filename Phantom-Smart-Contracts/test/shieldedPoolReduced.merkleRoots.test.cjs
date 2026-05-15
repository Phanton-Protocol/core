const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { merkleProofForFirstLeaf, totalJoinSplitFeeBnb } = require("./helpers/poolFixtures.cjs");
const { proveJoinSplitPublic9FromPublicInputs } = require("./helpers/joinsplitGroth16.cjs");
const { joinSplitSwapDataDummyAttestation } = require("./helpers/relayerSwapAttestation.cjs");
const { computeCommitment, computeNullifier } = require(path.join(
  __dirname,
  "..",
  "..",
  "phantom-relayer-dashboard",
  "backend",
  "src",
  "noteModel.js"
));
const { deployBehindProxy } = require("./helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
} = require("./helpers/reducedProduction.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function randField() {
  while (true) {
    const x = BigInt(ethers.hexlify(ethers.randomBytes(32))) % FIELD;
    if (x > 0n) return x;
  }
}

function commitmentToBytes32(commitmentBn) {
  return ethers.toBeHex(BigInt(commitmentBn) % FIELD, 32);
}

async function deployReducedPoolWithJoinSplitVerifier() {
  const [deployer] = await ethers.getSigners();
  const FQN = "contracts/_full/verifiers/JoinSplitVerifier.sol:Groth16Verifier";
  const Groth16 = await ethers.getContractFactory(FQN);
  const groth16 = await Groth16.deploy();
  await groth16.waitForDeployment();
  const joinAddr = await groth16.getAddress();

  const Adapter = await ethers.getContractFactory("Groth16VerifierAdapter");
  const joinAdapter = await Adapter.deploy(joinAddr);
  await joinAdapter.waitForDeployment();

  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const threshold = await MockVerifier.deploy();
  await threshold.waitForDeployment();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
  const swapAdaptor = await MockSwapAdaptor.deploy();
  await swapAdaptor.waitForDeployment();

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  await initFeeOracleForTests(feeOracle, deployer);

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await joinAdapter.getAddress(),
    await threshold.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);

  return { deployer, pool, feeOracle };
}

async function buildSwapPublicInputs(feeOracle, inputAmount, swapAmount, inputCommitmentHex, noteFields) {
  const inputCommitmentBn = BigInt(inputCommitmentHex);
  const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
  const changeAmount = inputAmount - swapAmount - totalPf;
  const outSwapBn = computeCommitment(1n, swapAmount, noteFields.swapBlindingFactor, noteFields.ownerPublicKey);
  const outChangeBn = computeCommitment(0n, changeAmount, noteFields.changeBlindingFactor, noteFields.ownerPublicKey);
  const nullifierBn = computeNullifier(inputCommitmentBn, noteFields.ownerPublicKey);
  return {
    nullifier: commitmentToBytes32(nullifierBn),
    inputCommitment: inputCommitmentHex,
    outputCommitmentSwap: commitmentToBytes32(outSwapBn),
    outputCommitmentChange: commitmentToBytes32(outChangeBn),
    inputAssetID: 0n,
    outputAssetIDSwap: 1n,
    outputAssetIDChange: 0n,
    inputAmount,
    swapAmount,
    changeAmount,
    outputAmountSwap: swapAmount,
    outputAmountSwapNote: swapAmount,
    minOutputAmountSwap: swapAmount,
    gasRefund: 0n,
    protocolFee: totalPf,
    inputBlindingFactor: noteFields.inputBlindingFactor,
    ownerPublicKey: noteFields.ownerPublicKey,
    swapBlindingFactor: noteFields.swapBlindingFactor,
    changeBlindingFactor: noteFields.changeBlindingFactor,
    withdrawMode: "0",
  };
}

describe("ShieldedPoolUpgradeableReduced — Merkle root spend policy", function () {
  it("checkpoints genesis + each deposit root and rejects unknown spend root", async function () {
    const { deployer, pool } = await deployReducedPoolWithJoinSplitVerifier();
    const r0 = await pool.merkleRoot();
    expect(await pool.validMerkleRoots(r0)).to.equal(true);

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("reduced-merkle-d1"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("1"), c1, 0n, {
      value: ethers.parseEther("1"),
    });
    const r1 = await pool.merkleRoot();
    expect(await pool.validMerkleRoots(r1)).to.equal(true);

    const c2 = ethers.keccak256(ethers.toUtf8Bytes("reduced-merkle-d2"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("1"), c2, 0n, {
      value: ethers.parseEther("1"),
    });
    const r2 = await pool.merkleRoot();
    expect(await pool.validMerkleRoots(r2)).to.equal(true);
    expect(r2).to.not.equal(r1);

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);

    const badRoot = ethers.keccak256(ethers.toUtf8Bytes("never-checkpointed-root"));
    expect(await pool.validMerkleRoots(badRoot)).to.equal(false);

    const joinSplitStub = await buildReducedJoinSplitTx(
      pool,
      deployer,
      {
        nullifier: ethers.ZeroHash,
        inputCommitment: c1,
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: ethers.ZeroHash,
        merkleRoot: badRoot,
        inputAssetID: 0n,
        outputAssetIDSwap: 1n,
        outputAssetIDChange: 0n,
        inputAmount: 1n,
        swapAmount: 1n,
        changeAmount: 0n,
        outputAmountSwap: 1n,
        minOutputAmountSwap: 1n,
        gasRefund: 0n,
        protocolFee: 0n,
        merklePath: Array(10).fill(0n),
        merklePathIndices: Array(10).fill(0n),
      },
      await outTok.getAddress()
    );

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(joinSplitStub)).to.be.revertedWithCustomError(
      pool,
      "SP"
    );
  });

  it("allows join-split spend using a historical Merkle root after a later deposit", async function () {
    const { deployer, pool, feeOracle } = await deployReducedPoolWithJoinSplitVerifier();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("OutHist", "H", 18);
    await outTok.waitForDeployment();
    const outAddr = await outTok.getAddress();
    await allowlistAndRegisterAsset(pool, deployer, 1n, outAddr);

    // Amounts must leave positive change under FeeOracle $10 floor when USD value is 0 (local tests).
    const inputAmount = ethers.parseEther("25");
    const swapAmount = ethers.parseEther("5");
    const inputBlindingFactor = randField();
    const ownerPublicKey = randField();
    const swapBlindingFactor = randField();
    const changeBlindingFactor = randField();
    const inputCommitmentBn = computeCommitment(0n, inputAmount, inputBlindingFactor, ownerPublicKey);
    const inputCommitmentHex = commitmentToBytes32(inputCommitmentBn);

    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, inputCommitmentHex, 0n, {
      value: inputAmount,
    });

    const { root: rootAfterFirst, path: pathAfterFirst, indices: idxAfterFirst } =
      await merkleProofForFirstLeaf(inputCommitmentHex);
    const poolRootAfterFirst = await pool.merkleRoot();
    expect(poolRootAfterFirst).to.equal(rootAfterFirst);

    const secondCommitment = ethers.keccak256(ethers.toUtf8Bytes("second-leaf-for-history"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("1"), secondCommitment, 0n, {
      value: ethers.parseEther("1"),
    });
    expect(await pool.merkleRoot()).to.not.equal(rootAfterFirst);
    expect(await pool.validMerkleRoots(rootAfterFirst)).to.equal(true);

    const noteFields = { inputBlindingFactor, ownerPublicKey, swapBlindingFactor, changeBlindingFactor };
    const publicInputs = await buildSwapPublicInputs(
      feeOracle,
      inputAmount,
      swapAmount,
      inputCommitmentHex,
      noteFields
    );
    Object.assign(publicInputs, {
      merkleRoot: rootAfterFirst,
      merklePath: pathAfterFirst,
      merklePathIndices: idxAfterFirst,
    });

    const { poolProof } = await proveJoinSplitPublic9FromPublicInputs(publicInputs);

    const swapData = await buildReducedJoinSplitTx(pool, deployer, publicInputs, outAddr);
    swapData.proof = poolProof;

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.emit(pool, "ShieldedSwapJoinSplit");
    expect(await pool.nullifiers(publicInputs.nullifier)).to.equal(true);
  });
});
