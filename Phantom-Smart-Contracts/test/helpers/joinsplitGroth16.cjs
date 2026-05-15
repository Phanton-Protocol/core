const path = require("path");
const { ethers } = require("hardhat");
const snarkjs = require("snarkjs");
const { getShieldedPoolFactory } = require("./libraryLinker.cjs");

const PSC_ROOT = path.resolve(__dirname, "..", "..");
const WASM = path.join(
  PSC_ROOT,
  "circuits/joinsplit_public9/build/joinsplit_public9_js/joinsplit_public9.wasm"
);
const ZKEY = path.join(PSC_ROOT, "circuits/joinsplit_public9/circuit_final.zkey");

function toDecString(x) {
  return BigInt(typeof x === "bigint" ? x : String(x)).toString(10);
}

/**
 * Flat witness for `joinsplit_public9.circom` (matches circom `main.*` signal names).
 */
function joinSplitPublicInputsToWitness(pi) {
  const pathVals = [...(pi.merklePath || [])].slice(0, 10).map((p) => toDecString(p));
  while (pathVals.length < 10) pathVals.push("0");
  const idxVals = [...(pi.merklePathIndices || [])]
    .slice(0, 10)
    .map((p) => String(BigInt(p) % 2n));
  while (idxVals.length < 10) idxVals.push("0");

  const outSwap = BigInt(pi.outputCommitmentSwap);
  const withdrawMode = outSwap === 0n ? "1" : "0";

  return {
    inputAssetID: toDecString(pi.inputAssetID),
    inputAmount: toDecString(pi.inputAmount),
    inputBlindingFactor: toDecString(pi.inputBlindingFactor),
    ownerPublicKey: toDecString(pi.ownerPublicKey),
    outputAssetIDSwap: toDecString(pi.outputAssetIDSwap),
    outputAmountSwapNote: toDecString(pi.outputAmountSwapNote ?? pi.outputAmountSwap),
    swapBlindingFactor: toDecString(pi.swapBlindingFactor),
    outputAssetIDChange: toDecString(pi.outputAssetIDChange ?? pi.inputAssetID),
    changeAmount: toDecString(pi.changeAmount),
    changeBlindingFactor: toDecString(pi.changeBlindingFactor),
    swapAmount: toDecString(pi.swapAmount),
    withdrawMode,
    protocolFeeWitness: toDecString(pi.protocolFee),
    gasRefundWitness: toDecString(pi.gasRefund),
    minOutputAmountSwapWitness: toDecString(pi.minOutputAmountSwap),
    merklePath: pathVals,
    merklePathIndices: idxVals,
  };
}

/**
 * Encode A,B,C exactly as snarkjs `groth16.exportSolidityCallData` (matches generated Solidity verifier).
 */
function poolProofFromSolidityCallData(calldataStr) {
  const quoted = calldataStr.match(/"0x[0-9a-fA-F]+"/g);
  if (!quoted || quoted.length < 8) {
    throw new Error("Could not parse groth16.exportSolidityCallData output");
  }
  const vals = quoted.map((x) => BigInt(JSON.parse(x)));
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const a = abi.encode(["uint256", "uint256"], [vals[0], vals[1]]);
  const b = abi.encode(["uint256", "uint256", "uint256", "uint256"], [vals[2], vals[3], vals[4], vals[5]]);
  const c = abi.encode(["uint256", "uint256"], [vals[6], vals[7]]);
  return { a, b, c };
}

async function proveJoinSplitPublic9FromPublicInputs(publicInputsStruct) {
  const witness = joinSplitPublicInputsToWitness(publicInputsStruct);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
  const vk = JSON.parse(
    require("fs").readFileSync(path.join(PSC_ROOT, "circuits/joinsplit_public9/verification_key.json"), "utf8")
  );
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("snarkjs groth16.verify failed");
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  return { proof, publicSignals, poolProof: poolProofFromSolidityCallData(calldata) };
}

/**
 * Pool + mocks, but join-split slot uses real Groth16Verifier + adapter (portfolio stays MockVerifier).
 */
async function deployPoolWithRealJoinSplitVerifier() {
  const [deployer] = await ethers.getSigners();
  const FQN = "contracts/_full/verifiers/JoinSplitVerifier.sol:Groth16Verifier";
  const Groth16 = await ethers.getContractFactory(FQN);
  const groth16 = await Groth16.deploy();
  await groth16.waitForDeployment();
  const groth16Addr = await groth16.getAddress();

  const Adapter = await ethers.getContractFactory("Groth16VerifierAdapter");
  const joinAdapter = await Adapter.deploy(groth16Addr);
  await joinAdapter.waitForDeployment();
  const joinAddr = await joinAdapter.getAddress();

  const MockVerifier = await ethers.getContractFactory("MockVerifier");
  const portfolio = await MockVerifier.deploy();
  await portfolio.waitForDeployment();
  const portfolioAddr = await portfolio.getAddress();

  const threshold = await MockVerifier.deploy();
  await threshold.waitForDeployment();
  const thresholdAddr = await threshold.getAddress();

  const MockSwapAdaptor = await ethers.getContractFactory("MockSwapAdaptor");
  const swapAdaptor = await MockSwapAdaptor.deploy();
  await swapAdaptor.waitForDeployment();
  const swapAdaptorAddr = await swapAdaptor.getAddress();

  const FeeOracle = await ethers.getContractFactory("FeeOracle");
  const feeOracle = await FeeOracle.deploy();
  await feeOracle.waitForDeployment();
  const { wireDefaultBnbFeed } = require("./poolFixtures.cjs");
  await wireDefaultBnbFeed(feeOracle, deployer);
  const feeOracleAddr = await feeOracle.getAddress();

  const RelayerRegistry = await ethers.getContractFactory("RelayerRegistry");
  const relayerRegistry = await RelayerRegistry.deploy();
  await relayerRegistry.waitForDeployment();
  const relayerRegistryAddr = await relayerRegistry.getAddress();
  await (await relayerRegistry.registerRelayer(deployer.address)).wait();

  const ShieldedPool = await getShieldedPoolFactory("ShieldedPool");
  const pool = await ShieldedPool.deploy(
    joinAddr,
    portfolioAddr,
    thresholdAddr,
    swapAdaptorAddr,
    feeOracleAddr,
    relayerRegistryAddr
  );
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const DepositHandler = await ethers.getContractFactory("DepositHandler");
  const depositHandler = await DepositHandler.deploy(poolAddr, feeOracleAddr, relayerRegistryAddr);
  await depositHandler.waitForDeployment();

  const TransactionHistory = await ethers.getContractFactory("TransactionHistory");
  const txHistory = await TransactionHistory.deploy(poolAddr);
  await txHistory.waitForDeployment();

  await (await pool.setDepositHandler(await depositHandler.getAddress())).wait();
  await (await pool.setTransactionHistory(await txHistory.getAddress())).wait();

  return {
    deployer,
    pool,
    feeOracle: await ethers.getContractAt("FeeOracle", feeOracleAddr),
    groth16Addr,
  };
}

module.exports = {
  joinSplitPublicInputsToWitness,
  poolProofFromSolidityCallData,
  proveJoinSplitPublic9FromPublicInputs,
  deployPoolWithRealJoinSplitVerifier,
};
