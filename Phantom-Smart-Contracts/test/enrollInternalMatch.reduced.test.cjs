const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBehindProxy } = require("./helpers/proxyDeploy.cjs");

const REDUCED_FQN =
  "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

async function deployReducedPool() {
  const [deployer] = await ethers.getSigners();
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const joinV = await MockVerifier.deploy();
  const threshV = await MockVerifier.deploy();
  await joinV.waitForDeployment();
  await threshV.waitForDeployment();

  const MockSwapAdaptor = await ethers.getContractFactory(
    "contracts/_full/mocks/MockSwapAdaptor.sol:MockSwapAdaptor"
  );
  const swapAdaptor = await MockSwapAdaptor.deploy();
  await swapAdaptor.waitForDeployment();

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await joinV.getAddress(),
    await threshV.getAddress(),
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);

  return { pool, deployer };
}

function payloadHashOf(encryptedPayload) {
  return ethers.keccak256(encryptedPayload);
}

async function signEnrollment(user, enrollmentId, encryptedPayload) {
  const payloadHash = payloadHashOf(encryptedPayload);
  const messageHash = ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32"],
    [enrollmentId, payloadHash]
  );
  return user.signMessage(ethers.getBytes(messageHash));
}

describe("ShieldedPoolUpgradeableReduced — enrollInternalMatch (M6)", function () {
  it("happy path: enroll, event, and isInternalMatchEnrolled", async function () {
    const { pool } = await deployReducedPool();
    const user = (await ethers.getSigners())[1];
    const enrollmentId = ethers.keccak256(ethers.toUtf8Bytes("enroll-1"));
    const encryptedPayload = ethers.hexlify(ethers.toUtf8Bytes('{"v":1,"optIn":true}'));

    const sig = await signEnrollment(user, enrollmentId, encryptedPayload);
    const payloadHash = payloadHashOf(encryptedPayload);

    await expect(
      pool.connect(user).enrollInternalMatch(enrollmentId, encryptedPayload, sig)
    )
      .to.emit(pool, "InternalMatchEnrolled")
      .withArgs(user.address, enrollmentId, payloadHash, encryptedPayload);

    expect(await pool.isInternalMatchEnrolled(user.address)).to.equal(true);
    expect(await pool.internalEnrollmentByUser(user.address)).to.equal(enrollmentId);
    expect(await pool.internalEnrollmentUsed(enrollmentId)).to.equal(true);
  });

  it("rejects replay of enrollmentId", async function () {
    const { pool } = await deployReducedPool();
    const user = (await ethers.getSigners())[1];
    const other = (await ethers.getSigners())[2];
    const enrollmentId = ethers.keccak256(ethers.toUtf8Bytes("enroll-replay-id"));
    const encryptedPayload = ethers.hexlify(ethers.toUtf8Bytes("payload-a"));
    const sig = await signEnrollment(user, enrollmentId, encryptedPayload);

    await pool.connect(user).enrollInternalMatch(enrollmentId, encryptedPayload, sig);

    const otherPayload = ethers.hexlify(ethers.toUtf8Bytes("payload-b"));
    const otherSig = await signEnrollment(other, enrollmentId, otherPayload);
    await expect(
      pool.connect(other).enrollInternalMatch(enrollmentId, otherPayload, otherSig)
    ).to.be.revertedWithCustomError(pool, "SP");
  });

  it("rejects re-enroll for same address", async function () {
    const { pool } = await deployReducedPool();
    const user = (await ethers.getSigners())[1];
    const id1 = ethers.keccak256(ethers.toUtf8Bytes("enroll-a"));
    const id2 = ethers.keccak256(ethers.toUtf8Bytes("enroll-b"));
    const payload1 = ethers.hexlify(ethers.toUtf8Bytes("p1"));
    const payload2 = ethers.hexlify(ethers.toUtf8Bytes("p2"));

    await pool
      .connect(user)
      .enrollInternalMatch(id1, payload1, await signEnrollment(user, id1, payload1));

    await expect(
      pool
        .connect(user)
        .enrollInternalMatch(id2, payload2, await signEnrollment(user, id2, payload2))
    ).to.be.revertedWithCustomError(pool, "SP");
  });

  it("rejects wrong signer", async function () {
    const { pool } = await deployReducedPool();
    const user = (await ethers.getSigners())[1];
    const attacker = (await ethers.getSigners())[2];
    const enrollmentId = ethers.keccak256(ethers.toUtf8Bytes("enroll-wrong-signer"));
    const encryptedPayload = ethers.hexlify(ethers.toUtf8Bytes("payload"));
    const badSig = await signEnrollment(attacker, enrollmentId, encryptedPayload);

    await expect(
      pool.connect(user).enrollInternalMatch(enrollmentId, encryptedPayload, badSig)
    ).to.be.revertedWithCustomError(pool, "SP");
  });

  it("rejects empty encrypted payload", async function () {
    const { pool } = await deployReducedPool();
    const user = (await ethers.getSigners())[1];
    const enrollmentId = ethers.keccak256(ethers.toUtf8Bytes("enroll-empty"));
    const encryptedPayload = "0x";
    const sig = await signEnrollment(user, enrollmentId, encryptedPayload);

    await expect(
      pool.connect(user).enrollInternalMatch(enrollmentId, encryptedPayload, sig)
    ).to.be.revertedWithCustomError(pool, "SP");
  });
});
