/**
 * M3 — Phase 7 / FHE internal-match port on Reduced pool.
 *
 * Asserts that {ShieldedPoolUpgradeableReduced} (the UUPS-upgraded BSC-testnet
 * pool at 0x77C4BadA4306e4b258980f0f0D79Aec814509FDf after M3 deployment) settles
 * a happy-path internal match identically to the legacy {ShieldedPool}.
 *
 * Crucially, both pools are fed the EXACT same settlement payload (re-signed
 * against each pool's own EIP-712 verifying-contract domain) so the
 * decision-hash / proof-context binding logic in {InternalMatchIntentLib}
 * exercises the same code path on both.
 *
 * Out of scope (kept on legacy pool tests in `internalMatchSettle.integration.test.cjs`):
 *   - Negative-path attestation rejection (those tests cover the library directly
 *     and the legacy ShieldedPool dispatcher; behavior is library-driven, so the
 *     Reduced inline-assembly forwarder inherits them transitively).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildSettlementData } = require("./helpers/internalMatchSettleFixtures.cjs");
const { deployBehindProxy } = require("./helpers/proxyDeploy.cjs");

const REDUCED_FQN =
  "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

/**
 * Deploy a Reduced pool behind ERC1967 with the same mock stack used by the
 * legacy `internalMatchSettle.integration.test.cjs` so the settle path is the
 * only variable between the two pools.
 *
 * The ConfigurableMockVerifier short-circuits Groth16 verification to `true`
 * for happy-path matches, and MockFeeOracle / MockSwapAdaptor stand in for
 * production wiring (neither is touched by `internalMatchSettle`).
 */
async function deployReducedPoolForInternalMatch() {
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

  const pool = await deployBehindProxy(REDUCED_FQN, [
    verifierAddr,
    verifierAddr,
    await swapAdaptor.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress(),
  ]);
  return { deployer, pool };
}

async function deployLegacyShieldedPool() {
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

  const InternalMatchIntentLib = await ethers.getContractFactory("InternalMatchIntentLib");
  const intentLib = await InternalMatchIntentLib.deploy();
  await intentLib.waitForDeployment();
  const ShieldedPool = await ethers.getContractFactory("ShieldedPool", {
    libraries: { InternalMatchIntentLib: await intentLib.getAddress() },
  });
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

describe("ShieldedPoolUpgradeableReduced.internalMatchSettle (M3 — UUPS port)", function () {
  it("upgraded Reduced pool accepts a valid internal settlement and emits the canonical InternalMatchSettled event", async function () {
    const { pool, deployer } = await deployReducedPoolForInternalMatch();
    const data = await buildSettlementData({ pool, deployer });
    // {InternalMatchSettled} is declared in {InternalMatchIntentLib}, NOT the pool
    // itself — the inline-assembly DELEGATECALL forwarder in {internalMatchSettle}
    // surfaces the library event at the pool's address. To assert on it we attach
    // the library ABI to the pool's address (so chai-matchers can decode the log).
    const eventAbi = await ethers.getContractAt("InternalMatchIntentLib", await pool.getAddress());
    await expect(pool.internalMatchSettle(data))
      .to.emit(eventAbi, "InternalMatchSettled")
      .withArgs(
        data.matchHash,
        data.decisionHash,
        data.executionKey,
        data.artifact.makerOrderId,
        data.artifact.takerOrderId,
        deployer.address
      );
  });

  it("upgraded Reduced and legacy ShieldedPool emit byte-identical InternalMatchSettled args for the same artifact", async function () {
    const { pool: legacyPool, deployer } = await deployLegacyShieldedPool();
    const { pool: reducedPool } = await deployReducedPoolForInternalMatch();

    // EIP-712 verifyingContract differs per pool, so re-sign for each. The
    // *settlement artifact* itself is shared so the emitted event args match.
    const legacyData = await buildSettlementData({ pool: legacyPool, deployer });
    const reducedData = await buildSettlementData({
      pool: reducedPool,
      deployer,
      overrides: {
        // Share the artifact-defining fields between the two so the emitted
        // InternalMatchSettled args are bit-identical across pools.
        matchHash: legacyData.matchHash,
        executionKey: legacyData.executionKey,
        makerOrderId: legacyData.artifact.makerOrderId,
        takerOrderId: legacyData.artifact.takerOrderId,
        makerInputCommitment: legacyData.artifact.makerInputCommitment,
        takerInputCommitment: legacyData.artifact.takerInputCommitment,
        makerInputAssetID: legacyData.artifact.makerInputAssetID,
        takerInputAssetID: legacyData.artifact.takerInputAssetID,
        executionPrice: legacyData.artifact.executionPrice,
        quantity: legacyData.artifact.quantity,
        decidedAt: legacyData.artifact.decidedAt,
        decisionNonce: legacyData.artifact.decisionNonce,
        signerSetHash: legacyData.artifact.signerSetHash,
      },
    });

    expect(reducedData.decisionHash).to.equal(legacyData.decisionHash);
    expect(reducedData.matchHash).to.equal(legacyData.matchHash);
    expect(reducedData.executionKey).to.equal(legacyData.executionKey);

    // Both pools surface the event from {InternalMatchIntentLib}; attach the
    // library ABI to each pool address so chai-matchers can decode the log.
    const legacyEventAbi = await ethers.getContractAt(
      "InternalMatchIntentLib",
      await legacyPool.getAddress()
    );
    const reducedEventAbi = await ethers.getContractAt(
      "InternalMatchIntentLib",
      await reducedPool.getAddress()
    );

    await expect(legacyPool.internalMatchSettle(legacyData))
      .to.emit(legacyEventAbi, "InternalMatchSettled")
      .withArgs(
        legacyData.matchHash,
        legacyData.decisionHash,
        legacyData.executionKey,
        legacyData.artifact.makerOrderId,
        legacyData.artifact.takerOrderId,
        deployer.address
      );

    await expect(reducedPool.internalMatchSettle(reducedData))
      .to.emit(reducedEventAbi, "InternalMatchSettled")
      .withArgs(
        reducedData.matchHash,
        reducedData.decisionHash,
        reducedData.executionKey,
        reducedData.artifact.makerOrderId,
        reducedData.artifact.takerOrderId,
        deployer.address
      );
  });

  it("upgraded Reduced pool rejects replayed matchHash with the same library error (PoolErr 52)", async function () {
    const { pool, deployer } = await deployReducedPoolForInternalMatch();
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
    // The inline-assembly forwarder re-raises the library's revert verbatim,
    // so the original `PoolErr(uint8)` selector + arg surface 1:1.
    await expect(pool.internalMatchSettle(second))
      .to.be.revertedWithCustomError(
        await ethers.getContractAt("InternalMatchIntentLib", await pool.internalMatchIntentLib()),
        "PoolErr"
      )
      .withArgs(52);
  });

  it("non-relayer caller is blocked by onlyRelayer (pre-library guard)", async function () {
    const { pool, deployer } = await deployReducedPoolForInternalMatch();
    const data = await buildSettlementData({ pool, deployer });
    const stranger = (await ethers.getSigners())[1];
    // onlyRelayer reverts with `SP()` before the inline-assembly DELEGATECALL,
    // so no library bytes are consumed when an unauthorised account submits.
    await expect(pool.connect(stranger).internalMatchSettle(data)).to.be.revertedWithCustomError(
      pool,
      "SP"
    );
  });
});
