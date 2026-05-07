

const snarkjs = require("snarkjs");
const { logProofFailure } = require("./relayerLog");
let zkKitProve = null;
try {
  zkKitProve = require("@zk-kit/groth16").prove;
} catch (_) {
  
}
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");
const { mimc7, FIELD } = require("./mimc7");
const { computeCommitment, computeNullifier } = require("./noteModel");
const { ethers } = require("ethers");
const { toBigIntString, toBigInt } = require("./utils/bigint");
const ZK_VERBOSE_DEBUG = process.env.PHANTOM_ZK_VERBOSE_DEBUG === "true";

/**
 * ShieldedPool.shieldedSwapJoinSplit checks:
 *   inputs.protocolFee == feeOracle.calculateFee(token, inputAmount) + DexSwapFee.swapFee(inputAmount)
 * (DexSwapFee: 10 bps unless PHANTOM_DEX_SWAP_FEE_BPS overrides — must match contract.)
 */
async function getJoinSplitTotalProtocolFeeWei(inputAssetID, inputAmountWei) {
  const rpc = process.env.RPC_URL;
  const poolAddr = process.env.SHIELDED_POOL_ADDRESS;
  if (!rpc || !poolAddr) throw new Error("RPC_URL or SHIELDED_POOL_ADDRESS unset");
  const provider = new ethers.JsonRpcProvider(rpc);
  const poolAbi = [
    "function assetRegistry(uint256) view returns (address)",
    "function feeOracle() view returns (address)",
  ];
  const feeOracleAbi = ["function calculateFee(address token, uint256 amount) view returns (uint256)"];
  const pool = new ethers.Contract(poolAddr, poolAbi, provider);
  const inputToken = await pool.assetRegistry(inputAssetID);
  const fo = new ethers.Contract(await pool.feeOracle(), feeOracleAbi, provider);
  let oraclePart = 0n;
  try {
    oraclePart = BigInt((await fo.calculateFee(inputToken, inputAmountWei)).toString());
  } catch (e) {
    console.warn("[zk] feeOracle.calculateFee failed:", e.message);
  }
  const cap = BigInt(inputAmountWei);
  if (oraclePart > cap) oraclePart = cap;
  const dexBps = BigInt(process.env.PHANTOM_DEX_SWAP_FEE_BPS || "10");
  const swapPart = (cap * dexBps) / 10000n;
  return oraclePart + swapPart;
}

/**
 * Repo layout: `phantom-relayer-dashboard/backend/src` in local dev, but serverless
 * bundling can place `src` at `/var/task/src`. Resolve circuit roots defensively.
 */
function firstExistingPath(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return candidates.find(Boolean) || "";
}

const BACKEND_ROOT = path.join(__dirname, "..");
const DASHBOARD_ROOT = path.join(__dirname, "..", "..");
const CORE_ROOT = process.env.PHANTOM_CORE_ROOT || path.join(__dirname, "..", "..", "..");

const PUBLIC9_WASM = firstExistingPath([
  path.join(CORE_ROOT, "Phantom-Smart-Contracts", "circuits", "joinsplit_public9", "build", "joinsplit_public9_js", "joinsplit_public9.wasm"),
  path.join(BACKEND_ROOT, "circuits", "joinsplit_public9_js", "joinsplit_public9.wasm"),
  path.join(DASHBOARD_ROOT, "circuits", "joinsplit_public9_js", "joinsplit_public9.wasm"),
]);
const PUBLIC9_ZKEY = firstExistingPath([
  path.join(CORE_ROOT, "Phantom-Smart-Contracts", "circuits", "joinsplit_public9", "circuit_final.zkey"),
  path.join(BACKEND_ROOT, "circuits", "joinsplit_public9_final.zkey"),
  path.join(DASHBOARD_ROOT, "circuits", "joinsplit_public9_final.zkey"),
]);
const LEGACY_WASM = firstExistingPath([
  path.join(BACKEND_ROOT, "circuits", "joinsplit_js", "joinsplit.wasm"),
  path.join(DASHBOARD_ROOT, "circuits", "joinsplit_js", "joinsplit.wasm"),
]);
const LEGACY_ZKEY = firstExistingPath([
  path.join(BACKEND_ROOT, "circuits", "joinsplit_0001.zkey"),
  path.join(DASHBOARD_ROOT, "circuits", "joinsplit_0001.zkey"),
]);
const PORTFOLIO_WASM = process.env.PORTFOLIO_WASM || firstExistingPath([
  path.join(BACKEND_ROOT, "circuits", "portfolio_note_js", "portfolio_note.wasm"),
  path.join(DASHBOARD_ROOT, "circuits", "portfolio_note_js", "portfolio_note.wasm"),
]);
const PORTFOLIO_ZKEY = process.env.PORTFOLIO_ZKEY || firstExistingPath([
  path.join(BACKEND_ROOT, "circuits", "portfolio_note_0001.zkey"),
  path.join(DASHBOARD_ROOT, "circuits", "portfolio_note_0001.zkey"),
]);

function getRapidsnarkPath() {
  return process.env.RAPIDSNARK_PATH;
}
const CIRCUITS_DIR = firstExistingPath([
  path.join(BACKEND_ROOT, "circuits"),
  path.join(DASHBOARD_ROOT, "circuits"),
]);

