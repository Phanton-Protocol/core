require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { z } = require("zod");
const snarkjs = require("snarkjs");
const {
  initDb,
  saveIntent,
  getIntent,
  saveReceipt,
  getReceipt,
  listReceipts,
  saveQuote,
  exportAll,
  saveCommitment,
  listCommitments,
  getCommitment
} = require("./db");
const { mimc7 } = require("./mimc7");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

loadConfig();

const PORT = process.env.PORT || 5050;
const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const SHIELDED_POOL_ADDRESS = process.env.SHIELDED_POOL_ADDRESS;
const OFFCHAIN_ORACLE_ADDRESS = process.env.OFFCHAIN_ORACLE_ADDRESS;
const ORACLE_SIGNER_PRIVATE_KEY = process.env.ORACLE_SIGNER_PRIVATE_KEY;
const CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 97;
const RELAYER_DRY_RUN = process.env.RELAYER_DRY_RUN === "true";
const QUOTE_MODE = process.env.QUOTE_MODE || (CHAIN_ID === 97 ? "mock" : "dex");
const PROVER_WASM = process.env.PROVER_WASM || path.join(__dirname, "..", "..", "circuits", "joinsplit.wasm");
const PROVER_ZKEY = process.env.PROVER_ZKEY || path.join(__dirname, "..", "..", "circuits", "joinsplit_0001.zkey");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "relayer.db");

const db = initDb(DB_PATH);

const INTENT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: ethers.ZeroAddress,
};
const DEPOSIT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
};

