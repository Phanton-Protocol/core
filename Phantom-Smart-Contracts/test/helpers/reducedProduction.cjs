/**
 * Path-B production helpers: ERC20 allowlist probe + registerAsset.
 */
const { ethers } = require("hardhat");
const { commitJoinSplitMevProtection, wireDefaultBnbFeed } = require("./poolFixtures.cjs");
const { joinSplitSwapDataDummyAttestation } = require("./relayerSwapAttestation.cjs");

const MOCK_ERC20_FQN = "contracts/_full/mocks/MockERC20.sol:MockERC20";

/**
 * Mint, approve pool, and register asset (1-wei probe) on ShieldedPoolUpgradeableReduced.
 * @param {import('ethers').Contract} pool
 * @param {import('ethers').Signer} owner
 * @param {bigint} assetId
 * @param {import('ethers').Contract|string} tokenOrAddress
 */
async function allowlistAndRegisterAsset(pool, owner, assetId, tokenOrAddress) {
  const tokenAddr =
    typeof tokenOrAddress === "string" ? tokenOrAddress : await tokenOrAddress.getAddress();
  const token = await ethers.getContractAt(MOCK_ERC20_FQN, tokenAddr);
  await (await token.mint(owner.address, ethers.parseEther("10000"))).wait();
  await (await token.connect(owner).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  await (await pool.connect(owner).registerAsset(assetId, tokenAddr)).wait();
  return tokenAddr;
}

/**
 * Build join-split calldata for Reduced pool (MEV commit + relayer + min slippage).
 */
async function buildReducedJoinSplitTx(pool, relayerSigner, publicInputs, tokenOut) {
  const mev = await commitJoinSplitMevProtection(pool, relayerSigner);
  const minOut =
    publicInputs.minOutputAmountSwap > 0n
      ? publicInputs.minOutputAmountSwap
      : publicInputs.outputAmountSwap > 0n
        ? publicInputs.outputAmountSwap
        : 1n;
  return {
    proof: { a: "0x", b: "0x", c: "0x" },
    publicInputs,
    swapParams: {
      tokenIn: publicInputs.inputAssetID === 0n ? ethers.ZeroAddress : tokenOut,
      tokenOut,
      amountIn: publicInputs.swapAmount,
      minAmountOut: minOut,
      fee: 0,
      sqrtPriceLimitX96: 0n,
      path: "0x",
    },
    relayer: relayerSigner.address,
    commitment: mev.commitment,
    deadline: mev.deadline,
    nonce: mev.nonce,
    encryptedPayload: "0x",
    ...joinSplitSwapDataDummyAttestation(),
  };
}

/** Call after FeeOracle.deploy() in Reduced pool test fixtures. */
async function initFeeOracleForTests(feeOracle, owner) {
  await wireDefaultBnbFeed(feeOracle, owner);
}

module.exports = {
  allowlistAndRegisterAsset,
  buildReducedJoinSplitTx,
  initFeeOracleForTests,
  MOCK_ERC20_FQN,
};
