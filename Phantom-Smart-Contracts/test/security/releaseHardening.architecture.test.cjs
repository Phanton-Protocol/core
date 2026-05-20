/**
 * Release-hardening architecture checks (docs + deploy assertions; no economic semantics).
 * Run: HH_FULL=1 npx hardhat test test/security/releaseHardening.architecture.test.cjs
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const { initFeeOracleForTests } = require("../helpers/reducedProduction.cjs");
const {
  assertPathBCanonicalPoolContract,
  assertProductionRelayerRegistry,
  assertGovernanceMigrationComplete,
  PATH_B_CANONICAL_POOL_CONTRACT,
  assertExperimentalDeployBlocked,
} = require("../helpers/networkConfigAssertions.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const TLC_FQN = "contracts/_full/governance/TimelockController.sol:TimelockController";

describe("Release hardening — Path-B architecture", function () {
  it("canonical production pool contract name is ShieldedPoolUpgradeableReduced", function () {
    expect(PATH_B_CANONICAL_POOL_CONTRACT).to.equal("ShieldedPoolUpgradeableReduced");
    expect(() => assertPathBCanonicalPoolContract("ShieldedPool")).to.throw(/ShieldedPoolUpgradeableReduced/);
    assertPathBCanonicalPoolContract("ShieldedPoolUpgradeableReduced");
  });

  it("canonical reduced pool implementation deploys with linked libraries", async function () {
    const { getUpgradeablePoolFactory } = require("../helpers/libraryLinker.cjs");
    const factory = await getUpgradeablePoolFactory(REDUCED_FQN);
    // Path-B: parameterless constructor (M3 `internalMatchSettle` removed).
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    expect(await impl.getAddress()).to.properAddress;
    expect(REDUCED_FQN).to.include("ShieldedPoolUpgradeableReduced");
  });

  it("RelayerStaking passes production registry probe; RelayerRegistry fails", async function () {
    const [deployer] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("ProtocolToken");
    const token = await Token.deploy(deployer.address);
    await token.waitForDeployment();
    const RS = await ethers.getContractFactory("RelayerStaking");
    const rs = await RS.deploy(await token.getAddress(), ethers.parseEther("1"));
    await rs.waitForDeployment();
    await assertProductionRelayerRegistry(await rs.getAddress(), ethers.provider);

    const RR = await ethers.getContractFactory("RelayerRegistry");
    const rr = await RR.deploy();
    await rr.waitForDeployment();
    await expect(assertProductionRelayerRegistry(await rr.getAddress(), ethers.provider)).to.be.rejectedWith(
      /not RelayerStaking/
    );
  });

  it("assertGovernanceMigrationComplete accepts fully migrated reduced stack", async function () {
    const [deployer, emergency] = await ethers.getSigners();

    const TLC = await ethers.getContractFactory(TLC_FQN);
    const tlc = await TLC.deploy(60, [deployer.address], [ethers.ZeroAddress], deployer.address);
    await tlc.waitForDeployment();
    const timelockAddr = await tlc.getAddress();

    const MV = await ethers.getContractFactory("MockVerifier");
    const v1 = await MV.deploy();
    const v2 = await MV.deploy();
    await v1.waitForDeployment();
    await v2.waitForDeployment();
    const A = await ethers.getContractFactory("MockSwapAdaptor");
    const a = await A.deploy();
    await a.waitForDeployment();
    const F = await ethers.getContractFactory("FeeOracle");
    const f = await F.deploy();
    await f.waitForDeployment();
    await initFeeOracleForTests(f, deployer);

    const Token = await ethers.getContractFactory("ProtocolToken");
    const token = await Token.deploy(deployer.address);
    await token.waitForDeployment();
    const RS = await ethers.getContractFactory("RelayerStaking");
    const rs = await RS.deploy(await token.getAddress(), ethers.parseEther("1"));
    await rs.waitForDeployment();

    const pool = await deployBehindProxy(REDUCED_FQN, [
      await v1.getAddress(),
      await v2.getAddress(),
      await a.getAddress(),
      await f.getAddress(),
      await rs.getAddress(),
    ]);
    await (await pool.initializeV2(timelockAddr, emergency.address)).wait();
    await (await f.initializeTimelock(timelockAddr)).wait();

    await assertGovernanceMigrationComplete(
      {
        poolAddress: await pool.getAddress(),
        timelockAddress: timelockAddr,
        feeOracleAddress: await f.getAddress(),
        relayerRegistryAddress: await rs.getAddress(),
        emergencyAdminAddress: emergency.address,
      },
      ethers.provider
    );
  });

  it("assertGovernanceMigrationComplete rejects pool before initializeV2", async function () {
    const [deployer] = await ethers.getSigners();

    const TLC = await ethers.getContractFactory(TLC_FQN);
    const tlc = await TLC.deploy(60, [deployer.address], [ethers.ZeroAddress], deployer.address);
    await tlc.waitForDeployment();

    const MV = await ethers.getContractFactory("MockVerifier");
    const v1 = await MV.deploy();
    const v2 = await MV.deploy();
    await v1.waitForDeployment();
    await v2.waitForDeployment();
    const A = await ethers.getContractFactory("MockSwapAdaptor");
    const a = await A.deploy();
    await a.waitForDeployment();
    const F = await ethers.getContractFactory("FeeOracle");
    const f = await F.deploy();
    await f.waitForDeployment();
    await initFeeOracleForTests(f, deployer);
    const RR = await ethers.getContractFactory("RelayerRegistry");
    const r = await RR.deploy();
    await r.waitForDeployment();

    const pool = await deployBehindProxy(REDUCED_FQN, [
      await v1.getAddress(),
      await v2.getAddress(),
      await a.getAddress(),
      await f.getAddress(),
      await r.getAddress(),
    ]);

    await expect(
      assertGovernanceMigrationComplete(
        {
          poolAddress: await pool.getAddress(),
          timelockAddress: await tlc.getAddress(),
          feeOracleAddress: await f.getAddress(),
        },
        ethers.provider
      )
    ).to.be.rejectedWith(/timelock unset/);
  });

  it("assertExperimentalDeployBlocked still rejects experimental flags on production profile", function () {
    expect(() =>
      assertExperimentalDeployBlocked({ DEPLOY_PROFILE: "production", DEPLOY_DARK_POOL: "true" })
    ).to.throw(/DEPLOY_DARK_POOL=true forbidden/);
  });
});