const INTENT_TYPES = {
  SwapIntent: [
    { name: "nullifier", type: "bytes32" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "protocolFee", type: "uint256" },
    { name: "gasRefund", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const DEPOSIT_TYPES = {
  Deposit: [
    { name: "depositor", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "assetID", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const receipts = new Map();
const intents = new Map();
const poolInterface = new ethers.Interface([
  "event CommitmentAdded(bytes32 indexed commitment, uint256 index)",
  "event Deposit(address indexed depositor, address indexed token, uint256 assetID, uint256 amount, bytes32 commitment, uint256 commitmentIndex)",
  "event ShieldedSwapJoinSplit(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentSwap, bytes32 outputCommitmentChange, uint256 inputAssetID, uint256 outputAssetIDSwap, uint256 outputAssetIDChange, uint256 inputAmount, uint256 swapAmount, uint256 changeAmount, uint256 outputAmountSwap, address relayer)",
  "event ShieldedWithdraw(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentChange, address recipient, uint256 inputAssetID, uint256 withdrawAmount, uint256 changeAmount, address relayer)"
]);

const dexApiToken = "https://api.dexscreener.com/latest/dex/tokens/";

const quoteSchema = z.object({
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z.string(),
  tokenInDecimals: z.number().int().min(0).max(36).optional(),
  tokenOutDecimals: z.number().int().min(0).max(36).optional(),
  slippageBps: z.number().int().min(0).max(1000).default(50),
  chainSlug: z.string().optional(),
});

const intentSchema = z.object({
  userAddress: z.string(),
  nullifier: z.string(),
  minOutputAmount: z.string(),
  protocolFee: z.string(),
  gasRefund: z.string(),
  deadline: z.number().int(),
});

const swapSchema = z.object({
  intentId: z.string(),
  intent: intentSchema,
  intentSig: z.string(),
  swapData: z.object({
    proof: z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
    }),
    publicInputs: z.any(),
    swapParams: z.any(),
    relayer: z.string().optional(),
    encryptedPayload: z.string().optional(),
  }),
});

const withdrawSchema = z.object({
  withdrawData: z.object({
    proof: z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
    }),
    publicInputs: z.any(),
    relayer: z.string().optional(),
    recipient: z.string(),
    encryptedPayload: z.string().optional(),
  }),
});

const depositSchema = z.object({
  depositor: z.string(),
  token: z.string(),
  amount: z.string(),
  commitment: z.string(),
  assetID: z.number().int(),
  deadline: z.number().int(),
  signature: z.string(),
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { tokenIn, tokenOut, amountIn, tokenInDecimals, tokenOutDecimals, slippageBps, chainSlug } = parsed.data;

  let priceIn;
  let priceOut;
  
  // Try DEXScreener API first for real-time prices
  try {
    priceIn = await getDexPriceUsd(tokenIn, chainSlug);
    priceOut = await getDexPriceUsd(tokenOut, chainSlug);
  } catch (dexError) {
    console.warn(`DEXScreener failed: ${dexError.message}, trying PancakeSwap fallback`);
    
    // Fallback: Use realistic mock prices for testnet (DEXScreener often doesn't have testnet data)
    const mockPrices = {
      "0x0000000000000000000000000000000000000000": 60000000000n, // BNB = $600
      "0xae13d989dac2f0debff460ac112a837c89baa7cd": 60000000000n, // WBNB = $600
      "0x7ef95a0fee0dd31b22626fa2e10ee6a223f8a684": 100000000n,   // tUSDT = $1
      "0x64544969ed7ebf5f083679233325356ebe738930": 100000000n,   // tUSDC = $1
      "0x78867bbeef44f2326bf8ddd1941a4439382ef2a7": 100000000n,   // tBUSD = $1
      "0xfa60d973f7642b748046464e165a65b7323b0dee": 500000000n,   // tCAKE = $5
      "0x8babbb98678facc7342735486c851abd7a0d17ca": 300000000000n, // tETH = $3000
      "0x6ce8da28e2f864420840cf74474eff5fd80e65b8": 6000000000000n, // tBTCB = $60000
      // Mainnet tokens (use real DEXScreener prices when available)
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": 60000000000n, // WBNB mainnet
      "0x55d398326f99059ff775485246999027b3197955": 100000000n,   // USDT mainnet
      "0xe9e7cea3dedca5984780bafc599bd69add087d56": 100000000n,   // BUSD mainnet
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 100000000n,   // USDC mainnet
      "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": 500000000n,   // CAKE mainnet
      "0x2170ed0880ac9a755fd29b2688956bd959f933f8": 300000000000n, // ETH mainnet
      "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": 6000000000000n, // BTCB mainnet
    };
    
    priceIn = mockPrices[tokenIn.toLowerCase()] || 100000000n;
    priceOut = mockPrices[tokenOut.toLowerCase()] || 100000000n;
    
    console.log(`Using fallback prices: tokenIn=${tokenIn} @ $${Number(priceIn)/1e8}, tokenOut=${tokenOut} @ $${Number(priceOut)/1e8}`);
  }

  const amountInBn = parseAmount(amountIn);
  const inDecimals = BigInt(tokenInDecimals ?? 18);
  const outDecimals = BigInt(tokenOutDecimals ?? 18);
  const usdValue = (amountInBn * priceIn) / 10n ** inDecimals;
  const outAmount = (usdValue * 10n ** outDecimals) / priceOut;
  const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;
  const oracleFeeUsd = calcOracleFeeUsd(usdValue);
  const oracleFeeToken = (oracleFeeUsd * 10n ** inDecimals) / priceIn;
  const swapFeeToken = (amountInBn * 5n) / 100000n;
  const totalFeeToken = oracleFeeToken + swapFeeToken;

  const payload = {
    amountOut: outAmount.toString(),
    minAmountOut: minOut.toString(),
    priceIn: priceIn.toString(),
    priceOut: priceOut.toString(),
    fees: {
      oracleFee: oracleFeeToken.toString(),
      swapFee: swapFeeToken.toString(),
      totalFee: totalFeeToken.toString(),
      oracleFeeUsd: oracleFeeUsd.toString()
    }
  };
  saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))), null, payload);
  res.json(payload);
});