const DEV_BYPASS_PROOFS = process.env.DEV_BYPASS_PROOFS === "true";

function resolveProverPaths() {
  if (process.env.PROVER_WASM?.trim() && process.env.PROVER_ZKEY?.trim()) {
    const w = process.env.PROVER_WASM.trim();
    const z = process.env.PROVER_ZKEY.trim();
    const usePublic9 = w.includes("joinsplit_public9") || z.includes("joinsplit_public9");
    return { wasmPath: w, zkeyPath: z, usePublic9 };
  }
  if (fs.existsSync(PUBLIC9_WASM) && fs.existsSync(PUBLIC9_ZKEY)) {
    return { wasmPath: PUBLIC9_WASM, zkeyPath: PUBLIC9_ZKEY, usePublic9: true };
  }
  return { wasmPath: LEGACY_WASM, zkeyPath: LEGACY_ZKEY, usePublic9: false };
}

/** Flat witness keys for `joinsplit_public9.circom` (matches `main.*` in the compiled .sym). */
function toJoinSplitPublic9ProverInputs(ci) {
  const outSwap = BigInt(ci.outputCommitmentSwap || 0);
  const withdrawMode = outSwap === 0n ? "1" : "0";
  const pathArr = [];
  const idxArr = [];
  for (let i = 0; i < 10; i++) {
    pathArr.push(String(ci.merklePath[i] ?? "0"));
    idxArr.push(String(ci.merklePathIndices[i] ?? "0"));
  }
  return {
    inputAssetID: String(ci.inputAssetID),
    inputAmount: String(ci.inputAmount),
    inputBlindingFactor: String(ci.inputBlindingFactor),
    ownerPublicKey: String(ci.ownerPublicKey),
    outputAssetIDSwap: String(ci.outputAssetIDSwap),
    outputAmountSwapNote: String(ci.outputAmountSwapNote ?? ci.outputAmountSwapPublic ?? "0"),
    swapBlindingFactor: String(ci.swapBlindingFactor),
    outputAssetIDChange: String(ci.outputAssetIDChange),
    changeAmount: String(ci.changeAmount),
    changeBlindingFactor: String(ci.changeBlindingFactor),
    swapAmount: String(ci.swapAmount),
    withdrawMode,
    protocolFeeWitness: String(ci.protocolFee),
    gasRefundWitness: String(ci.gasRefund),
    minOutputAmountSwapWitness: String(ci.minOutputAmountSwap),
    merklePath: pathArr,
    merklePathIndices: idxArr,
  };
}

function swapCircuitToPublicInputs(ci) {
  const pub = {
    nullifier: String(ci.nullifier),
    inputCommitment: String(ci.inputCommitment),
    outputCommitmentSwap: String(ci.outputCommitmentSwap),
    outputCommitmentChange: String(ci.outputCommitmentChange),
    merkleRoot: String(ci.merkleRoot),
    inputAssetID: Number(ci.inputAssetID),
    outputAssetIDSwap: Number(ci.outputAssetIDSwap),
    outputAssetIDChange: Number(ci.outputAssetIDChange),
    inputAmount: String(ci.inputAmount),
    swapAmount: String(ci.swapAmount),
    changeAmount: String(ci.changeAmount),
    outputAmountSwap: String(ci.outputAmountSwapPublic),
    minOutputAmountSwap: String(ci.minOutputAmountSwap),
    gasRefund: String(ci.gasRefund),
    protocolFee: String(ci.protocolFee),
    merklePath: [...ci.merklePath],
    merklePathIndices: [...ci.merklePathIndices],
  };
  const withdrawMode = BigInt(pub.outputCommitmentSwap) === 0n ? 1n : 0n;
  const r0 = mimc7(BigInt(pub.inputAssetID), BigInt(pub.outputAssetIDSwap));
  const r1 = mimc7(r0, BigInt(pub.outputAssetIDChange));
  const r2 = mimc7(r1, BigInt(pub.inputAmount));
  const r3 = mimc7(r2, BigInt(pub.swapAmount));
  const r4 = mimc7(r3, BigInt(pub.changeAmount));
  const r5 = mimc7(r4, BigInt(pub.outputAmountSwap));
  const r6 = mimc7(r5, BigInt(pub.minOutputAmountSwap));
  const r7 = mimc7(r6, BigInt(pub.protocolFee));
  const r8 = mimc7(r7, BigInt(pub.gasRefund));
  pub.routingCommitment = mimc7(r8, withdrawMode).toString();
  return pub;
}

const proofStats = { swap: [], withdraw: [], portfolio: [], lastError: null };
const MAX_STATS = 50;

function recordProofStats(type, elapsedMs, success = true) {
  proofStats[type].push({ elapsedMs, success, ts: Date.now() });
  if (proofStats[type].length > MAX_STATS) proofStats[type].shift();
  if (!success) proofStats.lastError = { type, ts: Date.now() };
}

