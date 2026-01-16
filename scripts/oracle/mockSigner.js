/* eslint-disable no-console */
require("dotenv").config();
const { ethers } = require("ethers");

/**
 * Mock signer for testnet/dev when Dexscreener has no testnet data.
 *
 * Env:
 * - RPC_URL
 * - PRIVATE_KEY (signer)
 * - ORACLE_ADDRESS (OffchainPriceOracle)
 * - TOKEN_ADDRESS
 * - PRICE_USD (e.g. 245.12)
 * - CHAIN_ID (optional)
 */

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const oracleAddress = process.env.ORACLE_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const priceUsd = process.env.PRICE_USD;

  if (!rpcUrl || !privateKey || !oracleAddress || !tokenAddress || !priceUsd) {
    throw new Error("Missing env: RPC_URL, PRIVATE_KEY, ORACLE_ADDRESS, TOKEN_ADDRESS, PRICE_USD");
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

  const price = BigInt(Math.floor(Number(priceUsd) * 1e8));
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
  await tx.wait();

  console.log("Mock price (USD):", priceUsd);
  console.log("Oracle update tx:", tx.hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