app.post("/intent", async (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const payload = parsed.data;
  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({ ...payload, t: Date.now() }))
  );
  intents.set(intentId, payload);
  saveIntent(db, intentId, payload.userAddress, payload);
  res.json({ intentId, intent: payload, domain: INTENT_DOMAIN, types: INTENT_TYPES });
});

app.post("/swap", async (req, res) => {
  const parsed = swapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { intentId, intent, intentSig, swapData } = parsed.data;
  const cached = intents.get(intentId) || getIntent(db, intentId)?.payload;
  if (!cached) {
    return res.status(404).json({ error: "Unknown intentId" });
  }

  const signerAddr = ethers.verifyTypedData(INTENT_DOMAIN, INTENT_TYPES, intent, intentSig);
  if (signerAddr.toLowerCase() !== intent.userAddress.toLowerCase()) {
    return res.status(400).json({ error: "Invalid intent signature" });
  }

  const txResult = RELAYER_DRY_RUN
    ? await simulateSwap(intentId)
    : await submitSwap(swapData);

  const receipt = buildReceipt(intentId, swapData, txResult);
  receipts.set(intentId, receipt);
  saveReceipt(db, intentId, intent.userAddress, receipt);

  res.json({
    version: "1.0",
    intentId,
    swapOutput: {
      amount: receipt.outputAmountSwap || "0",
      assetId: receipt.outputAssetIdSwap || 0,
      minAmount: intent.minOutputAmount,
    },
    commitments: {
      swap: receipt.outputCommitmentSwap || ethers.ZeroHash,
      change: receipt.outputCommitmentChange || ethers.ZeroHash,
    },
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    encryptedPayload: receipt.encryptedPayload,
  });
});

app.post("/withdraw", async (req, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { withdrawData } = parsed.data;
  const txResult = RELAYER_DRY_RUN
    ? await simulateSwap(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(withdrawData))))
    : await submitWithdraw(withdrawData);
  res.json(txResult);
});

app.get("/relayer", (req, res) => {
  if (!RELAYER_PRIVATE_KEY) return res.status(500).json({ error: "Relayer not configured" });
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
  res.json({ relayer: relayer.address });
});

app.post("/deposit", async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const payload = parsed.data;
  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Deposit expired" });
  }
  const signerAddr = ethers.verifyTypedData(DEPOSIT_DOMAIN, DEPOSIT_TYPES, {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: payload.assetID,
    deadline: payload.deadline,
  }, payload.signature);
  if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
    return res.status(400).json({ error: "Invalid deposit signature" });
  }
  const txResult = await submitDeposit(payload);
  res.json(txResult);
});

app.get("/receipt/:intentId", (req, res) => {
  const receipt = receipts.get(req.params.intentId) || getReceipt(db, req.params.intentId);
  if (!receipt) return res.status(404).json({ error: "Not found" });
  res.json(receipt);
});

app.get("/history/:address", (req, res) => {
  const address = req.params.address;
  const list = listReceipts(db, address, 50);
  res.json(list);
});

app.get("/export", (req, res) => {
  const data = exportAll(db);
  res.json(data);
});

app.get("/merkle/:commitment", async (req, res) => {
  try {
    const commitment = req.params.commitment;
    const row = getCommitment(db, commitment);
    if (!row) return res.status(404).json({ error: "commitment not found" });
    const leaves = buildLeaves(listCommitments(db));
    const { path, indices, root } = buildMerklePath(leaves, row.idx);
    res.json({ commitment, index: row.idx, merkleRoot: root, merklePath: path, merklePathIndices: indices });
  } catch (err) {
    res.status(500).json({ error: err.message || "merkle failed" });
  }
});

app.post("/oracle/update", async (req, res) => {
  const { tokenAddress, chainSlug } = req.body || {};
  if (!tokenAddress) return res.status(400).json({ error: "tokenAddress required" });
  if (!OFFCHAIN_ORACLE_ADDRESS || !ORACLE_SIGNER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Oracle env not configured" });
  }

  const price = await getDexPriceUsd(tokenAddress, chainSlug);
  const tx = await updateOraclePrice(tokenAddress, price);
  res.json({ txHash: tx.hash, price: price.toString() });
});

