import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import hre from "hardhat";
import { getReducedPoolFactory } from "./joinSplitFeeValidationLink";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require("solc");

const { ethers } = hre;

function compileGroth16FromZkey(zkeyPath: string): { abi: any[]; bytecode: string } {
  const tmpSol = path.join(os.tmpdir(), `pathb-zkey-verifier-${Date.now()}.sol`);
  execFileSync("npx", ["snarkjs", "zkey", "export", "solidityverifier", zkeyPath, tmpSol], {
    stdio: "inherit",
  });
  const source = fs.readFileSync(tmpSol, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "PathBJoinSplitVerifier.sol": { content: source },
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode"],
        },
      },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const file = out.contracts?.["PathBJoinSplitVerifier.sol"];
  const contractName = Object.keys(file || {}).find((k) => k.toLowerCase().includes("groth16"));
  if (!file || !contractName) {
    throw new Error("Failed to compile exported Groth16 verifier from zkey");
  }
  const c = file[contractName];
  const abi = c.abi;
  const bytecode = c.evm?.bytecode?.object;
  if (!abi || !bytecode) {
    throw new Error("Missing ABI/bytecode from compiled verifier");
  }
  return { abi, bytecode: `0x${bytecode}` };
}

async function main() {
  const zkeyPath = String(process.env.ZKEY_PATH || "").trim();
  const swapAdaptor = String(process.env.SWAP_ADAPTOR || "").trim();
  const feeOracle = String(process.env.FEE_ORACLE || "").trim();
  const relayerRegistry = String(process.env.RELAYER_REGISTRY || "").trim();
  if (!zkeyPath || !swapAdaptor || !feeOracle || !relayerRegistry) {
    throw new Error("Set ZKEY_PATH, SWAP_ADAPTOR, FEE_ORACLE, RELAYER_REGISTRY");
  }

  const [deployer] = await ethers.getSigners();
  console.log("[path-b] zkey-aligned deployer:", deployer.address);

  const { abi, bytecode } = compileGroth16FromZkey(zkeyPath);
  const DynamicGroth16Factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const groth16 = await DynamicGroth16Factory.deploy();
  await groth16.waitForDeployment();
  const groth16Addr = await groth16.getAddress();
  console.log("[path-b] zkey-aligned Groth16 verifier:", groth16Addr);

  const Adapter = await ethers.getContractFactory("Groth16VerifierAdapter");
  const adapter = await Adapter.deploy(groth16Addr);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log("[path-b] verifier adapter:", adapterAddr);

  const ReducedPool = await getReducedPoolFactory(deployer);
  const pool = await ReducedPool.deploy();
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("[path-b] new zkey-aligned pool:", poolAddr);

  await (await pool.initialize(adapterAddr, adapterAddr, swapAdaptor, feeOracle, relayerRegistry)).wait();
  console.log("[path-b] pool initialized");

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const handler = await DepositHandler.deploy(poolAddr, feeOracle, relayerRegistry);
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  await (await pool.setDepositHandler(handlerAddr)).wait();
  console.log("[path-b] depositHandler:", handlerAddr);
}

main().catch((e) => {
  console.error("[path-b] failed:", e);
  process.exit(1);
});

