/**
 * Module 4 — relayer shadow / sheltered deposit helpers (no Express).
 */
const { ethers } = require("ethers");

const POOL_MIN_ABI = [
  "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external payable",
  "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable",
  "function relayerRegistry() view returns (address)",
];

const REGISTRY_ABI = ["function isRelayer(address) view returns (bool)"];

async function getRegistryAddress(provider, shieldedPoolAddress) {
  const pool = new ethers.Contract(shieldedPoolAddress, POOL_MIN_ABI, provider);
  return await pool.relayerRegistry();
}

/**
 * @returns {{ registryAddress: string }}
 */
async function assertRelayerRegistered(provider, shieldedPoolAddress, relayerAddress) {
  const regAddr = await getRegistryAddress(provider, shieldedPoolAddress);
  const reg = new ethers.Contract(regAddr, REGISTRY_ABI, provider);
  const ok = await reg.isRelayer(relayerAddress);
  if (!ok) {
    const err = new Error("Relayer wallet is not registered on RelayerRegistry (isRelayer=false)");
    err.code = "RELAYER_NOT_REGISTERED";
    throw err;
  }
  return { registryAddress: regAddr };
}

function poolContract(poolAddress, signerOrProvider) {
  return new ethers.Contract(poolAddress, POOL_MIN_ABI, signerOrProvider);
}

async function sendDepositForErc20(wallet, poolAddress, { depositor, token, amount, commitment, assetID, feeWei }) {
  const pool = poolContract(poolAddress, wallet);
  const amt = typeof amount === "bigint" ? amount : BigInt(amount);
  const aid = typeof assetID === "bigint" ? assetID : BigInt(assetID);
  const fee = typeof feeWei === "bigint" ? feeWei : BigInt(feeWei ?? 0);
  return pool.depositFor(depositor, token, amt, commitment, aid, { value: fee });
}

async function sendDepositForBnb(wallet, poolAddress, { depositor, commitment, assetID, valueWei }) {
  const pool = poolContract(poolAddress, wallet);
  const aid = typeof assetID === "bigint" ? assetID : BigInt(assetID);
  const v = typeof valueWei === "bigint" ? valueWei : BigInt(valueWei);
  return pool.depositForBNB(depositor, commitment, aid, { value: v });
}

function logModule4(event, meta = {}) {
  const line = JSON.stringify({
    module: "module4",
    event,
    ts: new Date().toISOString(),
    ...meta,
  });
  console.log(line);
}

module.exports = {
  assertRelayerRegistered,
  getRegistryAddress,
  poolContract,
  sendDepositForErc20,
  sendDepositForBnb,
  logModule4,
};