app.post("/prove", async (req, res) => {
  const inputs = req.body;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      PROVER_WASM,
      PROVER_ZKEY
    );
    const formatted = formatProofForContract(proof);
    res.json({ proof: formatted, publicSignals });
  } catch (err) {
    res.status(500).json({ error: err.message || "prove failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Relayer API running on :${PORT}`);
});

async function getDexPriceUsd(tokenAddress, chainSlug) {
  const { data } = await axios.get(`${dexApiToken}${tokenAddress}`);
  if (!data?.pairs?.length) throw new Error("No Dexscreener pairs");
  const pairs = chainSlug ? data.pairs.filter((p) => p.chainId === chainSlug) : data.pairs;
  if (!pairs.length) throw new Error("No pairs for chain");
  const best = pairs.reduce((a, b) => {
    const la = Number(a?.liquidity?.usd || 0);
    const lb = Number(b?.liquidity?.usd || 0);
    return lb > la ? b : a;
  }, pairs[0]);
  if (!best?.priceUsd) throw new Error("No priceUsd");
  return BigInt(Math.floor(Number(best.priceUsd) * 1e8));
}

async function submitSwap(swapData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function shieldedSwapJoinSplit((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),(address,address,uint256,uint256,uint24,uint160,bytes),address,bytes) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
  const tx = await contract.shieldedSwapJoinSplit(swapData);
  const receipt = await tx.wait();
  storeCommitmentsFromReceipt(receipt);
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function submitWithdraw(withdrawData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function shieldedWithdraw((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),address,address,bytes) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
  const tx = await contract.shieldedWithdraw(withdrawData);
  const receipt = await tx.wait();
  storeCommitmentsFromReceipt(receipt);
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function submitDeposit(payload) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  
  // Shadow address flow: relayer deposits on behalf of user
  if (payload.token === ethers.ZeroAddress) {
    // BNB deposit via shadow address
    const abi = [
      "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositForBNB(
      payload.depositor,
      payload.commitment,
      payload.assetID,
      { value: payload.amount }
    );
    const receipt = await tx.wait();
    storeCommitmentsFromReceipt(receipt);
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  } else {
    // ERC20 deposit via shadow address
    const abi = [
      "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositFor(
      payload.depositor,
      payload.token,
      payload.amount,
      payload.commitment,
      payload.assetID
    );
    const receipt = await tx.wait();
    storeCommitmentsFromReceipt(receipt);
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  }
}

function storeCommitmentsFromReceipt(receipt) {
  if (!receipt?.logs) return;
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== SHIELDED_POOL_ADDRESS?.toLowerCase()) continue;
    try {
      const parsed = poolInterface.parseLog(log);
      if (parsed?.name === "CommitmentAdded") {
        const commitment = parsed.args.commitment;
        const idx = Number(parsed.args.index);
        saveCommitment(db, idx, commitment, receipt.hash);
      }
      if (parsed?.name === "Deposit") {
        const commitment = parsed.args.commitment;
        const idx = Number(parsed.args.commitmentIndex);
        saveCommitment(db, idx, commitment, receipt.hash);
      }
    } catch (_) {}
  }
}

function buildLeaves(rows) {
  const depth = 10;
  const size = 1 << depth;
  const leaves = new Array(size).fill(0n);
  for (const row of rows) {
    const idx = Number(row.idx);
    if (idx >= 0 && idx < size) {
      leaves[idx] = BigInt(row.commitment);
    }
  }
  return leaves;
}