function getProofStats() {
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  return {
    swap: { count: proofStats.swap.length, avgMs: avg(proofStats.swap.map((s) => s.elapsedMs)), recent: proofStats.swap.slice(-5) },
    withdraw: { count: proofStats.withdraw.length, avgMs: avg(proofStats.withdraw.map((s) => s.elapsedMs)), recent: proofStats.withdraw.slice(-5) },
    portfolio: { count: proofStats.portfolio.length, avgMs: avg(proofStats.portfolio.map((s) => s.elapsedMs)), recent: proofStats.portfolio.slice(-5) },
    lastError: proofStats.lastError,
    rapidsnarkEnabled: !!getRapidsnarkPath()
  };
}

async function proveWithRapidsnarkOrSnarkjs(circuitInputs, wasmPath, zkeyPath, circuitType = "joinsplit") {
  const startTime = Date.now();

  const rapidsnarkPath = getRapidsnarkPath();
  if (rapidsnarkPath && fs.existsSync(rapidsnarkPath) && fs.existsSync(wasmPath) && fs.existsSync(zkeyPath)) {
    const tmpDir = os.tmpdir();
    const prefix = path.join(tmpDir, `phantom_proof_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const inputPath = `${prefix}_input.json`;
    const wtnsPath = `${prefix}_witness.wtns`;
    const proofPath = `${prefix}_proof.json`;
    const publicPath = `${prefix}_public.json`;

    try {
      fs.writeFileSync(inputPath, JSON.stringify(circuitInputs, null, 0));

      const witnessDir =
        circuitType === "portfolio"
          ? path.join(CIRCUITS_DIR, "portfolio_note_js")
          : circuitType === "joinsplit_public9"
            ? path.join(
                CORE_ROOT,
                "Phantom-Smart-Contracts",
                "circuits",
                "joinsplit_public9",
                "build",
                "joinsplit_public9_js"
              )
            : path.join(CIRCUITS_DIR, "joinsplit_js");
      const genWitnessPath = path.join(witnessDir, "generate_witness.js");
      if (!fs.existsSync(genWitnessPath)) throw new Error("generate_witness.js not found");
      await new Promise((resolve, reject) => {
        const proc = spawn("node", [genWitnessPath, wasmPath, inputPath, wtnsPath], { stdio: "pipe" });
        let err = "";
        proc.stderr?.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `witness gen exit ${code}`))));
      });

      if (!fs.existsSync(wtnsPath)) throw new Error("Witness file not created");

      await new Promise((resolve, reject) => {
        const proc = spawn(rapidsnarkPath, [zkeyPath, wtnsPath, proofPath, publicPath], { stdio: "pipe" });
        let err = "";
        proc.stderr?.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `rapidsnark exit ${code}`))));
      });

      const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
      const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));

      [inputPath, wtnsPath, proofPath, publicPath].forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });

      const solidityProof = {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
        c: [proof.pi_c[0], proof.pi_c[1]]
      };
      const elapsed = Date.now() - startTime;
      console.log(`✅ Proof generated in ${elapsed}ms (rapidsnark)`);
      return { proof: solidityProof, publicSignals, generationTime: elapsed };
    } catch (rapidErr) {
      console.warn("Rapidsnark failed, falling back to snarkjs:", rapidErr.message);
      [inputPath, wtnsPath, proofPath, publicPath].forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
    }
  }

  let proof;
  let publicSignals;
  let proverName = "snarkjs";

  // @zk-kit/groth16 can reject some witness shapes; joinsplit_public9 is tiny — use snarkjs only.
  if (zkKitProve && circuitType !== "joinsplit_public9") {
    try {
      const result = await zkKitProve(circuitInputs, wasmPath, zkeyPath);
      proof = result.proof;
      publicSignals = result.publicSignals;
      proverName = "zk-kit";
    } catch (_) {
      
    }
  }
  if (!proof) {
    const result = await snarkjs.groth16.fullProve(circuitInputs, wasmPath, zkeyPath);
    proof = result.proof;
    publicSignals = result.publicSignals;
  }

  const elapsed = Date.now() - startTime;
  console.log(`✅ Proof generated in ${elapsed}ms (${proverName})`);
  const solidityProof = {
    a: [String(proof.pi_a[0]), String(proof.pi_a[1])],
    b: [
      [String(proof.pi_b[0][1]), String(proof.pi_b[0][0])],
      [String(proof.pi_b[1][1]), String(proof.pi_b[1][0])]
    ],
    c: [String(proof.pi_c[0]), String(proof.pi_c[1])]
  };
  return { proof: solidityProof, snarkProof: proof, publicSignals, generationTime: elapsed };
}

async function generateSwapProof(swapData) {
  const {
    inputNote,
    outputNoteSwap,
    outputNoteChange,
    merkleRoot,
    merklePath,
    merklePathIndices,
    swapAmount,
    minOutputAmount,
    protocolFee,
    gasRefund
  } = swapData;

  const formatMerklePath = (path) => {
    if (!Array.isArray(path)) return Array(10).fill("0");
    const formatted = path.slice(0, 10).map(v => {
      if (!v || v === "0x0" || v === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        return "0";
      }
      return toBigIntString(v);
    });
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };
  
  const formatMerkleIndices = (indices) => {
    if (!Array.isArray(indices)) return Array(10).fill("0");
    const formatted = indices.slice(0, 10).map(v => {
      const num = toBigInt(v);
      return String(num % 2n); 

    });
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };

  const inputAmountWeiBn = toBigInt(inputNote.amount);
  let resolvedProtocolFeeStr = String(protocolFee ?? "0");
  const useChainProtocolFee = process.env.PHANTOM_USE_CHAIN_PROTOCOL_FEE !== "false";
  if (useChainProtocolFee && process.env.RPC_URL && process.env.SHIELDED_POOL_ADDRESS) {
    try {
      const total = await getJoinSplitTotalProtocolFeeWei(Number(inputNote.assetID), inputAmountWeiBn);
      resolvedProtocolFeeStr = total.toString();
      console.log(
        `   ℹ️ Protocol fee aligned with chain (oracle + ${process.env.PHANTOM_DEX_SWAP_FEE_BPS || "10"} bps DEX): ${resolvedProtocolFeeStr}`
      );
    } catch (e) {
      console.warn("[zk] Using request protocolFee (on-chain fee resolve failed):", e.message);
    }
  }

  const circuitInputs = {

    inputAssetID: inputNote.assetID.toString(),
    inputAmount: toBigIntString(inputNote.amount),
    inputBlindingFactor: toBigIntString(inputNote.blindingFactor),
    ownerPublicKey: toBigIntString(inputNote.ownerPublicKey),

    outputAssetIDSwap: outputNoteSwap.assetID.toString(),
    outputAmountSwap: toBigIntString(outputNoteSwap.amount),
    swapBlindingFactor: toBigIntString(outputNoteSwap.blindingFactor),

    outputAssetIDChange: outputNoteChange.assetID.toString(),
    changeAmount: toBigIntString(outputNoteChange.amount),
    changeBlindingFactor: toBigIntString(outputNoteChange.blindingFactor),

    swapAmount: toBigIntString(swapAmount),

    nullifier: toBigIntString(inputNote.nullifier),
    inputCommitment: toBigIntString(inputNote.commitment),
    outputCommitmentSwap: toBigIntString(outputNoteSwap.commitment),
    outputCommitmentChange: toBigIntString(outputNoteChange.commitment),
    merkleRoot: toBigIntString(merkleRoot),
    outputAmountSwapPublic: toBigIntString(outputNoteSwap.amount),
    minOutputAmountSwap: toBigIntString(minOutputAmount),
    protocolFee: toBigIntString(resolvedProtocolFeeStr),
    gasRefund: toBigIntString(gasRefund),

    merklePath: formatMerklePath(merklePath),
    merklePathIndices: formatMerkleIndices(merklePathIndices)
  };

  const mimcCommitment = (assetId, amount, blinding, ownerKey) =>
    computeCommitment(assetId, amount, blinding, ownerKey).toString();

  const mimcNullifier = (commitment, ownerKey) =>
    computeNullifier(commitment, ownerKey).toString();

  if (circuitInputs.outputAssetIDChange !== circuitInputs.inputAssetID) {
    if (ZK_VERBOSE_DEBUG) console.log(
      `   ⚠️ Adjusting outputAssetIDChange to match inputAssetID: ${circuitInputs.outputAssetIDChange} -> ${circuitInputs.inputAssetID}`
    );
    circuitInputs.outputAssetIDChange = circuitInputs.inputAssetID;
    circuitInputs.outputCommitmentChange = mimcCommitment(
      BigInt(circuitInputs.outputAssetIDChange),
      BigInt(circuitInputs.changeAmount),
      BigInt(circuitInputs.changeBlindingFactor),
      BigInt(circuitInputs.ownerPublicKey)
    );
  }

  const expectedNullifier = mimcNullifier(
    BigInt(circuitInputs.inputCommitment),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedNullifier !== circuitInputs.nullifier) {
    if (ZK_VERBOSE_DEBUG) console.log(
      `   ⚠️ Recomputing nullifier: ${circuitInputs.nullifier} -> ${expectedNullifier}`
    );
    circuitInputs.nullifier = expectedNullifier;
  }

  if (ZK_VERBOSE_DEBUG) {
    try {
      const debugPath = path.join(__dirname, "..", "..", "circuits", "debug_last_swap_inputs.json");
      fs.writeFileSync(debugPath, JSON.stringify(circuitInputs, null, 2));
    } catch (e) {
      // ignore debug write errors
    }
  }

  if (BigInt(circuitInputs.outputAmountSwapPublic) !== BigInt(circuitInputs.outputAmountSwap)) {
    if (ZK_VERBOSE_DEBUG) console.log(
      `   ⚠️ Aligning outputAmountSwapPublic to outputAmountSwap: ${circuitInputs.outputAmountSwapPublic} -> ${circuitInputs.outputAmountSwap}`
    );
    circuitInputs.outputAmountSwapPublic = circuitInputs.outputAmountSwap;
  }

  const inputAmountBigInt = toBigInt(inputNote.amount);
  const swapAmountBigInt = toBigInt(swapAmount);
  const protocolFeeBigInt = toBigInt(resolvedProtocolFeeStr);
  const gasRefundBigInt = toBigInt(gasRefund);
  const changeAmountBigInt = toBigInt(outputNoteChange.amount);
  const expectedChange = inputAmountBigInt - swapAmountBigInt - protocolFeeBigInt - gasRefundBigInt;
  if (expectedChange <= 0n) {
    throw new Error(
      "Swap leaves no change note (ShieldedPool PoolErr(19): changeAmount must be non-zero). " +
        "Reduce swap amount, protocol fee, or gas refund so input > swap + fees."
    );
  }
  if (expectedChange !== changeAmountBigInt) {
    if (ZK_VERBOSE_DEBUG) console.log(
      `   ⚠️ Adjusting changeAmount to satisfy conservation: ${changeAmountBigInt} -> ${expectedChange}`
    );
    circuitInputs.changeAmount = expectedChange.toString();
    const outputAssetIDChange = BigInt(circuitInputs.outputAssetIDChange);
    const changeBlindingFactor = BigInt(circuitInputs.changeBlindingFactor);
    const ownerPublicKey = BigInt(circuitInputs.ownerPublicKey);
    circuitInputs.outputCommitmentChange = mimcCommitment(
      outputAssetIDChange,
      expectedChange,
      changeBlindingFactor,
      ownerPublicKey
    );
  }

  const expectedInputCommitment = mimcCommitment(
    BigInt(circuitInputs.inputAssetID),
    BigInt(circuitInputs.inputAmount),
    BigInt(circuitInputs.inputBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedInputCommitment !== circuitInputs.inputCommitment) {
    console.log(
      `   ❗ Input commitment mismatch (circuit vs provided): ${expectedInputCommitment} != ${circuitInputs.inputCommitment}`
    );
  }

  const expectedSwapCommitment = mimcCommitment(
    BigInt(circuitInputs.outputAssetIDSwap),
    BigInt(circuitInputs.outputAmountSwap),
    BigInt(circuitInputs.swapBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedSwapCommitment !== circuitInputs.outputCommitmentSwap) {
    console.log(
      `   ⚠️ Recomputing outputCommitmentSwap: ${circuitInputs.outputCommitmentSwap} -> ${expectedSwapCommitment}`
    );
    circuitInputs.outputCommitmentSwap = expectedSwapCommitment;
  }

  const expectedChangeCommitment = mimcCommitment(
    BigInt(circuitInputs.outputAssetIDChange),
    BigInt(circuitInputs.changeAmount),
    BigInt(circuitInputs.changeBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedChangeCommitment !== circuitInputs.outputCommitmentChange) {
    console.log(
      `   ⚠️ Recomputing outputCommitmentChange: ${circuitInputs.outputCommitmentChange} -> ${expectedChangeCommitment}`
    );
    circuitInputs.outputCommitmentChange = expectedChangeCommitment;
  }

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.nullifier,
      circuitInputs.inputCommitment,
      circuitInputs.outputCommitmentSwap,
      circuitInputs.outputCommitmentChange,
      circuitInputs.merkleRoot,
      circuitInputs.outputAmountSwapPublic,
      circuitInputs.minOutputAmountSwap,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      publicInputs: swapCircuitToPublicInputs(circuitInputs),
      generationTime: 0
    };
  }

  const prover = resolveProverPaths();
  if (prover.usePublic9) {
    console.log("[zk] joinsplit_public9 prover (matches on-chain JoinSplitVerifier.sol / circuit_final.zkey)");
  } else {
    console.warn("[zk] legacy joinsplit.wasm prover — must match deployed verifier or proofs will fail on-chain");
  }
  if (!fs.existsSync(prover.wasmPath) || !fs.existsSync(prover.zkeyPath)) {
    throw new Error(
      "Prover wasm/zkey not found on this server. For Vercel/serverless set PROVER_WASM and PROVER_ZKEY to reachable paths, " +
        "or bundle Phantom-Smart-Contracts/circuits/joinsplit_public9 build artifacts. " +
        `wasm=${prover.wasmPath} zkey=${prover.zkeyPath}`
    );
  }

  const fieldAdd = (a, b) => {
    return (a + b) % FIELD;
  };
  const fieldSub = (a, b) => {
    const result = (a - b) % FIELD;

    return result < 0n ? result + FIELD : result;
  };
  const fieldMul = (a, b) => {
    return (a * b) % FIELD;
  };
  
  let computedRoot = BigInt(circuitInputs.inputCommitment);
  
  if (ZK_VERBOSE_DEBUG) {
    console.log(`🔍 Verifying Merkle path (circuit logic with proper field arithmetic):`);
    console.log(`   Starting with commitment: 0x${computedRoot.toString(16).padStart(64, "0")}`);
  }
  
  for (let i = 0; i < 10; i++) {
    const pathValue = BigInt(circuitInputs.merklePath[i]);
    const idx = BigInt(circuitInputs.merklePathIndices[i]);

    const leftDiff = fieldSub(pathValue, computedRoot);
    const left = fieldAdd(computedRoot, fieldMul(idx, leftDiff));
    const rightDiff = fieldSub(computedRoot, pathValue);
    const right = fieldAdd(pathValue, fieldMul(idx, rightDiff));

    computedRoot = mimc7(left, right);
    
    if (ZK_VERBOSE_DEBUG && i < 3) {
      console.log(`   Level ${i}: idx=${idx}, left=0x${left.toString(16).substring(0, 16)}..., right=0x${right.toString(16).substring(0, 16)}..., hash=0x${computedRoot.toString(16).substring(0, 16)}...`);
    }
  }
  
  const expectedRoot = BigInt(circuitInputs.merkleRoot);
  if (ZK_VERBOSE_DEBUG) {
    console.log(`   Final computed root: 0x${computedRoot.toString(16).padStart(64, "0")}`);
    console.log(`   Expected root:       0x${expectedRoot.toString(16).padStart(64, "0")}`);
  }
  
  if (computedRoot !== expectedRoot) {
    console.error(`❌ Merkle root mismatch!`);
    if (ZK_VERBOSE_DEBUG) {
      console.error(`   Computed (MiMC7): 0x${computedRoot.toString(16).padStart(64, "0")}`);
      console.error(`   Expected:         0x${expectedRoot.toString(16).padStart(64, "0")}`);
      console.error(`   ⚠️  This should match if backend is using MiMC7 correctly`);
      console.error(`   ⚠️  Continuing anyway - circuit will fail but we can see the exact error...`);
    }
  } else if (ZK_VERBOSE_DEBUG) {
    console.log(`✅ Merkle path verification passed (MiMC7)`);
  }
  
  console.log("🔐 Generating swap proof...");

  const computedRootFromPath = computedRoot; 

  const merkleRootBigInt = BigInt(circuitInputs.merkleRoot);
  if (ZK_VERBOSE_DEBUG) {
    console.log(`\n🔍 Root Comparison:`);
    console.log(`   Computed from path: 0x${computedRootFromPath.toString(16).padStart(64, "0")}`);
    console.log(`   Passed to circuit:  0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
    console.log(`   Match: ${computedRootFromPath === merkleRootBigInt ? "✅ YES" : "❌ NO"}`);
    console.log(`\n🔍 VERIFYING CIRCUIT COMPUTATION STEP-BY-STEP (SIMPLIFIED - MATCHES SOLIDITY):`);
  }
  let circuitComputedRoot = BigInt(circuitInputs.inputCommitment);
  for (let i = 0; i < 10; i++) {
    const pathVal = BigInt(circuitInputs.merklePath[i]);
    const idx = BigInt(circuitInputs.merklePathIndices[i]);

    const left = ((1n - idx) * circuitComputedRoot + idx * pathVal) % FIELD;
    const right = (idx * circuitComputedRoot + (1n - idx) * pathVal) % FIELD;

    const leftNorm = left < 0n ? left + FIELD : left;
    const rightNorm = right < 0n ? right + FIELD : right;
    
    const oldRoot = circuitComputedRoot;
    circuitComputedRoot = mimc7(leftNorm, rightNorm);

    if (ZK_VERBOSE_DEBUG && i < 3) {
      console.log(`   Level ${i}:`);
      console.log(`     path=${pathVal.toString().substring(0, 20)}...`);
      console.log(`     idx=${idx}`);
      console.log(`     left=${leftNorm.toString().substring(0, 20)}...`);
      console.log(`     right=${rightNorm.toString().substring(0, 20)}...`);
      console.log(`     oldRoot=${oldRoot.toString().substring(0, 20)}...`);
      console.log(`     newRoot=${circuitComputedRoot.toString().substring(0, 20)}...`);
    } else if (ZK_VERBOSE_DEBUG && i >= 7) {
      console.log(`   Level ${i}: path=${pathVal.toString().substring(0, 20)}..., idx=${idx}, computed=${circuitComputedRoot.toString().substring(0, 20)}...`);
    }
  }
  if (ZK_VERBOSE_DEBUG) {
    console.log(`   Final circuit computed root: ${circuitComputedRoot.toString()}`);
    console.log(`   Expected merkleRoot: ${merkleRootBigInt.toString()}`);
    console.log(`   Match: ${circuitComputedRoot === merkleRootBigInt ? "✅ YES" : "❌ NO"}`);
  }
  if (circuitComputedRoot !== merkleRootBigInt) {
    console.error(`   ❌ CRITICAL MISMATCH!`);
    console.error(`      Computed: 0x${circuitComputedRoot.toString(16).padStart(64, "0")}`);
    console.error(`      Expected: 0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
    console.error(`      Difference: ${(circuitComputedRoot - merkleRootBigInt).toString()}`);
  }
  if (circuitComputedRoot !== merkleRootBigInt) {
    console.error(`   ❌ MISMATCH! Circuit would compute: 0x${circuitComputedRoot.toString(16).padStart(64, "0")}`);
    console.error(`      But we're passing: 0x${merkleRootBigInt.toString(16).padStart(64, "0")}`);
  }

  if (!prover.usePublic9 && ZK_VERBOSE_DEBUG) {
    try {
      const witness = await snarkjs.wtns.calculate(circuitInputs, prover.wasmPath);
      console.log(`   ✅ Witness generated successfully - all constraints passed!`);
      console.log(`   This means the issue is in proof generation, not constraints.`);
    } catch (witnessError) {
      console.error(`   ❌ Witness generation failed!`);
      console.error(`   Error: ${witnessError.message}`);
      console.error(`   Stack: ${witnessError.stack}`);
      console.error(`   This indicates a CONSTRAINT VIOLATION.`);
      console.error(`   The circuit's computation doesn't match the inputs.`);

      if (witnessError.message.includes("line:")) {
        const lineMatch = witnessError.message.match(/line:\s*(\d+)/);
        if (lineMatch) {
          const lineNum = lineMatch[1];
          console.error(`   Failed at circuit line: ${lineNum}`);
          if (lineNum === "166") {
            console.error(`   This is the Merkle root constraint!`);
            console.error(`   Let's verify the exact values being compared...`);
          }
        }
      }

      console.error(`   Continuing to fullProve to get more details...`);
    }
  }

  const startTime = Date.now();

  try {
    console.log(`\n🔍 Generating proof...`);
    const proverInputs = prover.usePublic9 ? toJoinSplitPublic9ProverInputs(circuitInputs) : circuitInputs;
    const witnessKind = prover.usePublic9 ? "joinsplit_public9" : "joinsplit";
    const result = await proveWithRapidsnarkOrSnarkjs(proverInputs, prover.wasmPath, prover.zkeyPath, witnessKind);
    recordProofStats("swap", result.generationTime, true);
    return { ...result, publicInputs: swapCircuitToPublicInputs(circuitInputs) };
  } catch (error) {
    recordProofStats("swap", Date.now() - startTime, false);
    console.error("❌ Proof generation failed:", error.message);
    logProofFailure("generateSwapProof", error);
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}

async function generateWithdrawProof(withdrawData) {
  const {
    inputNote,
    outputNoteChange,
    merkleRoot,
    merklePath,
    merklePathIndices,
    withdrawAmount,
    protocolFee,
    gasRefund
  } = withdrawData;

  const formatMerklePath = (path) => {
    if (!Array.isArray(path)) return Array(10).fill("0");
    const formatted = path.slice(0, 10).map((v) => {
      if (!v || v === "0x0" || v === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        return "0";
      }
      return toBigIntString(v);
    });
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };

  const formatMerkleIndices = (indices) => {
    if (!Array.isArray(indices)) return Array(10).fill("0");
    const formatted = indices.slice(0, 10).map((v) => String(toBigInt(v) % 2n));
    while (formatted.length < 10) formatted.push("0");
    return formatted;
  };

  const mimcCommitment = (assetId, amount, blinding, ownerKey) =>
    computeCommitment(assetId, amount, blinding, ownerKey).toString();

  const mimcNullifier = (commitment, ownerKey) =>
    computeNullifier(commitment, ownerKey).toString();

  const inputAmountBigInt = toBigInt(inputNote.amount);
  const protocolFeeBigInt = toBigInt(protocolFee);
  const gasRefundBigInt = toBigInt(gasRefund);
  let swapAmountForWithdraw;
  let changeAmtBig;
  if (withdrawAmount != null && String(withdrawAmount).trim() !== "") {
    swapAmountForWithdraw = toBigInt(withdrawAmount);
    changeAmtBig = inputAmountBigInt - swapAmountForWithdraw - protocolFeeBigInt - gasRefundBigInt;
  } else {
    changeAmtBig = toBigInt(outputNoteChange.amount);
    swapAmountForWithdraw = inputAmountBigInt - changeAmtBig - protocolFeeBigInt - gasRefundBigInt;
  }
  if (swapAmountForWithdraw <= 0n) {
    throw new Error("Withdraw: withdraw leg (swapAmount) must be positive");
  }
  if (changeAmtBig <= 0n) {
    throw new Error("Withdraw: change amount must be positive (ShieldedPool requirement)");
  }

  const changeAmtStr = changeAmtBig.toString();
  const changeBlinding = toBigIntString(outputNoteChange.blindingFactor);
  let outAssetChange = outputNoteChange.assetID.toString();
  if (String(outAssetChange) !== String(inputNote.assetID)) {
    outAssetChange = String(inputNote.assetID);
  }
  const changeCommitment = mimcCommitment(
    BigInt(outAssetChange),
    BigInt(changeAmtStr),
    BigInt(changeBlinding),
    BigInt(toBigIntString(inputNote.ownerPublicKey))
  );

  const circuitInputs = {
    inputAssetID: inputNote.assetID.toString(),
    inputAmount: toBigIntString(inputNote.amount),
    inputBlindingFactor: toBigIntString(inputNote.blindingFactor),
    ownerPublicKey: toBigIntString(inputNote.ownerPublicKey),

    outputAssetIDSwap: "0",
    outputAmountSwap: "0",
    swapBlindingFactor: "0",

    outputAssetIDChange: outAssetChange,
    changeAmount: changeAmtStr,
    changeBlindingFactor: changeBlinding,

    swapAmount: swapAmountForWithdraw.toString(),

    nullifier: toBigIntString(inputNote.nullifier),
    inputCommitment: toBigIntString(inputNote.commitment),
    outputCommitmentSwap: "0",

    outputCommitmentChange: changeCommitment,
    merkleRoot: toBigIntString(merkleRoot),
    outputAmountSwapPublic: "0",

    minOutputAmountSwap: "0",

    protocolFee: toBigIntString(protocolFee),
    gasRefund: toBigIntString(gasRefund),

    merklePath: formatMerklePath(merklePath),
    merklePathIndices: formatMerkleIndices(merklePathIndices)
  };

  const expectedNullifier = mimcNullifier(
    BigInt(circuitInputs.inputCommitment),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedNullifier !== circuitInputs.nullifier) {
    circuitInputs.nullifier = expectedNullifier;
  }

  const expectedInputCommitment = mimcCommitment(
    BigInt(circuitInputs.inputAssetID),
    BigInt(circuitInputs.inputAmount),
    BigInt(circuitInputs.inputBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedInputCommitment !== circuitInputs.inputCommitment) {
    throw new Error("Withdraw: input commitment does not match note fields (MiMC7)");
  }

  const expectedChangeCommitment = mimcCommitment(
    BigInt(circuitInputs.outputAssetIDChange),
    BigInt(circuitInputs.changeAmount),
    BigInt(circuitInputs.changeBlindingFactor),
    BigInt(circuitInputs.ownerPublicKey)
  );
  if (expectedChangeCommitment !== circuitInputs.outputCommitmentChange) {
    circuitInputs.outputCommitmentChange = expectedChangeCommitment;
  }

  const publicInputsOut = swapCircuitToPublicInputs(circuitInputs);

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.nullifier,
      circuitInputs.inputCommitment,
      circuitInputs.outputCommitmentSwap,
      circuitInputs.outputCommitmentChange,
      circuitInputs.merkleRoot,
      circuitInputs.outputAmountSwapPublic,
      circuitInputs.minOutputAmountSwap,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      publicInputs: publicInputsOut,
      generationTime: 0
    };
  }

  console.log("🔐 Generating withdrawal proof...");
  const startTime = Date.now();

  try {
    const prover = resolveProverPaths();
    if (!fs.existsSync(prover.wasmPath) || !fs.existsSync(prover.zkeyPath)) {
      throw new Error(
        "Prover wasm/zkey not found on this server. Set PROVER_WASM and PROVER_ZKEY or bundle joinsplit_public9 artifacts. " +
          `wasm=${prover.wasmPath} zkey=${prover.zkeyPath}`
      );
    }
    const proverInputs = prover.usePublic9 ? toJoinSplitPublic9ProverInputs(circuitInputs) : circuitInputs;
    const witnessKind = prover.usePublic9 ? "joinsplit_public9" : "joinsplit";
    const result = await proveWithRapidsnarkOrSnarkjs(proverInputs, prover.wasmPath, prover.zkeyPath, witnessKind);
    recordProofStats("withdraw", result.generationTime, true);
    return { ...result, publicInputs: publicInputsOut };
  } catch (error) {
    recordProofStats("withdraw", Date.now() - startTime, false);
    console.error("❌ Proof generation failed:", error.message);
    logProofFailure("generateWithdrawProof", error);
    throw new Error(`Proof generation failed: ${error.message}`);
  }
}

async function generatePortfolioProof(inputs) {

  const circuitInputs = {
    oldBalances: (inputs.oldBalances || []).map(toBigIntString),
    newBalances: (inputs.newBalances || []).map(toBigIntString),
    oldBlindingFactor: toBigIntString(inputs.oldBlindingFactor),
    newBlindingFactor: toBigIntString(inputs.newBlindingFactor),
    ownerPublicKey: toBigIntString(inputs.ownerPublicKey),
    oldNonce: toBigIntString(inputs.oldNonce),
    newNonce: toBigIntString(inputs.newNonce),
    oldCommitment: toBigIntString(inputs.oldCommitment),
    newCommitment: toBigIntString(inputs.newCommitment),
    inputAssetID: toBigIntString(inputs.inputAssetID),
    outputAssetID: toBigIntString(inputs.outputAssetID),
    swapAmount: toBigIntString(inputs.swapAmount),
    outputAmount: toBigIntString(inputs.outputAmount),
    minOutputAmount: toBigIntString(inputs.minOutputAmount),
    protocolFee: toBigIntString(inputs.protocolFee),
    gasRefund: toBigIntString(inputs.gasRefund)
  };

  if (DEV_BYPASS_PROOFS) {
    const publicSignals = [
      circuitInputs.oldCommitment,
      circuitInputs.newCommitment,
      circuitInputs.oldNonce,
      circuitInputs.newNonce,
      circuitInputs.inputAssetID,
      circuitInputs.outputAssetID,
      circuitInputs.swapAmount,
      circuitInputs.outputAmount,
      circuitInputs.minOutputAmount,
      circuitInputs.protocolFee,
      circuitInputs.gasRefund
    ];
    return {
      proof: { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] },
      publicSignals,
      generationTime: 0
    };
  }

  const startTime = Date.now();
  try {
    const result = await proveWithRapidsnarkOrSnarkjs(circuitInputs, PORTFOLIO_WASM, PORTFOLIO_ZKEY, "portfolio");
    recordProofStats("portfolio", result.generationTime, true);
    return result;
  } catch (error) {
    recordProofStats("portfolio", Date.now() - startTime, false);
    throw error;
  }
}

async function generateNoteProof(noteData, merkleProof) {

  const proof = {
    proof: [0, 0, 0, 0, 0, 0, 0, 0], 

    publicInputs: [
      noteData.noteHash,
      noteData.userAddress,
      merkleProof.root,
      Math.floor(Date.now() / 1000)
    ]
  };

  return proof;
}

module.exports = {
  generateSwapProof,
  generateWithdrawProof,
  generateNoteProof,
  generatePortfolioProof,
  getProofStats
};
