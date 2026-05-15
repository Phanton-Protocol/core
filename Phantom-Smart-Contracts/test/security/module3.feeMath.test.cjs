/**
 * Module 3 — canonical fee math, decimals, gas-refund cap, reward accounting.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  authorizeTestFeeDistributor,
} = require("../helpers/reducedProduction.cjs");
const { merkleProofForFirstLeaf, totalJoinSplitFeeBnb } = require("../helpers/poolFixtures.cjs");
const { joinSplitSwapDataDummyAttestation } = require("../helpers/relayerSwapAttestation.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";
const PFM_HARNESS_FQN = "contracts/_full/test/ProtocolFeeMathHarness.sol:ProtocolFeeMathHarness";
const MOCK_AGG_FQN = "contracts/_full/mocks/MockChainlinkAggregator.sol:MockChainlinkAggregator";
const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const OFFCHAIN_STUB_FQN = "contracts/_full/mocks/FixedBnbUsdOffchainStub.sol:FixedBnbUsdOffchainStub";

describe("Module 3 — fee math & precision", function () {
  describe("ProtocolFeeMath / FeeOracle", function () {
    it("percentageFeeUsd: 0.5% of $1000 = $5", async function () {
      const Lib = await ethers.getContractFactory(PFM_HARNESS_FQN);
      const lib = await Lib.deploy();
      await lib.waitForDeployment();
      const usd1000 = 1000n * 10n ** 8n;
      expect(await lib.percentageFeeUsd(usd1000)).to.equal(5n * 10n ** 8n);
    });

    it("feeUsdFromNotionalUsd: floor $2 wins for small notionals", async function () {
      const Lib = await ethers.getContractFactory(PFM_HARNESS_FQN);
      const lib = await Lib.deploy();
      await lib.waitForDeployment();
      const usd10 = 10n * 10n ** 8n;
      expect(await lib.feeUsdFromNotionalUsd(usd10)).to.equal(2n * 10n ** 8n);
    });

    it("feeUsdFromNotionalUsd: 0.5% wins above floor boundary", async function () {
      const Lib = await ethers.getContractFactory(PFM_HARNESS_FQN);
      const lib = await Lib.deploy();
      await lib.waitForDeployment();
      const usd500 = 500n * 10n ** 8n;
      expect(await lib.feeUsdFromNotionalUsd(usd500)).to.equal((500n * 10n ** 8n * 50n) / 10000n);
    });

    it("calculateFee uses 0.5% + $2 floor on BNB (Chainlink $600)", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await agg.deploy(300n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();

      const oneBnb = ethers.parseEther("1");
      const fee = await feeOracle.calculateFee.staticCall(ethers.ZeroAddress, oneBnb);
      const usd = await feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, oneBnb);
      expect(usd).to.equal(300n * 10n ** 8n);
      const minFeeBnb = await feeOracle.getTokenAmountForUSD.staticCall(ethers.ZeroAddress, 2n * 10n ** 8n);
      expect(fee).to.equal(minFeeBnb);
    });

    it("off-chain and Chainlink branches agree on USD value for BNB", async function () {
      const [deployer] = await ethers.getSigners();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();

      const agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await agg.deploy(600n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      const chainUsd = await feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, ethers.parseEther("2"));

      const stub = await ethers.getContractFactory(OFFCHAIN_STUB_FQN);
      const off = await stub.deploy();
      await off.waitForDeployment();
      await (await feeOracle.connect(deployer).setOffchainOracle(await off.getAddress())).wait();
      const offUsd = await feeOracle.getUSDValue.staticCall(ethers.ZeroAddress, ethers.parseEther("2"));

      expect(offUsd).to.equal(chainUsd);
    });
  });

  describe("WithdrawHandler — 6-decimal ERC20", function () {
    it("requires exact protocolFee from oracle (no 18-decimal hardcode)", async function () {
      const [deployer] = await ethers.getSigners();
      const MockVerifier = await ethers.getContractFactory("MockVerifier");
      const v1 = await MockVerifier.deploy();
      const v2 = await MockVerifier.deploy();
      await v1.waitForDeployment();
      await v2.waitForDeployment();

      const MockSwapAdaptor = await ethers.getContractFactory("contracts/_full/mocks/MockSwapAdaptor.sol:MockSwapAdaptor");
      const swapAdaptor = await MockSwapAdaptor.deploy();
      await swapAdaptor.waitForDeployment();

      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();

      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      await usdc.waitForDeployment();
      const tokenAddr = await usdc.getAddress();

      const agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await agg.deploy(1n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(tokenAddr, await feed.getAddress())).wait();

      const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
      const relayerRegistry = await RelayerRegistry.deploy();
      await relayerRegistry.waitForDeployment();

      const pool = await deployBehindProxy(REDUCED_FQN, [
        await v1.getAddress(),
        await v2.getAddress(),
        await swapAdaptor.getAddress(),
        await feeOracle.getAddress(),
        await relayerRegistry.getAddress(),
      ]);

      await allowlistAndRegisterAsset(pool, deployer, 1n, usdc);

      const WH = await ethers.getContractFactory("WithdrawHandler");
      const wh = await WH.deploy(
        await pool.getAddress(),
        await v1.getAddress(),
        await v2.getAddress(),
        await feeOracle.getAddress(),
        await relayerRegistry.getAddress()
      );
      await wh.waitForDeployment();
      await (await pool.connect(deployer).setWithdrawHandler(await wh.getAddress())).wait();

      const inputAmount = 10_000_000n;
      const expectedFee = await feeOracle.calculateFee.staticCall(tokenAddr, inputAmount);
      expect(expectedFee).to.be.gt(0n);

      const withdrawAmount = 5_000_000n;
      const underpaidFee = expectedFee - 1n;
      const changeAmount = inputAmount - withdrawAmount - underpaidFee;

      const publicInputs = {
        nullifier: ethers.ZeroHash,
        inputCommitment: ethers.keccak256(ethers.toUtf8Bytes("wd-6dec")),
        outputCommitmentSwap: ethers.ZeroHash,
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("ch-6dec")),
        merkleRoot: ethers.ZeroHash,
        inputAssetID: 1n,
        outputAssetIDSwap: 0n,
        outputAssetIDChange: 1n,
        inputAmount,
        swapAmount: withdrawAmount,
        changeAmount,
        outputAmountSwap: 0n,
        minOutputAmountSwap: 0n,
        gasRefund: 0n,
        protocolFee: underpaidFee,
        merklePath: Array(10).fill(0n),
        merklePathIndices: Array(10).fill(0n),
      };

      const poolAddr = await pool.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [poolAddr]);
      await ethers.provider.send("hardhat_setBalance", [poolAddr, "0x1000000000000000000"]);
      const poolSigner = await ethers.getSigner(poolAddr);

      const pfm = await (await ethers.getContractFactory(PFM_HARNESS_FQN)).deploy();
      await pfm.waitForDeployment();

      await expect(
        wh.connect(poolSigner).processWithdraw({
          proof: { a: "0x", b: "0x", c: "0x" },
          publicInputs,
          recipient: deployer.address,
          relayer: ethers.ZeroAddress,
          encryptedPayload: "0x",
        })
      ).to.be.revertedWithCustomError(pfm, "ProtocolFeeMismatch");
    });
  });

  describe("ShieldedPoolUpgradeableReduced join-split fee gate", function () {
    async function deployReduced() {
      const [deployer] = await ethers.getSigners();
      const MockVerifier = await ethers.getContractFactory("MockVerifier");
      const v1 = await MockVerifier.deploy();
      const v2 = await MockVerifier.deploy();
      await v1.waitForDeployment();
      await v2.waitForDeployment();
      const MockSwapAdaptor = await ethers.getContractFactory("contracts/_full/mocks/MockSwapAdaptor.sol:MockSwapAdaptor");
      const swapAdaptor = await MockSwapAdaptor.deploy();
      await swapAdaptor.waitForDeployment();
      const FeeOracle = await ethers.getContractFactory("FeeOracle");
      const feeOracle = await FeeOracle.deploy();
      await feeOracle.waitForDeployment();
      const agg = await ethers.getContractFactory(MOCK_AGG_FQN);
      const feed = await agg.deploy(300n * 10n ** 8n);
      await feed.waitForDeployment();
      await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();
      const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
      const relayerRegistry = await RelayerRegistry.deploy();
      await relayerRegistry.waitForDeployment();
      await (await relayerRegistry.registerRelayer(deployer.address)).wait();
      const pool = await deployBehindProxy(REDUCED_FQN, [
        await v1.getAddress(),
        await v2.getAddress(),
        await swapAdaptor.getAddress(),
        await feeOracle.getAddress(),
        await relayerRegistry.getAddress(),
      ]);
      return { deployer, pool, feeOracle, swapAdaptor };
    }

    it("reverts join-split when protocolFee is underpaid", async function () {
      const { deployer, pool, feeOracle } = await deployReduced();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const outTok = await MockERC20.deploy("O", "O", 18);
      await outTok.waitForDeployment();
      const outAddr = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);

      const inputAmount = ethers.parseEther("25");
      const swapAmt = ethers.parseEther("5");
      const correctPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
      const c1 = ethers.keccak256(ethers.toUtf8Bytes("m3-underpay"));
      await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, { value: inputAmount });
      const root = await pool.merkleRoot();
      const { path, indices } = await merkleProofForFirstLeaf(c1);

      const badPf = correctPf > 0n ? correctPf - 1n : 0n;
      const changeAmount = inputAmount - swapAmt - badPf;

      const pfm = await (await ethers.getContractFactory(PFM_HARNESS_FQN)).deploy();
      await pfm.waitForDeployment();

      const swapTx = await buildReducedJoinSplitTx(
        pool,
        deployer,
        {
          nullifier: ethers.ZeroHash,
          inputCommitment: c1,
          outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("a")),
          outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("b")),
          merkleRoot: root,
          inputAssetID: 0n,
          outputAssetIDSwap: 1n,
          outputAssetIDChange: 0n,
          inputAmount,
          swapAmount: swapAmt,
          changeAmount,
          outputAmountSwap: swapAmt,
          minOutputAmountSwap: swapAmt,
          gasRefund: 0n,
          protocolFee: badPf,
          merklePath: path,
          merklePathIndices: indices,
        },
        outAddr
      );
      await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapTx)).to.be.revertedWithCustomError(
        pfm,
        "ProtocolFeeMismatch"
      );
    });

    it("reverts when gasRefund exceeds cap", async function () {
      const Lib = await ethers.getContractFactory(PFM_HARNESS_FQN);
      const lib = await Lib.deploy();
      await lib.waitForDeployment();
      const cap = await lib.maxGasRefundWei();
      const inputAmount = cap + 1n;
      await expect(
        lib.requireGasRefundBounded.staticCall(inputAmount, inputAmount)
      ).to.be.revertedWithCustomError(lib, "GasRefundExceedsCap");
    });
  });

  describe("RelayerStaking — zero-stake rewards", function () {
    it("carries fees forward when totalStaked == 0, then credits stakers", async function () {
      const [a, b] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), ethers.parseEther("1"));
      await rs.waitForDeployment();
      await authorizeTestFeeDistributor(rs, a.address, a);

      await rs.connect(a).distributeFee(ethers.ZeroAddress, ethers.parseEther("1"), { value: ethers.parseEther("1") });
      expect(await rs.unallocatedRewards(ethers.ZeroAddress)).to.equal(ethers.parseEther("1"));

      await shdw.mint(b.address, ethers.parseEther("10"));
      await shdw.connect(b).approve(await rs.getAddress(), ethers.MaxUint256);
      await rs.connect(b).stake(ethers.parseEther("2"));

      expect(await rs.unallocatedRewards(ethers.ZeroAddress)).to.equal(0n);
      const pending = await rs.pendingReward(b.address, ethers.ZeroAddress);
      expect(pending).to.be.gt(0n);
    });

    it("keeps rounding dust in unallocatedRewards (not lost)", async function () {
      const [a, b] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
      const shdw = await MockERC20.deploy("SHDW", "SHDW", 18);
      await shdw.waitForDeployment();
      const RS = await ethers.getContractFactory("RelayerStaking");
      const rs = await RS.deploy(await shdw.getAddress(), ethers.parseEther("1"));
      await rs.waitForDeployment();
      await authorizeTestFeeDistributor(rs, a.address, a);

      await shdw.mint(b.address, ethers.parseEther("10"));
      await shdw.connect(b).approve(await rs.getAddress(), ethers.MaxUint256);
      const stakeAmt = ethers.parseEther("3");
      await rs.connect(b).stake(stakeAmt);

      const odd = ethers.parseEther("7");
      await rs.connect(a).distributeFee(ethers.ZeroAddress, odd, { value: odd });
      const dust = await rs.unallocatedRewards(ethers.ZeroAddress);
      expect(dust).to.be.gt(0n);
      expect(dust).to.be.lt(odd);
    });
  });
});