function buildMerklePath(leaves, index) {
  const depth = 10;
  let idx = index;
  let layer = leaves;
  const path = [];
  const indices = [];
  for (let d = 0; d < depth; d += 1) {
    const sibling = idx ^ 1;
    path.push(`0x${layer[sibling].toString(16).padStart(64, "0")}`);
    indices.push(idx % 2);
    const next = new Array(layer.length / 2);
    for (let i = 0; i < next.length; i += 1) {
      const left = layer[i * 2];
      const right = layer[i * 2 + 1];
      next[i] = mimc7(left, right);
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  const root = `0x${layer[0].toString(16).padStart(64, "0")}`;
  return { path, indices, root };
}

async function simulateSwap(intentId) {
  const fake = ethers.keccak256(ethers.toUtf8Bytes(intentId));
  return { txHash: fake, blockNumber: 0 };
}

function buildReceipt(intentId, swapData, txResult) {
  const inputs = swapData.publicInputs || {};
  return {
    version: "1.0",
    intentId,
    nullifier: inputs.nullifier || ethers.ZeroHash,
    inputCommitment: inputs.inputCommitment || ethers.ZeroHash,
    outputCommitmentSwap: inputs.outputCommitmentSwap || ethers.ZeroHash,
    outputCommitmentChange: inputs.outputCommitmentChange || ethers.ZeroHash,
    inputAssetId: inputs.inputAssetID || 0,
    outputAssetIdSwap: inputs.outputAssetIDSwap || 0,
    outputAssetIdChange: inputs.outputAssetIDChange || 0,
    inputAmount: String(inputs.inputAmount || "0"),
    swapAmount: String(inputs.swapAmount || "0"),
    changeAmount: String(inputs.changeAmount || "0"),
    outputAmountSwap: String(inputs.outputAmountSwap || "0"),
    protocolFee: String(inputs.protocolFee || "0"),
    gasRefund: String(inputs.gasRefund || "0"),
    txHash: txResult.txHash,
    blockNumber: txResult.blockNumber,
    encryptedPayload: swapData.encryptedPayload || "0x",
    relayer: swapData.relayer || ethers.ZeroAddress,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function parseAmount(value) {
  if (typeof value !== "string") return BigInt(value);
  if (value.includes(".")) {
    return ethers.parseUnits(value, 18);
  }
  return BigInt(value);
}

function calcOracleFeeUsd(usdValue) {
  // Minimum fee: $10 (with 8 decimals = 10 * 10^8)
  const feeFloor = 10n * 10n ** 8n;
  // Percentage fee: 0.5% of USD value (5 / 1000 = 0.005 = 0.5%)
  const percentageFee = (usdValue * 5n) / 1000n;
  // Return whichever is higher
  return percentageFee > feeFloor ? percentageFee : feeFloor;
}

async function updateOraclePrice(tokenAddress, price) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(ORACLE_SIGNER_PRIVATE_KEY, provider);
  const oracleAbi = [
    "function updatePrice((address token,uint256 price,uint256 timestamp,uint256 nonce) update, bytes signature) external",
  ];
  const oracle = new ethers.Contract(OFFCHAIN_ORACLE_ADDRESS, oracleAbi, signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = timestamp;

  const domain = {
    name: "OffchainPriceOracle",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: OFFCHAIN_ORACLE_ADDRESS,
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
  return oracle.updatePrice(value, signature);
}

function loadConfig() {
  const cfgPath = path.join(__dirname, "..", "config.json");
  if (!fs.existsSync(cfgPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    Object.entries(raw).forEach(([k, v]) => {
      if (process.env[k] === undefined) process.env[k] = String(v);
    });
  } catch (_) {}
}

function formatProofForContract(proof) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const a = coder.encode(["uint256[2]"], [[proof.pi_a[0], proof.pi_a[1]]]);
  const b = coder.encode(
    ["uint256[2][2]"],
    [[[proof.pi_b[0][0], proof.pi_b[0][1]], [proof.pi_b[1][0], proof.pi_b[1][1]]]]
  );
  const c = coder.encode(["uint256[2]"], [[proof.pi_c[0], proof.pi_c[1]]]);
  return { a, b, c };
}
