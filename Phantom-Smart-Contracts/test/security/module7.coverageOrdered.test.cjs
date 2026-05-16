/**
 * Module 7 — ordered missing coverage (Hardhat / Chai).
 * Run: HH_FULL=1 npx hardhat test test/security/module7.coverageOrdered.test.cjs
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const {
  initFeeOracleForTests,
  authorizeTestFeeDistributor,
  buildReducedJoinSplitTx,
} = require("../helpers/reducedProduction.cjs");
const {
  merkleProofForFirstLeaf,
  withdrawProtocolFee,
  emptyProof,
  wireDefaultBnbFeed,
} = require("../helpers/poolFixtures.cjs");
const {
  assertExpectedChainId,
  assertOffchainOraclePolicy,
  assertProductionNetworkBinding,
  requireBnbUsdFeedForChain,
  BSC_TESTNET,
} = require("../helpers/networkConfigAssertions.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const TLC_FQN = "contracts/_full/governance/TimelockController.sol:TimelockController";
const MOCK_AGG_FQN = "contracts/_full/mocks/MockChainlinkAggregator.sol:MockChainlinkAggregator";
const MOCK_CHAINALYSIS_FQN = "contracts/_full/mocks/MockChainalysisOracle.sol:MockChainalysisOracle";
const OFFCHAIN_FQN = "contracts/_full/core/OffchainPriceOracle.sol:OffchainPriceOracle";

async function deployRelayerStakingFixture() {
  const [owner, staker, distributor] = await ethers.getSigners();
  const Proto = await ethers.getContractFactory("ProtocolToken");
  const token = await Proto.deploy(owner.address);
  await token.waitForDeployment();
  const RS = await ethers.getContractFactory("RelayerStaking");
  const rs = await RS.deploy(await token.getAddress(), ethers.parseEther("100"));
  await rs.waitForDeployment();
  await authorizeTestFeeDistributor(rs, distributor.address, owner);
  const stakeAmt = ethers.parseEther("1000");
  await (await token.transfer(staker.address, stakeAmt * 2n)).wait();
  await (await token.connect(staker).approve(await rs.getAddress(), ethers.MaxUint256)).wait();
  return { owner, staker, distributor, token, rs, stakeAmt };
}

async function deployReducedPausedFixture() {
  const [deployer, emergency, relayer] = await ethers.getSigners();
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
  await (await r.registerRelayer(relayer.address)).wait();

  const pool = await deployBehindProxy(REDUCED_FQN, [
    await v1.getAddress(),
    await v2.getAddress(),
    await a.getAddress(),
    await f.getAddress(),
    await r.getAddress(),
  ]);

  const WH = await ethers.getContractFactory("WithdrawHandler");
  const wh = await WH.deploy(
    await pool.getAddress(),
    await v1.getAddress(),
    await v2.getAddress(),
    await f.getAddress(),
    await r.getAddress()
  );
  await wh.waitForDeployment();
  await (await pool.setWithdrawHandler(await wh.getAddress())).wait();

  const TLC = await ethers.getContractFactory(TLC_FQN);
  const tlc = await TLC.deploy(0, [deployer.address], [deployer.address], deployer.address);
  await tlc.waitForDeployment();
  await (await pool.initializeV2(await tlc.getAddress(), emergency.address)).wait();

  return { deployer, emergency, relayer, pool, feeOracle: f };
}

async function signOffchainUpdate(oracle, signers, value) {
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
  const sigs = [];
  for (const s of signers) {
    sigs.push(await s.signTypedData(domain, types, value));
  }
  return sigs;
}

function buildWithdrawData(feeOracle, commitment, inputAmount, deployer, recipient) {
  return merkleProofForFirstLeaf(commitment).then(({ root, path, indices }) => {
    const withdrawAmount = ethers.parseEther("0.5");
    return withdrawProtocolFee(feeOracle, ethers.ZeroAddress, inputAmount).then((protocolFee) => {
      const changeAmount = inputAmount - withdrawAmount - protocolFee;
      return {
        proof: emptyProof(),
        publicInputs: {
          nullifier: ethers.keccak256(ethers.toUtf8Bytes(`m7-wd-${commitment}`)),
          inputCommitment: commitment,
          outputCommitmentSwap: ethers.ZeroHash,
          outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes(`m7-ch-${commitment}`)),
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
        recipient: recipient || deployer.address,
        relayer: deployer.address,
        encryptedPayload: "0x",
      };
    });
  });
}

describe("Module 7 — ordered coverage", function () {
  // ─── 1. RelayerStaking exit / claim lifecycle ─────────────────────────────
  describe("1. RelayerStaking exit / claim lifecycle", function () {
    it("stake → distributeFee → claim pays net rewards", async function () {
      const { staker, distributor, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      const fee = ethers.parseEther("10");
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, fee, { value: fee })).wait();
      const pending = await rs.pendingReward(staker.address, ethers.ZeroAddress);
      expect(pending).to.be.gt(0n);
      const balBefore = await ethers.provider.getBalance(staker.address);
      await (await rs.connect(staker).claim(ethers.ZeroAddress)).wait();
      const balAfter = await ethers.provider.getBalance(staker.address);
      expect(balAfter).to.be.gt(balBefore);
      expect(await rs.pendingReward(staker.address, ethers.ZeroAddress)).to.equal(0n);
    });

    it("stake → distributeFee → unstake returns principal", async function () {
      const { staker, distributor, token, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, ethers.parseEther("1"), { value: ethers.parseEther("1") })).wait();
      const balBefore = await token.balanceOf(staker.address);
      await (await rs.connect(staker).unstake(stakeAmt)).wait();
      expect(await token.balanceOf(staker.address)).to.equal(balBefore + stakeAmt);
      expect(await rs.stakedBalance(staker.address)).to.equal(0n);
    });

    it("partial unstake leaves remainder staked", async function () {
      const { staker, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      const partial = stakeAmt / 4n;
      await (await rs.connect(staker).unstake(partial)).wait();
      expect(await rs.stakedBalance(staker.address)).to.equal(stakeAmt - partial);
      expect(await rs.totalStaked()).to.equal(stakeAmt - partial);
    });

    it("rewardDebt correct after additional stake (no sniping prior rewards)", async function () {
      const { staker, distributor, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, ethers.parseEther("5"), { value: ethers.parseEther("5") })).wait();
      const accBefore = await rs.accRewardPerShare(ethers.ZeroAddress);
      await (await rs.connect(staker).stake(ethers.parseEther("100"))).wait();
      const pending = await rs.pendingReward(staker.address, ethers.ZeroAddress);
      expect(pending).to.equal(0n);
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, ethers.parseEther("2"), { value: ethers.parseEther("2") })).wait();
      expect(await rs.accRewardPerShare(ethers.ZeroAddress)).to.be.gt(accBefore);
      expect(await rs.pendingReward(staker.address, ethers.ZeroAddress)).to.be.gt(0n);
    });

    it("repeated claim is idempotent when nothing pending", async function () {
      const { staker, distributor, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, ethers.parseEther("1"), { value: ethers.parseEther("1") })).wait();
      await (await rs.connect(staker).claim(ethers.ZeroAddress)).wait();
      await expect(rs.connect(staker).claim(ethers.ZeroAddress)).to.not.be.reverted;
    });

    it("authorized slash only; slash cannot exceed balance", async function () {
      const [, staker, attacker] = await ethers.getSigners();
      const { owner, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      await expect(rs.connect(attacker).slash(staker.address, 1n)).to.be.revertedWith("RelayerStaking: not slasher");
      await (await rs.setSlasher(owner.address, true)).wait();
      await expect(rs.connect(owner).slash(staker.address, stakeAmt + 1n)).to.be.revertedWith(
        "RelayerStaking: insufficient balance to slash"
      );
      await (await rs.connect(owner).slash(staker.address, ethers.parseEther("50"))).wait();
      expect(await rs.stakedBalance(staker.address)).to.equal(stakeAmt - ethers.parseEther("50"));
    });
  });

  // ─── 2. Emergency pause matrix ────────────────────────────────────────────
  describe("2. Emergency pause matrix", function () {
    it("deposit and depositForBNB blocked while paused; unpause restores deposit", async function () {
      const { deployer, emergency, pool } = await deployReducedPausedFixture();
      const amount = ethers.parseEther("1");
      const c = ethers.keccak256(ethers.toUtf8Bytes("m7-pause-dep"));
      await (await pool.connect(emergency).pauseEmergency()).wait();
      await expect(
        pool.connect(deployer).deposit(ethers.ZeroAddress, amount, c, 0n, { value: amount })
      ).to.be.revertedWithCustomError(pool, "EmergencyPausedErr");
      await expect(
        pool.connect(deployer).depositForBNB(deployer.address, c, 0n, { value: amount })
      ).to.be.revertedWithCustomError(pool, "EmergencyPausedErr");
      await (await pool.connect(deployer).unpauseEmergency()).wait();
      await expect(
        pool.connect(deployer).deposit(ethers.ZeroAddress, amount, c, 0n, { value: amount })
      ).to.emit(pool, "Deposit");
    });

    it("sweepGasReserveNative blocked while paused", async function () {
      const { deployer, emergency, pool } = await deployReducedPausedFixture();
      await (await pool.connect(deployer).deposit(ethers.ZeroAddress, ethers.parseEther("1"), ethers.keccak256(ethers.toUtf8Bytes("m7-sweep")), 0n, {
        value: ethers.parseEther("1"),
      })).wait();
      await (await pool.connect(emergency).pauseEmergency()).wait();
      await expect(
        pool.connect(emergency).sweepGasReserveNative(deployer.address, 0n)
      ).to.be.revertedWithCustomError(pool, "EmergencyPausedErr");
    });

    it("commitSwap blocked while emergency paused", async function () {
      const { deployer, emergency, pool } = await deployReducedPausedFixture();
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m7-pause-commit"));
      const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 3600n;
      await (await pool.connect(emergency).pauseEmergency()).wait();
      await expect(pool.connect(deployer).commitSwap(commitment, deadline)).to.be.revertedWithCustomError(
        pool,
        "EmergencyPausedErr"
      );
    });
  });

  // ─── 3. Offchain oracle edge cases ────────────────────────────────────────
  describe("3. Offchain oracle edge cases", function () {
    async function deployOffchain() {
      const [s1, s2] = await ethers.getSigners();
      const Offchain = await ethers.getContractFactory(OFFCHAIN_FQN);
      const oracle = await Offchain.deploy([s1.address, s2.address], 2);
      await oracle.waitForDeployment();
      return { s1, s2, oracle };
    }

    it("stale signed price reverts", async function () {
      const { s1, s2, oracle } = await deployOffchain();
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 700n;
      const value = { token: ethers.ZeroAddress, price: 600n * 10n ** 8n, timestamp: ts, nonce: 1n };
      const sigs = await signOffchainUpdate(oracle, [s1, s2], value);
      await expect(oracle.updatePrice(value, sigs)).to.be.revertedWith("OffchainPriceOracle: stale price");
    });

    it("replayed nonce reverts", async function () {
      const { s1, s2, oracle } = await deployOffchain();
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const value = { token: ethers.ZeroAddress, price: 600n * 10n ** 8n, timestamp: ts, nonce: 7n };
      const sigs = await signOffchainUpdate(oracle, [s1, s2], value);
      await oracle.updatePrice(value, sigs);
      await expect(oracle.updatePrice(value, sigs)).to.be.revertedWith("OffchainPriceOracle: nonce used");
    });

    it("single signature fails when threshold is 2-of-N", async function () {
      const { s1, s2, oracle } = await deployOffchain();
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const value = { token: ethers.ZeroAddress, price: 500n * 10n ** 8n, timestamp: ts, nonce: 2n };
      const sig1 = await signOffchainUpdate(oracle, [s1], value);
      await expect(oracle.updatePrice(value, sig1)).to.be.revertedWith("OffchainPriceOracle: insufficient sigs");
    });

    it("valid multi-signature update succeeds", async function () {
      const { s1, s2, oracle } = await deployOffchain();
      const ts = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const value = { token: ethers.ZeroAddress, price: 700n * 10n ** 8n, timestamp: ts, nonce: 3n };
      const sigs = await signOffchainUpdate(oracle, [s1, s2], value);
      await oracle.updatePrice(value, sigs);
      const [p] = await oracle.getPrice(ethers.ZeroAddress);
      expect(p).to.equal(700n * 10n ** 8n);
    });

    it("mainnet offchain policy: deploy guard + FeeOracle OffchainForbiddenOnMainnet error", async function () {
      expect(() =>
        assertOffchainOraclePolicy(56, "0x0000000000000000000000000000000000000001")
      ).to.throw(/must not be set on BSC mainnet/);
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
      await feeOracle.waitForDeployment();
      expect(feeOracle.interface.getError("OffchainForbiddenOnMainnet")).to.not.equal(undefined);
    });
  });

  // ─── 4. FeeOracle / Chainlink failure behavior ────────────────────────────
  describe("4. FeeOracle / Chainlink failure behavior", function () {
    it("answeredInRound < roundId → PriceUnavailable", async function () {
      const [deployer] = await ethers.getSigners();
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
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

    it("updatedAt == 0 → PriceUnavailable", async function () {
      const [deployer] = await ethers.getSigners();
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
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

    it("stale feed timestamp → StaleChainlinkFeed", async function () {
      const [deployer] = await ethers.getSigners();
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
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

    it("negative feed answer → PriceUnavailable", async function () {
      const [deployer] = await ethers.getSigners();
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
      await feeOracle.waitForDeployment();
      const Agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await Agg.deploy(-1n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      await expect(
        feeOracle.calculateFee.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });

    it("missing feed → PriceUnavailable", async function () {
      const feeOracle = await (await ethers.getContractFactory("FeeOracle")).deploy();
      await feeOracle.waitForDeployment();
      await expect(
        feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(feeOracle, "PriceUnavailable");
    });
  });

  // ─── 5. Compliance batch happy path ───────────────────────────────────────
  describe("5. Compliance batch happy path", function () {
    it("batchCheckAddresses matches two single checkAddress calls; oversized batch reverts", async function () {
      const [deployer] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory(MOCK_CHAINALYSIS_FQN);
      const oracle = await Oracle.deploy();
      await oracle.waitForDeployment();
      const a = ethers.Wallet.createRandom().address;
      const b = ethers.Wallet.createRandom().address;
      await (await oracle.setAddressRisk(a, 90, false)).wait();
      await (await oracle.setAddressRisk(b, 10, false)).wait();

      const CM = await ethers.getContractFactory("ComplianceModule");
      const cm = await CM.deploy(deployer.address, await oracle.getAddress());
      await cm.waitForDeployment();
      await (await cm.setProductionMode(true)).wait();
      await (await cm.setAuthorizedPool(deployer.address, true)).wait();

      await (await cm.checkAddress(a)).wait();
      const scoreA1 = await cm.getRiskScore(a);
      const blockedA1 = await cm.isBlocked(a);

      await (await cm.checkAddress(b)).wait();
      const scoreB1 = await cm.getRiskScore(b);
      const blockedB1 = await cm.isBlocked(b);

      const c2 = ethers.Wallet.createRandom().address;
      const d2 = ethers.Wallet.createRandom().address;
      await (await oracle.setAddressRisk(c2, 90, false)).wait();
      await (await oracle.setAddressRisk(d2, 10, false)).wait();
      await (await cm.batchCheckAddresses([c2, d2])).wait();

      expect(await cm.getRiskScore(c2)).to.equal(90n);
      expect(await cm.isBlocked(c2)).to.equal(blockedA1);
      expect(await cm.getRiskScore(d2)).to.equal(10n);
      expect(await cm.isBlocked(d2)).to.equal(blockedB1);

      const addrs = Array.from({ length: 51 }, () => ethers.Wallet.createRandom().address);
      await expect(cm.batchCheckAddresses(addrs)).to.be.revertedWith("ComplianceModule: batch too large");
    });
  });

  // ─── 6. Withdraw and swap under pause ─────────────────────────────────────
  describe("6. Withdraw and swap under pause", function () {
    it("shieldedWithdraw and shieldedSwapJoinSplit blocked while paused", async function () {
      const { deployer, emergency, relayer, pool, feeOracle } = await deployReducedPausedFixture();
      const RR = await ethers.getContractAt("RelayerRegistry", await pool.relayerRegistry());
      await (await RR.registerRelayer(deployer.address)).wait();
      const inputAmount = ethers.parseEther("2");
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m7-pause-wd"));
      await (await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      })).wait();

      const withdrawData = await buildWithdrawData(feeOracle, commitment, inputAmount, deployer);
      const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
      const swapData = await buildReducedJoinSplitTx(pool, relayer, {
        nullifier: ethers.keccak256(ethers.toUtf8Bytes("m7-pause-js")),
        inputCommitment: commitment,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("m7-pause-out")),
        outputCommitmentChange: ethers.ZeroHash,
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: 0n,
        changeAmount: inputAmount,
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund: 0n,
        protocolFee: 0n,
        merklePath: path,
        merklePathIndices: indices,
      }, ethers.ZeroAddress);

      await (await pool.connect(emergency).pauseEmergency()).wait();

      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.be.revertedWithCustomError(
        pool,
        "EmergencyPausedErr"
      );
      await expect(pool.connect(relayer).shieldedSwapJoinSplit(swapData)).to.be.revertedWithCustomError(
        pool,
        "EmergencyPausedErr"
      );

      await (await pool.connect(deployer).unpauseEmergency()).wait();
      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.not.be.revertedWithCustomError(
        pool,
        "EmergencyPausedErr"
      );
    });
  });

  // ─── 7. Misconfiguration guards ─────────────────────────────────────────
  describe("7. Misconfiguration guards", function () {
    it("wrong chainId and offchain policy helpers reject misconfiguration", async function () {
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      expect(() => assertExpectedChainId(chainId, chainId + 1)).to.throw(/ChainId mismatch/);
      expect(() => assertOffchainOraclePolicy(56, "0x0000000000000000000000000000000000000001")).to.throw(
        /must not be set on BSC mainnet/
      );
      const prev = process.env.EXPECTED_CHAIN_ID;
      delete process.env.EXPECTED_CHAIN_ID;
      try {
        expect(() => assertProductionNetworkBinding(chainId, "production")).to.throw(/EXPECTED_CHAIN_ID/);
      } finally {
        if (prev !== undefined) process.env.EXPECTED_CHAIN_ID = prev;
      }
    });

    it("canonical testnet feed constant matches book", function () {
      expect(requireBnbUsdFeedForChain(97).toLowerCase()).to.equal(BSC_TESTNET.bnbUsdFeed.toLowerCase());
    });

    it("PancakeSwapAdaptor has no setRouter; bootstrap owner sets pool handler", async function () {
      const [deployer] = await ethers.getSigners();
      const router = ethers.Wallet.createRandom().address;
      const wbnb = ethers.Wallet.createRandom().address;
      const Pancake = await ethers.getContractFactory("PancakeSwapAdaptor");
      const adaptor = await Pancake.deploy(router, wbnb);
      await adaptor.waitForDeployment();
      expect(adaptor.setRouter).to.equal(undefined);

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
      const WH2 = await ethers.getContractFactory("WithdrawHandler");
      const wh2 = await WH2.deploy(
        await pool.getAddress(),
        await v1.getAddress(),
        await v2.getAddress(),
        await f.getAddress(),
        await r.getAddress()
      );
      await wh2.waitForDeployment();
      await (await pool.connect(deployer).setWithdrawHandler(await wh2.getAddress())).wait();
      expect(await pool.withdrawHandler()).to.equal(await wh2.getAddress());
    });

    it("integration mutation blocked for owner after initializeV2", async function () {
      const { deployer, pool } = await deployReducedPausedFixture();
      const F2 = await ethers.getContractFactory("FeeOracle");
      const f2 = await F2.deploy();
      await f2.waitForDeployment();
      await initFeeOracleForTests(f2, deployer);
      await expect(pool.connect(deployer).setFeeOracle(await f2.getAddress())).to.be.revertedWithCustomError(
        pool,
        "NotTimelock"
      );
    });
  });

  // ─── 8. Optional lightweight invariant / stress checks ────────────────────
  describe("8. Optional lightweight invariant / stress checks", function () {
    it("RelayerStaking totalStaked matches token balance held", async function () {
      const { staker, distributor, token, rs, stakeAmt } = await deployRelayerStakingFixture();
      await (await rs.connect(staker).stake(stakeAmt)).wait();
      await (await rs.connect(distributor).distributeFee(ethers.ZeroAddress, ethers.parseEther("3"), { value: ethers.parseEther("3") })).wait();
      const total = await rs.totalStaked();
      const bal = await token.balanceOf(await rs.getAddress());
      expect(bal).to.be.gte(total);
      expect(total).to.equal(await rs.stakedBalance(staker.address));
    });

    it("deposit → withdraw cycle preserves nullifier conservation", async function () {
      const { deployer, pool, feeOracle } = await deployReducedPausedFixture();
      const RR = await ethers.getContractAt("RelayerRegistry", await pool.relayerRegistry());
      await (await RR.registerRelayer(deployer.address)).wait();
      const inputAmount = ethers.parseEther("2");
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("m7-inv-wd"));
      const countBefore = await pool.getCommitmentCount();
      await (await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, {
        value: inputAmount,
      })).wait();
      expect(await pool.getCommitmentCount()).to.equal(countBefore + 1n);

      const withdrawData = await buildWithdrawData(feeOracle, commitment, inputAmount, deployer);
      const nf = withdrawData.publicInputs.nullifier;
      expect(await pool.nullifiers(nf)).to.equal(false);
      await pool.connect(deployer).shieldedWithdraw(withdrawData);
      expect(await pool.nullifiers(nf)).to.equal(true);
      await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.be.reverted;
    });
  });
});
