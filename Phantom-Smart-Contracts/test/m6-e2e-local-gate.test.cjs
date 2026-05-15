/**
 * M6 — Local E2E gate (Hardhat, Mock verifier + MockSwapAdaptor, no testnet funds).
 * deposit → merkle → shieldedSwapJoinSplit → shieldedWithdraw (spends change leaf).
 */
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildMerklePath, verifyMerklePath } = require(path.join(
  __dirname,
  "..",
  "..",
  "phantom-relayer-dashboard",
  "backend",
  "src",
  "merkle10.js"
));
const {
  merkleProofForFirstLeaf,
  emptyProof,
  deployPoolFixture,
  totalJoinSplitFeeBnb,
  withdrawProtocolFee,
  commitJoinSplitMevProtection,
} = require("./helpers/poolFixtures.cjs");
const {
  attachJoinSplitRelayerAttestation,
  joinSplitSwapDataDummyAttestation,
} = require("./helpers/relayerSwapAttestation.cjs");

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

function toPathBn(mp) {
  return mp.path.map((p) => BigInt(p));
}

function toIndicesBn(mp) {
  return mp.indices.map((i) => BigInt(i));
}

describe("M6 — E2E local gate (mock pool)", function () {
  it("M6-E2E-01: deposit → merkle → join-split swap → withdraw (change note)", async function () {
    const { deployer, pool, feeOracle } = await deployPoolFixture();
    const [, recipient] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    const outAddr = await outTok.getAddress();
    await pool.connect(deployer).registerAsset(1n, outAddr);

    const commitmentIn = ethers.keccak256(ethers.toUtf8Bytes("m6-e2e-note-in"));
    const inputAmount = ethers.parseEther("25");
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitmentIn, 0n, {
      value: inputAmount,
    });

    const { root: rootAfterDeposit, path: pathIn, indices: idxIn } = await merkleProofForFirstLeaf(commitmentIn);
    expect(await pool.merkleRoot()).to.equal(rootAfterDeposit);

    const totalPfSwap = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
    const swapAmount = ethers.parseEther("5");
    const gasRefundSwap = 0n;
    const changeAfterSwap = inputAmount - swapAmount - totalPfSwap - gasRefundSwap;

    const nullifierSwap = ethers.keccak256(ethers.toUtf8Bytes("m6-null-swap"));
    const outSwap = ethers.keccak256(ethers.toUtf8Bytes("m6-out-swap"));
    const outChange = ethers.keccak256(ethers.toUtf8Bytes("m6-out-change"));

    const swapPublic = {
      nullifier: nullifierSwap,
      inputCommitment: commitmentIn,
      outputCommitmentSwap: outSwap,
      outputCommitmentChange: outChange,
      merkleRoot: rootAfterDeposit,
      inputAssetID: 0n,
      outputAssetIDSwap: 1n,
      outputAssetIDChange: 0n,
      inputAmount,
      swapAmount,
      changeAmount: changeAfterSwap,
      outputAmountSwap: swapAmount,
      minOutputAmountSwap: swapAmount,
      gasRefund: gasRefundSwap,
      protocolFee: totalPfSwap,
      merklePath: pathIn,
      merklePathIndices: idxIn,
    };

    const mev = await commitJoinSplitMevProtection(pool, deployer, "m6-e2e-mev-1");

    const swapData = await attachJoinSplitRelayerAttestation(deployer, pool, {
      proof: emptyProof(),
      publicInputs: swapPublic,
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: outAddr,
        amountIn: swapAmount,
        minAmountOut: swapAmount,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: ethers.ZeroAddress,
      commitment: mev.commitment,
      deadline: mev.deadline,
      nonce: mev.nonce,
      encryptedPayload: "0x",
    });

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(swapData)).to.emit(pool, "ShieldedSwapJoinSplit");
    expect(await pool.commitmentCount()).to.equal(3n);

    const poolRoot = await pool.merkleRoot();
    const leaves = [commitmentIn, outSwap, outChange];
    const mp = buildMerklePath(leaves, 2);
    expect(poolRoot.toLowerCase()).to.equal(mp.root.toLowerCase());
    expect(
      verifyMerklePath(outChange, mp.path, mp.indices, poolRoot)
    ).to.equal(true);

    const noteIn = changeAfterSwap;
    const withdrawAmount = ethers.parseEther("2");
    const protocolFee = await withdrawProtocolFee(feeOracle, ethers.ZeroAddress, noteIn);
    const gasRefundWd = 0n;
    const changeAfterWd = noteIn - withdrawAmount - protocolFee - gasRefundWd;

    const nullifierWd = ethers.keccak256(ethers.toUtf8Bytes("m6-null-wd"));
    const outChangeWd = ethers.keccak256(ethers.toUtf8Bytes("m6-change-wd"));

    const withdrawPublic = {
      nullifier: nullifierWd,
      inputCommitment: outChange,
      outputCommitmentSwap: ethers.ZeroHash,
      outputCommitmentChange: outChangeWd,
      merkleRoot: poolRoot,
      inputAssetID: 0n,
      outputAssetIDSwap: 0n,
      outputAssetIDChange: 0n,
      inputAmount: noteIn,
      swapAmount: withdrawAmount,
      changeAmount: changeAfterWd,
      outputAmountSwap: 0n,
      minOutputAmountSwap: 0n,
      gasRefund: gasRefundWd,
      protocolFee,
      merklePath: toPathBn(mp),
      merklePathIndices: toIndicesBn(mp),
    };

    const withdrawData = {
      proof: emptyProof(),
      publicInputs: withdrawPublic,
      recipient: recipient.address,
      relayer: ethers.ZeroAddress,
      encryptedPayload: "0x",
    };

    const balBefore = await ethers.provider.getBalance(recipient.address);
    await expect(pool.connect(deployer).shieldedWithdraw(withdrawData)).to.emit(pool, "ShieldedWithdraw");
    const balAfter = await ethers.provider.getBalance(recipient.address);
    expect(balAfter - balBefore).to.equal(withdrawAmount);
    expect(await pool.nullifiers(nullifierWd)).to.equal(true);
  });

  it("M6-NEG-01: swap conservation break → PoolErr(43)", async function () {
    const { deployer, pool, feeOracle } = await deployPoolFixture();
    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    await pool.connect(deployer).registerAsset(1n, await outTok.getAddress());

    const commitment = ethers.keccak256(ethers.toUtf8Bytes("m6-bad-cons-swap"));
    const inputAmount = ethers.parseEther("25");
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, { value: inputAmount });

    const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
    const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
    const swapAmount = ethers.parseEther("5");
    const badChange = ethers.parseEther("1");

    const publicInputs = {
      nullifier: ethers.keccak256(ethers.toUtf8Bytes("n-s43")),
      inputCommitment: commitment,
      outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("os")),
      outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("oc")),
      merkleRoot: root,
      inputAssetID: 0n,
      outputAssetIDSwap: 1n,
      outputAssetIDChange: 0n,
      inputAmount,
      swapAmount,
      changeAmount: badChange,
      outputAmountSwap: swapAmount,
      minOutputAmountSwap: swapAmount,
      gasRefund: 0n,
      protocolFee: totalPf,
      merklePath: path,
      merklePathIndices: indices,
    };

    const mev = await commitJoinSplitMevProtection(pool, deployer, "m6-neg01-mev");

    const joinData = await attachJoinSplitRelayerAttestation(deployer, pool, {
      proof: emptyProof(),
      publicInputs,
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: await outTok.getAddress(),
        amountIn: swapAmount,
        minAmountOut: swapAmount,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: ethers.ZeroAddress,
      commitment: mev.commitment,
      deadline: mev.deadline,
      nonce: mev.nonce,
      encryptedPayload: "0x",
    });

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(joinData))
      .to.be.revertedWithCustomError(pool, "PoolErr")
      .withArgs(43);
  });

  it("M6-NEG-02: swap minOutput above mock DEX output → PoolErr(15)", async function () {
    const { deployer, pool, feeOracle } = await deployPoolFixture();
    const MockERC20 = await ethers.getContractFactory(MOCK_ERC20_FQN);
    const outTok = await MockERC20.deploy("Out", "O", 18);
    await outTok.waitForDeployment();
    await pool.connect(deployer).registerAsset(1n, await outTok.getAddress());

    const commitment = ethers.keccak256(ethers.toUtf8Bytes("m6-dex-min"));
    const inputAmount = ethers.parseEther("25");
    await pool.connect(deployer).deposit(ethers.ZeroAddress, inputAmount, commitment, 0n, { value: inputAmount });

    const { root, path, indices } = await merkleProofForFirstLeaf(commitment);
    const totalPf = await totalJoinSplitFeeBnb(feeOracle, inputAmount);
    const swapAmount = ethers.parseEther("5");
    const changeAmount = inputAmount - swapAmount - totalPf;

    const publicInputs = {
      nullifier: ethers.keccak256(ethers.toUtf8Bytes("n-15")),
      inputCommitment: commitment,
      outputCommitmentSwap: ethers.keccak256(ethers.toUtf8Bytes("osx")),
      outputCommitmentChange: ethers.keccak256(ethers.toUtf8Bytes("ocx")),
      merkleRoot: root,
      inputAssetID: 0n,
      outputAssetIDSwap: 1n,
      outputAssetIDChange: 0n,
      inputAmount,
      swapAmount,
      changeAmount,
      outputAmountSwap: swapAmount,
      minOutputAmountSwap: swapAmount + 1n,
      gasRefund: 0n,
      protocolFee: totalPf,
      merklePath: path,
      merklePathIndices: indices,
    };

    const mev = await commitJoinSplitMevProtection(pool, deployer, "m6-neg02-mev");

    const joinSplitBase = {
      proof: emptyProof(),
      publicInputs,
      swapParams: {
        tokenIn: ethers.ZeroAddress,
        tokenOut: await outTok.getAddress(),
        amountIn: swapAmount,
        minAmountOut: swapAmount + 1n,
        fee: 0,
        sqrtPriceLimitX96: 0n,
        path: "0x",
      },
      relayer: ethers.ZeroAddress,
      commitment: mev.commitment,
      deadline: mev.deadline,
      nonce: mev.nonce,
      encryptedPayload: "0x",
    };
    const joinSplitSig = await attachJoinSplitRelayerAttestation(deployer, pool, joinSplitBase, 2n);

    await expect(pool.connect(deployer).shieldedSwapJoinSplit(joinSplitSig))
      .to.be.revertedWithCustomError(pool, "PoolErr")
      .withArgs(15);
  });
});
