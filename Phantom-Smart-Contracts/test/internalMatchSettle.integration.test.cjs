const { expect } = require("chai");
const { ethers } = require("hardhat");
const { merkleProofForFirstLeaf, emptyProof } = require("./helpers/poolFixtures.cjs");

async function deployPoolWithConfigurableVerifier() {
  const [deployer] = await ethers.getSigners();

  const ConfigurableVerifier = await ethers.getContractFactory("ConfigurableMockVerifier");
  const verifier = await ConfigurableVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
  const swapAdaptor = await MockSwapAdaptor.deploy();
  await swapAdaptor.waitForDeployment();

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
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

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(
    await pool.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await depositHandler.waitForDeployment();
  await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();

  const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
  const txHistory = await TransactionHistory.deploy(await pool.getAddress());
  await txHistory.waitForDeployment();
  await (await pool.setTransactionHistory(await txHistory.getAddress())).wait();

  return { deployer, pool, verifier, feeOracle };
}

async function buildInternalMatchData(pool, feeOracle, overrides = {}) {
  const commitment = overrides.commitment || ethers.keccak256(ethers.toUtf8Bytes(`m5-note-${Math.random()}`));
  const inputAmount = overrides.inputAmount || ethers.parseEther("10");
  await pool.deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, { value: inputAmount });
  const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
  const fee = (await feeOracle.calculateFee.staticCall(ethers.ZeroAddress, inputAmount)) + (inputAmount * 10n) / 10000n;
  const swapAmount = overrides.swapAmount || ethers.parseEther("2");
  const changeAmount = inputAmount - swapAmount - fee;
  const baseLeg = {
    inputCommitment: commitment,
    merkleRoot: root,
    inputAssetID: 0n,
    outputAssetIDSwap: 0n,
    outputAssetIDChange: 0n,
    inputAmount,
    swapAmount,
    changeAmount,
    outputAmountSwap: swapAmount,
    minOutputAmountSwap: swapAmount,
    gasRefund: 0n,
    protocolFee: fee,
    merklePath: path,
    merklePathIndices: indices,
  };
  const takerInputs = {
    ...baseLeg,
    nullifier: overrides.takerNullifier || ethers.keccak256(ethers.toUtf8Bytes("m5-taker-nullifier")),
    outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("m5-taker-swap")),
    outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m5-taker-change")),
    ...(overrides.takerInputs || {}),
  };
  const makerInputs = {
    ...baseLeg,
    nullifier: overrides.makerNullifier || ethers.keccak256(ethers.toUtf8Bytes("m5-maker-nullifier")),
    outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("m5-maker-swap")),
    outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m5-maker-change")),
    ...(overrides.makerInputs || {}),
  };
  return {
    takerProof: emptyProof(),
    takerInputs,
    makerProof: emptyProof(),
    makerInputs,
    relayer: ethers.ZeroAddress,
    matchHash: overrides.matchHash || ethers.keccak256(ethers.toUtf8Bytes("m5-match")),
    executionKey: overrides.executionKey || ethers.keccak256(ethers.toUtf8Bytes("m5-exec")),
    encryptedPayload: "0x",
  };
}

describe("ShieldedPool.internalMatchSettle (Module 5)", function () {
  it("settles atomic internal match and marks both nullifiers", async function () {
    const { pool, feeOracle } = await deployPoolWithConfigurableVerifier();
    const data = await buildInternalMatchData(pool, feeOracle);
    await expect(pool.internalMatchSettle(data)).to.emit(pool, "InternalMatchSettled");
    expect(await pool.nullifiers(data.takerInputs.nullifier)).to.equal(true);
    expect(await pool.nullifiers(data.makerInputs.nullifier)).to.equal(true);
  });

  it("reverts on used nullifier (PoolErr 4)", async function () {
    const { pool, feeOracle } = await deployPoolWithConfigurableVerifier();
    const data = await buildInternalMatchData(pool, feeOracle);
    await pool.internalMatchSettle(data);
    const currentRoot = await pool.merkleRoot();
    const secondAttempt = {
      ...data,
      takerInputs: { ...data.takerInputs, merkleRoot: currentRoot },
      makerInputs: { ...data.makerInputs, merkleRoot: currentRoot },
    };
    await expect(pool.internalMatchSettle(secondAttempt)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(4);
  });

  it("reverts on stale/invalid root (PoolErr 46)", async function () {
    const { pool, feeOracle } = await deployPoolWithConfigurableVerifier();
    const data = await buildInternalMatchData(pool, feeOracle, {
      takerInputs: { merkleRoot: ethers.keccak256(ethers.toUtf8Bytes("bad-root")) },
    });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(46);
  });

  it("reverts on invalid proof path (PoolErr 40)", async function () {
    const { pool, feeOracle, verifier } = await deployPoolWithConfigurableVerifier();
    const data = await buildInternalMatchData(pool, feeOracle);
    await verifier.setValid(false);
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(40);
  });

  it("reverts on fee mismatch (PoolErr 5)", async function () {
    const { pool, feeOracle } = await deployPoolWithConfigurableVerifier();
    const fee = (await feeOracle.calculateFee.staticCall(ethers.ZeroAddress, ethers.parseEther("10"))) + (ethers.parseEther("10") * 10n) / 10000n;
    const data = await buildInternalMatchData(pool, feeOracle, {
      takerInputs: {
        protocolFee: fee - 1n,
        changeAmount: ethers.parseEther("10") - ethers.parseEther("2") - (fee - 1n),
      },
    });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(5);
  });

  it("reverts on conservation violation (PoolErr 43)", async function () {
    const { pool, feeOracle } = await deployPoolWithConfigurableVerifier();
    const data = await buildInternalMatchData(pool, feeOracle, {
      makerInputs: { changeAmount: 1n },
    });
    await expect(pool.internalMatchSettle(data)).to.be.revertedWithCustomError(pool, "PoolErr").withArgs(43);
  });
});
