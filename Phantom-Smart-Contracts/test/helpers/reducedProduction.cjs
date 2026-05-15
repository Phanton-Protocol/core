/**
 * Path-B production helpers: ERC20 allowlist probe + registerAsset.
 */
const { ethers } = require("hardhat");

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

module.exports = { allowlistAndRegisterAsset, MOCK_ERC20_FQN };
