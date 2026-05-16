/**
 * Module 6 — External integrations & oracle hardening.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { emptyProof } = require("../helpers/poolFixtures.cjs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const { getUpgradeablePoolFactory } = require("../helpers/libraryLinker.cjs");
const { initFeeOracleForTests } = require("../helpers/reducedProduction.cjs");
const {
  assertExpectedChainId,
  requireBnbUsdFeedForChain,
  assertOffchainOraclePolicy,
  assertProductionNetworkBinding,
  assertExperimentalDeployBlocked,
} = require("../helpers/networkConfigAssertions.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const TLC_FQN = "contracts/_full/governance/TimelockController.sol:TimelockController";
const MOCK_AGG_FQN = "contracts/_full/mocks/MockChainlinkAggregator.sol:MockChainlinkAggregator";
const OFFCHAIN_HIGH_FQN = "contracts/_full/mocks/MockOffchainPriceHigh.sol:MockOffchainPriceHigh";
const MOCK_CHAINALYSIS_FQN = "contracts/_full/mocks/MockChainalysisOracle.sol:MockChainalysisOracle";
const BAD_COMPLIANCE_FQN = "contracts/_full/mocks/MockRejectingReceiver.sol:MockRejectingReceiver";

async function deployReducedBase() {
  const [deployer, attacker] = await ethers.getSigners();
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
  const R = await ethers.getContractFactory("RelayerRegistry");
  const r = await R.deploy();
  await r.waitForDeployment();
  await (await r.registerRelayer(deployer.address)).wait();

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await v1.getAddress(),
    await v2.getAddress(),
    await a.getAddress(),
    await f.getAddress(),
    await r.getAddress(),
  ]);

  const TLC = await ethers.getContractFactory(TLC_FQN);
  const tlc = await TLC.deploy(0, [deployer.address], [deployer.address], deployer.address);
  await tlc.waitForDeployment();

  return { deployer, attacker, pool, feeOracle: f, tlc };
}

describe("Module 6 — integrations & oracle hardening", function () {
  describe("ShieldedPoolUpgradeableReduced — integration mutability", function () {
    it("owner can set handlers during bootstrap; timelock required after initializeV2", async function () {
      const { deployer, attacker, pool, tlc } = await deployReducedBase();
      const WH = await ethers.getContractFactory("WithdrawHandler");
      const wh = await WH.deploy(
        await pool.getAddress(),
        await pool.verifier(),
        await pool.thresholdVerifier(),
        await pool.feeOracle(),
        await pool.relayerRegistry()
      );
      await wh.waitForDeployment();
      const whAddr = await wh.getAddress();
      await (await pool.setWithdrawHandler(whAddr)).wait();
      expect(await pool.withdrawHandler()).to.equal(whAddr);

      await (await pool.initializeV2(await tlc.getAddress(), deployer.address)).wait();

      const WH2 = await ethers.getContractFactory("WithdrawHandler");
      const wh2 = await WH2.deploy(
        await pool.getAddress(),
        await pool.verifier(),
        await pool.thresholdVerifier(),
        await pool.feeOracle(),
        await pool.relayerRegistry()
      );
      await wh2.waitForDeployment();

      await expect(pool.connect(deployer).setWithdrawHandler(await wh2.getAddress())).to.be.revertedWithCustomError(
        pool,
        "NotTimelock"
      );
      await expect(pool.connect(attacker).setWithdrawHandler(await wh2.getAddress())).to.be.revertedWithCustomError(
        pool,
        "NotTimelock"
      );
    });

    it("swap adaptor rotation uses timelock-gated UUPS (no setSwapAdaptor on Reduced)", async function () {
      const { deployer, pool, tlc } = await deployReducedBase();
      await (await pool.initializeV2(await tlc.getAddress(), deployer.address)).wait();
      expect(pool.setSwapAdaptor).to.equal(undefined);
      const poolAddr = await pool.getAddress();
      const Impl = await getUpgradeablePoolFactory(REDUCED_FQN);
      const impl2 = await Impl.deploy();
      await impl2.waitForDeployment();
      const data = pool.interface.encodeFunctionData("upgradeTo", [await impl2.getAddress()]);
      const salt = ethers.id("m6-uups-swap-adaptor-path");
      await (await tlc.schedule(poolAddr, 0, data, ethers.ZeroHash, salt, 0)).wait();
      await (await tlc.execute(poolAddr, 0, data, ethers.ZeroHash, salt)).wait();
    });

    it("timelock can rotate feeOracle after migration", async function () {
      const { deployer, pool, tlc } = await deployReducedBase();
      await (await pool.initializeV2(await tlc.getAddress(), deployer.address)).wait();

      const F2 = await ethers.getContractFactory("FeeOracle");
      const f2 = await F2.deploy();
      await f2.waitForDeployment();
      await initFeeOracleForTests(f2, deployer);

      const poolAddr = await pool.getAddress();
      const f2Addr = await f2.getAddress();
      const data = pool.interface.encodeFunctionData("setFeeOracle", [f2Addr]);
      const salt = ethers.id("m6-set-fee-oracle");
      await (await tlc.schedule(poolAddr, 0, data, ethers.ZeroHash, salt, 0)).wait();
      await (await tlc.execute(poolAddr, 0, data, ethers.ZeroHash, salt)).wait();
      expect(await pool.feeOracle()).to.equal(f2Addr);
    });
  });

  describe("PancakeSwapAdaptor — immutable router", function () {
    it("router and wbnb are immutable; no setRouter entrypoint", async function () {
      const [deployer, attacker] = await ethers.getSigners();
      const router = ethers.Wallet.createRandom().address;
      const wbnb = ethers.Wallet.createRandom().address;
      const Pancake = await ethers.getContractFactory("PancakeSwapAdaptor");
      const adaptor = await Pancake.deploy(router, wbnb);
      await adaptor.waitForDeployment();
      expect(await adaptor.router()).to.equal(router);
      expect(await adaptor.wbnb()).to.equal(wbnb);
      expect(adaptor.setRouter).to.equal(undefined);
      await expect(
        adaptor.connect(attacker).withdrawToken(ethers.ZeroAddress, 0)
      ).to.be.revertedWith("PancakeSwapAdaptor: not owner");
    });
  });

  describe("FeeOracle — timelock governance", function () {
    it("owner sets feeds at bootstrap; timelock required after initializeTimelock", async function () {
      const [deployer, attacker] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      const feedAddr = await feed.getAddress();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, feedAddr)).wait();

      const TLC = await ethers.getContractFactory(TLC_FQN);
      const tlc = await TLC.deploy(0, [deployer.address], [deployer.address], deployer.address);
      await tlc.waitForDeployment();
      await (await feeOracle.initializeTimelock(await tlc.getAddress())).wait();

      const feed2 = await Agg.deploy(700n * 10n ** 8n);
      await feed2.waitForDeployment();
      await expect(
        feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed2.getAddress())
      ).to.be.revertedWithCustomError(feeOracle, "NotTimelock");
      await expect(
        feeOracle.connect(attacker).setMaxFeedAge(120)
      ).to.be.revertedWithCustomError(feeOracle, "NotTimelock");
    });
  });

  describe("FeeOracle — Chainlink safety", function () {
    it("getUSDValue reverts PriceUnavailable without feed (no silent zero)", async function () {
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      await expect(
        feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });

    it("reverts on stale Chainlink feed", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      const staleAt = BigInt(await time.latest()) - 400n;
      await (await feed.setUpdatedAt(staleAt)).wait();
      await expect(
        feeOracle.calculateFee.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "StaleChainlinkFeed");
    });

    it("rejects incomplete Chainlink round (answeredInRound < roundId)", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feed.setRoundData(5, 4)).wait();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      await expect(
        feeOracle.calculateFee.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });

    it("rejects zero updatedAt", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feed.setUpdatedAt(0)).wait();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      await expect(
        feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });
  });

  describe("OffchainPriceOracle — multi-signer", function () {
    it("requires threshold distinct signer signatures", async function () {
      const [s1, s2, s3] = await ethers.getSigners();
      const Offchain = await ethers.getContractFactory(
        "contracts/_full/core/OffchainPriceOracle.sol:OffchainPriceOracle"
      );
      const oracle = await Offchain.deploy([s1.address, s2.address, s3.address], 2);
      await oracle.waitForDeployment();

      const token = ethers.ZeroAddress;
      const price = 600n * 10n ** 8n;
      const timestamp = BigInt(await time.latest());
      const nonce = 1n;
      const domain = {
        name: "OffchainPriceOracle",
        version: "2",
        chainId: Number((await ethers.provider.getNetwork()).chainId),
        verifyingContract: await oracle.getAddress(),
      };
      const types = {
        PriceUpdate: [
          { name: "token", type: "address" },
          { name: "price", type: "uint256" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const value = { token, price, timestamp, nonce };
      const sig1 = await s1.signTypedData(domain, types, value);
      const sig2 = await s2.signTypedData(domain, types, value);
      await oracle.updatePrice(value, [sig1, sig2]);
      const [p] = await oracle.getPrice(token);
      expect(p).to.equal(price);
    });
  });

  describe("FeeOracle — offchain policy", function () {
    it("exposes OffchainForbiddenOnMainnet and allows offchain on local chainId", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      expect(feeOracle.interface.getError("OffchainForbiddenOnMainnet")).to.not.equal(undefined);

      const OffHigh = await ethers.getContractFactory(OFFCHAIN_HIGH_FQN);
      const off = await OffHigh.deploy();
      await off.waitForDeployment();
      await expect(feeOracle.connect(deployer).setOffchainOracle(await off.getAddress())).to.not.be.reverted;
    });

    it("reverts when offchain price deviates >5% from Chainlink", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();

      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();

      const OffHigh = await ethers.getContractFactory(OFFCHAIN_HIGH_FQN);
      const off = await OffHigh.deploy();
      await off.waitForDeployment();
      await (await feeOracle.connect(deployer).setOffchainOracle(await off.getAddress())).wait();

      await expect(
        feeOracle.calculateFee.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "OffchainDeviationExceeded");
    });
  });

  describe("ComplianceModule — timelock policy admin", function () {
    it("whitelist and manual block require timelock after initializeTimelock", async function () {
      const [deployer, officer] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory(MOCK_CHAINALYSIS_FQN);
      const oracle = await Oracle.deploy();
      await oracle.waitForDeployment();
      const CM = await ethers.getContractFactory("ComplianceModule");
      const cm = await CM.deploy(officer.address, await oracle.getAddress());
      await cm.waitForDeployment();

      const TLC = await ethers.getContractFactory(TLC_FQN);
      const tlc = await TLC.deploy(0, [deployer.address], [deployer.address], deployer.address);
      await tlc.waitForDeployment();
      await (await cm.initializeTimelock(await tlc.getAddress())).wait();

      const victim = ethers.Wallet.createRandom().address;
      await expect(cm.connect(officer).whitelistAddress(victim, true)).to.be.revertedWithCustomError(
        cm,
        "NotTimelock"
      );
      await expect(cm.connect(officer).blockAddress(victim, "manual")).to.be.revertedWithCustomError(
        cm,
        "NotTimelock"
      );
    });

    it("rejects EOA as Chainalysis oracle", async function () {
      const [deployer] = await ethers.getSigners();
      const CM = await ethers.getContractFactory("ComplianceModule");
      const cm = await CM.deploy(deployer.address, ethers.ZeroAddress);
      await cm.waitForDeployment();
      const eoa = ethers.Wallet.createRandom().address;
      await expect(cm.setChainalysisOracle(eoa)).to.be.revertedWith("ComplianceModule: oracle not a contract");
    });
  });

  describe("Compliance — fail-closed", function () {
    it("pool reverts withdraw when compliance module staticcall fails", async function () {
      const { deployer, pool, feeOracle } = await deployReducedBase();
      const Bad = await ethers.getContractFactory(BAD_COMPLIANCE_FQN);
      const bad = await Bad.deploy();
      await bad.waitForDeployment();
      await (await pool.setComplianceModule(await bad.getAddress())).wait();

      const recipient = deployer.address;
      const c1 = ethers.keccak256(ethers.toUtf8Bytes("m6-withdraw-compliance"));
      const inputAmount = ethers.parseEther("3");
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, {
        value: inputAmount,
      });

      const WH = await ethers.getContractFactory("WithdrawHandler");
      const wh = await WH.deploy(
        await pool.getAddress(),
        await pool.verifier(),
        await pool.thresholdVerifier(),
        await pool.feeOracle(),
        await pool.relayerRegistry()
      );
      await wh.waitForDeployment();
      await (await pool.setWithdrawHandler(await wh.getAddress())).wait();

      const { merkleProofForFirstLeaf, withdrawProtocolFee } = require("../helpers/poolFixtures.cjs");
      const { root, path, indices } = await merkleProofForFirstLeaf(c1);
      const withdrawAmount = ethers.parseEther("0.5");
      const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount);
      const changeAmount = inputAmount - withdrawAmount - protocolFee;

      const withdrawData = {
        proof: emptyProof(),
        publicInputs: {
          nullifier: ethers.keccak256(ethers.toUtf8Bytes("m6-wd-nf")),
          inputCommitment: c1,
          outputCommitmentSwap: ethers.ZeroHash,
          outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("m6-wd-ch")),
          merkleRoot: root,
          inputAssetID: 0n,
          outputAssetIDSwap: 0n,
          outputAssetIDChange: 0n,
          inputAmount,
          swapAmount: withdrawAmount,
          changeAmount,
          outputAmountSwap: 0n,
          minOutputAmountSwap: 0n,
          gasRefund: 0n,
          protocolFee,
          merklePath: path,
          merklePathIndices: indices,
        },
        recipient,
        relayer: deployer.address,
        encryptedPayload: "0x",
      };

      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.be.revertedWithCustomError(pool, "SP");
    });

    it("ComplianceModule productionMode queries Chainalysis oracle", async function () {
      const [deployer] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory(MOCK_CHAINALYSIS_FQN);
      const oracle = await Oracle.deploy();
      await oracle.waitForDeployment();
      const risky = ethers.Wallet.createRandom().address;
      await (await oracle.setAddressRisk(risky, 90, false)).wait();

      const CM = await ethers.getContractFactory("ComplianceModule");
      const cm = await CM.deploy(deployer.address, await oracle.getAddress());
      await cm.waitForDeployment();
      await (await cm.setProductionMode(true)).wait();
      await (await cm.setAuthorizedPool(deployer.address, true)).wait();

      await (await cm.checkAddress(risky)).wait();
      const score = await cm.getRiskScore(risky);
      const sanctioned = await cm.isSanctioned(risky);
      expect(score).to.equal(90n);
      expect(sanctioned).to.equal(false);
      expect(await cm.isBlocked(risky)).to.equal(true);
    });
  });

  describe("Deploy networkConfig helpers", function () {
    it("assertExpectedChainId throws on mismatch", async function () {
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      expect(() => assertExpectedChainId(chainId, chainId + 1)).to.throw(/ChainId mismatch/);
    });

    it("requireBnbUsdFeedForChain returns canonical testnet feed", function () {
      const feed = requireBnbUsdFeedForChain(97);
      expect(feed.toLowerCase()).to.equal("0x1a26d803c2e796601794f8c5609549643832702c");
    });

    it("assertOffchainOraclePolicy rejects mainnet offchain env", function () {
      expect(() =>
        assertOffchainOraclePolicy(56, "0x0000000000000000000000000000000000000001")
      ).to.throw(/must not be set on BSC mainnet/);
    });

    it("assertProductionNetworkBinding requires EXPECTED_CHAIN_ID for production profile", async function () {
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      const prev = process.env.EXPECTED_CHAIN_ID;
      delete process.env.EXPECTED_CHAIN_ID;
      try {
        expect(() => assertProductionNetworkBinding(chainId, "production")).to.throw(
          /EXPECTED_CHAIN_ID is required/
        );
      } finally {
        if (prev !== undefined) process.env.EXPECTED_CHAIN_ID = prev;
      }
    });

    it("assertExperimentalDeployBlocked rejects experimental flags on production profile", function () {
      expect(() =>
        assertExperimentalDeployBlocked({
          DEPLOY_PROFILE: "production",
          DEPLOY_DARK_POOL: "true",
        })
      ).to.throw(/DEPLOY_DARK_POOL=true forbidden/);
      expect(() =>
        assertExperimentalDeployBlocked({ DEPLOY_PROFILE: "dev", DEPLOY_DARK_POOL: "true" })
      ).to.not.throw();
    });
  });
});
