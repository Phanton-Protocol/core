const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./helpers/libraryLinker.cjs");

describe("AdvancedPrivacyPool submitFHESwap", function () {
  it("is nonReentrant and persists commitment", async function () {
    const [deployer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const joinVerifier = await MockVerifier.deploy();
    await joinVerifier.waitForDeployment();
    const joinAddr = await joinVerifier.getAddress();
    const thresholdVerifier = await MockVerifier.deploy();
    await thresholdVerifier.waitForDeployment();
    const thresholdAddr = await thresholdVerifier.getAddress();

    const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
    const swapAdaptor = await MockSwapAdaptor.deploy();
    await swapAdaptor.waitForDeployment();
    const swapAddr = await swapAdaptor.getAddress();

    const FeeOracle = await ethers.getContractFactory("FeeOracle");
    const feeOracle = await FeeOracle.deploy();
    await feeOracle.waitForDeployment();
    const feeOracleAddr = await feeOracle.getAddress();

    const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
    const relayerRegistry = await RelayerRegistry.deploy();
    await relayerRegistry.waitForDeployment();
    const relayerRegistryAddr = await relayerRegistry.getAddress();
    await (await relayerRegistry.registerRelayer(deployer.address)).wait();

    const MockFHEExecutor = await ethers.getContractFactory("MockFHEExecutor");
    const fhe = await MockFHEExecutor.deploy();
    await fhe.waitForDeployment();
    const fheAddr = await fhe.getAddress();

    const MockMPCCoprocessor = await ethers.getContractFactory("MockMPCCoprocessor");
    const mpc = await MockMPCCoprocessor.deploy();
    await mpc.waitForDeployment();
    const mpcAddr = await mpc.getAddress();

    const MockThresholdEncryption = await ethers.getContractFactory("MockThresholdEncryption");
    const thr = await MockThresholdEncryption.deploy();
    await thr.waitForDeployment();
    const thrAddr = await thr.getAddress();

    const AdvancedPrivacyPool = await getShieldedPoolFactory("AdvancedPrivacyPool");
    const pool = await AdvancedPrivacyPool.deploy(
      joinAddr,
      thresholdAddr,
      swapAddr,
      feeOracleAddr,
      relayerRegistryAddr,
      fheAddr,
      mpcAddr,
      thrAddr
    );
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    // STANDARD
    await (await pool.setPrivacyMode(1)).wait();

    // Swap in a re-entrant FHE executor via the (currently open) admin setter.
    const ReentrantFHEExecutor = await ethers.getContractFactory("ReentrantFHEExecutor");
    const reentrant = await ReentrantFHEExecutor.deploy(poolAddr);
    await reentrant.waitForDeployment();
    await (await pool.updateFHEExecutor(await reentrant.getAddress())).wait();

    const encIn = ethers.toUtf8Bytes("in");
    const encOut = ethers.toUtf8Bytes("out");
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commit"));
    const proof = "0x";

    const tx = await pool.submitFHESwap(encIn, encOut, commitment, proof);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    expect(await reentrant.attemptedReentry()).to.equal(true);
    expect(await reentrant.reentryBlocked()).to.equal(true);
    expect(await reentrant.reentrySucceeded()).to.equal(false);

    const stored = await pool.encryptedCommitments(commitment);
    expect(stored).to.equal(ethers.hexlify(encOut));
  });
});

