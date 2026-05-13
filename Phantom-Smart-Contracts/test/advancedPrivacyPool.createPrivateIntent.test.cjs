const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getShieldedPoolFactory } = require("./helpers/libraryLinker.cjs");

describe("AdvancedPrivacyPool createPrivateIntent", function () {
  it("succeeds with MAX mode and registers intent", async function () {
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

    await (await pool.setPrivacyMode(2)).wait();

    const enc = ethers.toUtf8Bytes("private-intent");
    const nodes = [deployer.address];

    const tx = await pool.createPrivateIntent(enc, nodes);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);

    const iface = pool.interface;
    let intentId;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "PrivateIntentCreated") {
          intentId = parsed.args.intentId;
          break;
        }
      } catch {
        /* not this contract */
      }
    }
    expect(intentId).to.not.equal(undefined);
    const stored = await pool.privateIntents(intentId);
    expect(stored.user).to.equal(deployer.address);
  });
});
