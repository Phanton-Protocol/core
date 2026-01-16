/* eslint-disable no-console */
require("dotenv").config();
const axios = require("axios");
const { ethers } = require("ethers");

/**
 * Off-chain signer for Dexscreener prices.
 *
 * Env:
 * - RPC_URL
 * - PRIVATE_KEY (signer)
 * - ORACLE_ADDRESS (OffchainPriceOracle)
 * - TOKEN_ADDRESS (token to price)
 * - CHAIN_ID (optional; auto-detect if not set)
 * - CHAIN_SLUG (optional; e.g. bsc, ethereum)
 * - PAIR_ADDRESS (optional; if set, fetches specific pair)
 */

const API_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const API_PAIR_URL = "https://api.dexscreener.com/latest/dex/pairs/";

async function fetchDexscreenerPriceUsd(tokenAddress, chainSlug, pairAddress) {
  if (pairAddress && chainSlug) {
    const { data } = await axios.get(`${API_PAIR_URL}${chainSlug}/${pairAddress}`);
    const pair = data?.pair;
    if (!pair?.priceUsd) {
      throw new Error("No USD price on Dexscreener (pair)");
    }
    return Number(pair.priceUsd);
  }

  const { data } = await axios.get(`${API_TOKEN_URL}${tokenAddress}`);
  if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) {
    throw new Error("No pairs found on Dexscreener (token)");
  }

  const pairs = chainSlug
    ? data.pairs.filter((p) => p.chainId === chainSlug)
    : data.pairs;

  if (!pairs || pairs.length === 0) {
    throw new Error("No pairs for specified chain on Dexscreener");
  }

  // Pick the pair with highest liquidity USD
  const bestPair = pairs.reduce((best, cur) => {
    const bestLiq = Number(best?.liquidity?.usd || 0);
    const curLiq = Number(cur?.liquidity?.usd || 0);
    return curLiq > bestLiq ? cur : best;
  }, null);

  if (!bestPair || !bestPair.priceUsd) {
    throw new Error("No USD price on Dexscreener");
  }

  return Number(bestPair.priceUsd);
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const oracleAddress = process.env.ORACLE_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const chainSlug = process.env.CHAIN_SLUG;
  const pairAddress = process.env.PAIR_ADDRESS;

  if (!rpcUrl || !privateKey || !oracleAddress || !tokenAddress) {
    throw new Error("Missing env: RPC_URL, PRIVATE_KEY, ORACLE_ADDRESS, TOKEN_ADDRESS");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  const chainId = process.env.CHAIN_ID
    ? Number(process.env.CHAIN_ID)
    : (await provider.getNetwork()).chainId;

  const oracleAbi = [
    "function updatePrice((address token,uint256 price,uint256 timestamp,uint256 nonce) update, bytes signature) external",
  ];
  const oracle = new ethers.Contract(oracleAddress, oracleAbi, signer);

  const priceUsd = await fetchDexscreenerPriceUsd(tokenAddress, chainSlug, pairAddress);
  const price = BigInt(Math.floor(priceUsd * 1e8)); // 8 decimals

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = timestamp;

  const domain = {
    name: "OffchainPriceOracle",
    version: "1",
    chainId,
    verifyingContract: oracleAddress,
  };

  const types = {
    PriceUpdate: [
      { name: "token", type: "address" },
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const value = {
    token: tokenAddress,
    price: price.toString(),
    timestamp,
    nonce,
  };

  const signature = await signer.signTypedData(domain, types, value);
  const tx = await oracle.updatePrice(value, signature);
  const receipt = await tx.wait();

  console.log("Dexscreener price (USD):", priceUsd);
  console.log("Oracle update tx:", receipt?.hash || tx.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
