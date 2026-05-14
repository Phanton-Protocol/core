const path = require("path");

require("@nomicfoundation/hardhat-toolbox");
// Load env from this package or parent `core/` (where `.env` often lives).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const bscTestnetCfg = require("./config/bscTestnet.json");
const bscMainnetCfg = require("./config/bscMainnet.json");

function deployerAccounts() {
  const key = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  return key ? [key] : [];
}

const useFullTree = process.env.HH_FULL === "1";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  // Default: contracts/stage1 (libraries + one minimal pool). Full tree: HH_FULL=1 (needs 0.8.28 + viaIR).
  solidity: {
    version: useFullTree ? "0.8.28" : "0.8.21",
    settings: {
      optimizer: {
        enabled: true,
        // Lower runs shrinks bytecode (helps EIP-170 warnings on large contracts).
        runs: useFullTree ? 1 : 200,
      },
      // Drop the trailing CBOR metadata hash from runtime bytecode to claw back
      // ~50 bytes per contract — needed to keep ShieldedPool under EIP-170 on
      // BSC testnet after the Phase 1 internal-match additions.
      ...(useFullTree ? { viaIR: true, metadata: { bytecodeHash: "none" } } : {}),
    },
  },
  paths: {
    sources: useFullTree ? "./contracts/_full" : "./contracts/stage1",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Module 1 hardening note: the in-memory hardhat-network is **test
      // infra only** and never sees real users — keep size enforcement off
      // here so a missing `HH_FULL=1` env on a direct `npx hardhat test`
      // invocation can't break the suite. Real BSC mainnet / testnet
      // configs below do NOT set this flag, so EIP-170 still applies at
      // deploy time and the oversized experimental pools (flagged in
      // `docs/SECURITY_FIXES_MODULE1.md` §8) cannot accidentally ship.
      allowUnlimitedContractSize: true,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || bscTestnetCfg.rpcUrl,
      chainId: bscTestnetCfg.chainId,
      accounts: deployerAccounts(),
    },
    bsc: {
      url: process.env.BSC_MAINNET_RPC || bscMainnetCfg.rpcUrl,
      chainId: bscMainnetCfg.chainId,
      accounts: deployerAccounts(),
    },
  },
};
