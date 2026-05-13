const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./helpers/libraryLinker.cjs");

describe("EncryptedPool submitFHESwap", function () {
  it("requires STANDARD mode, persists commitment, and completes FHE swap flow", async function () {
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

    const FHECoprocessor = await ethers.getContractFactory("FHECoprocessor");
    const fhe = await FHECoprocessor.deploy();
    await fhe.waitForDeployment();
    const fheAddr = await fhe.getAddress();

    const SelectiveDisclosure = await ethers.getContractFactory("SelectiveDisclosure");
    const selective = await SelectiveDisclosure.deploy(joinAddr);
    await selective.waitForDeployment();
    const selectiveAddr = await selective.getAddress();

    const ThresholdEncryption = await ethers.getContractFactory("ThresholdEncryption");
    const thresholdEnc = await ThresholdEncryption.deploy();
    await thresholdEnc.waitForDeployment();
    const thresholdEncAddr = await thresholdEnc.getAddress();

    const EncryptedPool = await getShieldedPoolFactory("EncryptedPool");
    const pool = await EncryptedPool.deploy(
      joinAddr,
      thresholdAddr,
      swapAddr,
      feeOracleAddr,
      relayerRegistryAddr,
      fheAddr,
      selectiveAddr,
      thresholdEncAddr
    );
    await pool.waitForDeployment();

    await (await pool.setPrivacyMode(1)).wait();

    const encIn = ethers.toUtf8Bytes("in");
    const encOut = ethers.toUtf8Bytes("out");
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commit"));
    const proof = "0x";

    const tx = await pool.submitFHESwap(encIn, encOut, commitment, proof);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    const stored = await pool.encryptedCommitments(commitment);
    expect(stored).to.equal(ethers.hexlify(encOut));
  });
});
