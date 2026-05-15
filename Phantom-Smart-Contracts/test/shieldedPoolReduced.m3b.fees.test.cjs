const { expect } = require("chai");
const { ethers } = require("hardhat");
const { merkleProofForFirstLeaf, totalJoinSplitFeeBnb } = require("./helpers/poolFixtures.cjs");
const { joinSplitSwapDataDummyAttestation } = require("./helpers/relayerSwapAttestation.cjs");
const { deployBehindProxy } = require("./helpers/proxyDeploy.cjs");
const { allowlistAndRegisterAsset } = require("./helpers/reducedProduction.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";
const MOCK_AGG_FQN = "contracts/_full/mocks/MockChainlinkAggregator.sol:MockChainlinkAggregator";

async function deployReducedM3bFixture() {
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

  return { deployer, pool, feeOracle };
}

describe("ShieldedPoolUpgradeableReduced — M3b fees (10 bps, $2 deposit, protocolFee match)", function () {
  it("exposes DEX swap fee as 10 bps", async function () {
    const { pool } = await deployReducedM3bFixture();
    expect(await pool.DEX_SWAP_FEE_BPS()).to.equal(10n);
    expect(await pool.BPS_DENOMINATOR()).to.equal(10000n);
  });

  it("reduced join-split: reverts when protocolFee exceeds oracle-required fee", async function () {
    const { deployer, pool, feeOracle } = await deployReducedM3bFixture();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("O", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await allowlistAndRegisterAsset(pool, deployer, 1n, outTok);

    const c1 = ethers.keccak256(ethers.toUtf8Bytes("m3b-fee-leaf"));
    const inputAmount = ethers.parseEther("25");
    const swapAmt = ethers.parseEther("5");
    const correctPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);

    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, {
      value: inputAmount,
    });

    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);
    const badPf = correctPf + 1n;
    const changeForBad = inputAmount - swapAmt - badPf;

    const publicInputs = {
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
      changeAmount: changeForBad,
      outputAmountSwap: swapAmt,
      minOutputAmountSwap: 0n,
      gasRefund: 0n,
      protocolFee: badPf,
      merklePath: path,
      merklePathIndices: indices,
    };

    const pfm = await (
      await ethers.getContractFactory("contracts/_full/test/ProtocolFeeMathHarness.sol:ProtocolFeeMathHarness")
    ).deploy();
    await pfm.waitForDeployment();

    await expect(
      pool.connect(deployer).shieldedSwapJoinSplit({
        proof: { a: "0x", b: "0x", c: "0x" },
        publicInputs,
        swapParams: {
          tokenIn: ethers.ZeroAddress,
          tokenOut: outAddr,
          amountIn: swapAmt,
          minAmountOut: 0n,
          fee: 0,
          sqrtPriceLimitX96: 0n,
          path: "0x",
        },
        relayer: ethers.ZeroAddress,
        commitment: ethers.ZeroHash,
        deadline: 0n,
        nonce: 0n,
        encryptedPayload: "0x",
        ...joinSplitSwapDataDummyAttestation(),
      })
    ).to.be.revertedWithCustomError(pfm, "ProtocolFeeMismatch");
  });

  it("reverts deposit when BNB fee USD value is below $2 (mock oracle)", async function () {
    const { deployer, pool, feeOracle } = await deployReducedM3bFixture();

    const agg = await ethers.getContractFactory(MOCK_AGG_FQN);
    const feed = await agg.deploy(300 * 10 ** 8);
    await feed.waitForDeployment();
    await (await feeOracle.connect(deployer).setPriceFeed(ethers.ZeroAddress, await feed.getAddress())).wait();

    const c = ethers.keccak256(ethers.toUtf8Bytes("low-fee-dep"));
    const amt = ethers.parseEther("1");
    const tinyFee = ethers.parseEther("0.00001");

    await expect(
      pool.connect(deployer).deposit(ethers.ZeroAddress, amt, c, 0n, {
        value: amt + tinyFee,
      })
    ).to.be.revertedWithCustomError(pool, "SP");
  });

  it("SwapHandler swap fee matches 10 bps of inputAmount", async function () {
    const [deployer] = await ethers.getSigners();
    const MockV = await ethers.getContractFactory("MockVerifier");
    const v = await MockV.deploy();
    const t = await MockV.deploy();
    const Ad = await ethers.getContractFactory("contracts/_full/mocks/MockSwapAdaptor.sol:MockSwapAdaptor");
    const ad = await Ad.deploy();
    const fo = await ethers.getContractFactory("FeeOracle");
    const feeOracle = await fo.deploy();
    const rr = await ethers.getContractFactory("RelayerRegistry");
    const reg = await rr.deploy();
    await reg.waitForDeployment();
    await (await reg.registerRelayer(deployer.address)).wait();

    const pool = await deployBehindProxy(REDUCED_FQN, [
      await v.getAddress(),
      await t.getAddress(),
      await ad.getAddress(),
      await feeOracle.getAddress(),
      await reg.getAddress(),
    ]);

    const SH = await ethers.getContractFactory("SwapHandler");
    const sh = await SH.deploy(
      await pool.getAddress(),
      await v.getAddress(),
      await t.getAddress(),
      await ad.getAddress(),
      await feeOracle.getAddress(),
      await reg.getAddress()
    );
    await sh.waitForDeployment();

    const inputAmount = ethers.parseEther("100");
    const expectedSwapFee = (inputAmount * 10n) / 10000n;
    const pf = await feeOracle.calculateFee.staticCall(ethers.ZeroAddress, inputAmount);
    const total = pf + expectedSwapFee;
    expect(expectedSwapFee).to.equal(ethers.parseEther("0.1"));
    expect(await sh.DEX_SWAP_FEE_BPS()).to.equal(10n);
    expect(pf + expectedSwapFee).to.equal(total);
  });
});
