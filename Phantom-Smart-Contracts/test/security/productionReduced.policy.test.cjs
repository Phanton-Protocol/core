/**
 * Path-B production policy — Reduced pool only, allowlisted standard ERC20, fund-flow lock.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployBehindProxy } = require("../helpers/proxyDeploy.cjs");
const { allowlistAndRegisterAsset } = require("../helpers/reducedProduction.cjs");
const { merkleProofForFirstLeaf } = require("../helpers/poolFixtures.cjs");

const REDUCED_FQN = "contracts/_full/core/ShieldedPoolUpgradeableReduced.sol:ShieldedPoolUpgradeableReduced";

async function deployReducedWithHandlers(deployer) {
  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const v1 = await MockVerifier.deploy();
  const v2 = await MockVerifier.deploy();
  await v1.waitForDeployment();
  await v2.waitForDeployment();

  const ReAd = await ethers.getContractFactory("MockReentrantSwapAdaptor");
  const swapAdaptor = await ReAd.deploy();
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

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(
    await pool.getAddress(),
    await feeOracle.getAddress(),
    await relayerRegistry.getAddress()
  );
  await depositHandler.waitForDeployment();
  await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();

  return { pool, feeOracle, swapAdaptor, relayerRegistry };
}

describe("Path-B production policy (ShieldedPoolUpgradeableReduced)", function () {
  it("rejects registerAsset for fee-on-transfer token (probe fails)", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool } = await deployReducedWithHandlers(deployer);

    const FoT = await ethers.getContractFactory("FeeOnTransferERC20");
    const token = await FoT.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    await (await token.mint(deployer.address, ethers.parseEther("100"))).wait();
    await (await token.approve(await pool.getAddress(), ethers.MaxUint256)).wait();

    const TokenAccounting = await ethers.getContractFactory(
      "contracts/_full/libraries/TokenAccounting.sol:TokenAccounting"
    );
    await expect(
      pool.connect(deployer).registerAssetWithProbe(1n, tokenAddr, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(TokenAccounting, "ERC20ReceivedMismatch");
    expect(await pool.allowedERC20(tokenAddr)).to.equal(false);
  });

  it("allowlists standard ERC20 via probe and records asset", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool } = await deployReducedWithHandlers(deployer);

    const MockERC20 = await ethers.getContractFactory(
      "contracts/_full/mocks/MockERC20.sol:MockERC20"
    );
    const token = await MockERC20.deploy("T", "T", 18);
    await token.waitForDeployment();
    const tokenAddr = await allowlistAndRegisterAsset(pool, deployer, 1n, token);

    expect(await pool.allowedERC20(tokenAddr)).to.equal(true);
    expect(await pool.assetRegistry(1n)).to.equal(tokenAddr);
  });

  it("join-split reverts if swap output asset was not allowlisted", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool, swapAdaptor } = await deployReducedWithHandlers(deployer);

    const MockERC20 = await ethers.getContractFactory(
      "contracts/_full/mocks/MockERC20.sol:MockERC20"
    );
    const outTok = await MockERC20.deploy("O", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await outTok.getAddress();
    // NOT registered / allowlisted

    const inputAmount = ethers.parseEther("10");
    const swapAmt = ethers.parseEther("4");
    const c1 = ethers.keccak256(ethers.toUtf8Bytes("prod-unreg"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, { value: inputAmount });

    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);

    const swapData = {
      proof: { a: "0x", b: "0x", c: "0x" },
      publicInputs: {
        nullifier: ethers.ZeroHash,
        inputCommitment: c1,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("s")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("c")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 2n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: swapAmt,
        changeAmount: inputAmount - swapAmt,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee: 0n,
        merklePath: path,
        merklePathIndices: indices,
      },
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: outAddr,
        amountIn: swapAmt,
        minAmountOut: swapAmt,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: deployer.address,
      encryptedPayload: "0x",
      commitment: ethers.ZeroHash,
      deadline: 0n,
      nonce: 0n,
      relayerAttestationSig: "0x",
      relayerAttestationDeadline: 0n,
      relayerAttestationNonce: 0n,
      proofContextHash: ethers.ZeroHash,
    };

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.be.revertedWithCustomError(
      pool,
      "ERC20NotAllowlisted"
    );
    expect(await swapAdaptor.callbackTarget()).to.equal(ethers.ZeroAddress);
  });

  it("sets fundFlowLocked during malicious adaptor callback", async function () {
    const [deployer] = await ethers.getSigners();
    const { pool, swapAdaptor } = await deployReducedWithHandlers(deployer);

    const outAddr = await allowlistAndRegisterAsset(pool, deployer, 2n, await (async () => {
      const MockERC20 = await ethers.getContractFactory(
        "contracts/_full/mocks/MockERC20.sol:MockERC20"
      );
      const t = await MockERC20.deploy("O", "O", 18);
      await t.waitForDeployment();
      return t;
    })());

    const inputAmount = ethers.parseEther("10");
    const swapAmt = ethers.parseEther("4");
    const c1 = ethers.keccak256(ethers.toUtf8Bytes("prod-lock"));
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, c1, 0n, { value: inputAmount });

    const poolAddr = await pool.getAddress();
    const iface = new ethers.Interface(["function isFundFlowLocked() view returns (bool)"]);
    const checkData = iface.encodeFunctionData("isFundFlowLocked", []);
    await swapAdaptor.configureCallback(poolAddr, checkData);

    const root = await pool.merkleRoot();
    const { path, indices } = await merkleProofForFirstLeaf(c1);

    const swapData = {
      proof: { a: "0x", b: "0x", c: "0x" },
      publicInputs: {
        nullifier: ethers.ZeroHash,
        inputCommitment: c1,
        outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("s2")),
        outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("c2")),
        merkleRoot: root,
        inputAssetID: 0n,
        outputAssetIDSwap: 2n,
        outputAssetIDChange: 0n,
        inputAmount,
        swapAmount: swapAmt,
        changeAmount: inputAmount - swapAmt,
        outputAmountSwap: swapAmt,
        minOutputAmountSwap: swapAmt,
        gasRefund: 0n,
        protocolFee: 0n,
        merklePath: path,
        merklePathIndices: indices,
      },
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: outAddr,
        amountIn: swapAmt,
        minAmountOut: swapAmt,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: deployer.address,
      encryptedPayload: "0x",
      commitment: ethers.ZeroHash,
      deadline: 0n,
      nonce: 0n,
      relayerAttestationSig: "0x",
      relayerAttestationDeadline: 0n,
      relayerAttestationNonce: 0n,
      proofContextHash: ethers.ZeroHash,
    };

    // Callback runs isFundFlowLocked() on pool; staticcall returns true; adaptor succeeds; join-split completes.
    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.emit(pool, "ShieldedSwapJoinSplit");
    expect(await pool.isFundFlowLocked()).to.equal(false);
  });
});
