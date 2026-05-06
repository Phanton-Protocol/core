require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
  getCommitment,
  saveEncryptedNote,
  getEncryptedNote,
  listEncryptedNotesByOwner,
  saveDepositSession,
  getDepositSessionByIdempotencyKey,
  getDepositSessionBySessionId,
  saveDepositTxReceipt
} = require("./db");
const { mimc7 } = require("./mimc7");
const { canonicalizeNote, noteIdFromCanonical, normalizeHex32 } = require("./noteModel");
const { encryptJsonAtRest, decryptJsonAtRest, getNotesEncryptionKey } = require("./noteCipher");
const { buildMerklePath: buildMerklePath10, verifyMerklePath: verifyMerklePath10 } = require("./merkle10");
const { toBigInt, toBigIntString } = require("./utils/bigint");
const ValidatorNetwork = require("./validatorNetwork");
const { generateSwapProof, generateWithdrawProof, generatePortfolioProof, getProofStats } = require("./zkProofs");
const { assertWithdrawJoinSplitPublicInputs } = require("./withdrawValidate");
const fheMatchingRouter = require("./fheMatchingService");
const { registerOrderAndTryMatch, getFheMatchMode, assertFheProductionSafety, deriveFheSecurityPolicy } = require("./fheMatchingService");
const { createEnterpriseRouter } = require("./enterpriseRoutes");
const { getSeeConfig, verifyAttestation, requireSeeForSensitiveFlow } = require("./seeGuard");
const { logRelayerOnchainFailure, logProofFailure } = require("./relayerLog");
const { assertNoMockRuntimeGate } = require("./noMockRuntimeGate");
const { pushTransaction, getSnapshot } = require("./relayerActivityBuffer");
const { computeCanonicalAlignmentWarnings } = require("./configAlignment");
const { createInternalOrderRouter } = require("./internalOrderRoutes");
const { createSettlementCoordinator, createOnchainInternalMatchSubmitter } = require("./settlementCoordinator");
const { createComplianceEngine } = require("./complianceEngine");
const {
  assertRelayerRegistered,
  sendDepositForErc20,
  sendDepositForBnb,
  logModule4
} = require("./module4Deposit");
const { assertIntentNullifierMatchesSwapPublicInputs, canonicalNullifierHex } = require("./swapIntentBinding");
const { evaluateInternalMatchingGuardrails } = require("./internalMatchingGuardrails");

/** Vercel deploys only `phantom-relayer-dashboard/backend/`; repo-root JSON is not on the serverless bundle. */
function loadFrozenProductionConfig() {
  const candidates = [
    path.join(__dirname, "..", "frozenProductionConfig.json"),
    path.join(__dirname, "..", "..", "..", "frozenProductionConfig.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error(
    "frozenProductionConfig.json not found. For Vercel, keep a copy at phantom-relayer-dashboard/backend/frozenProductionConfig.json (sync with repo root)."
  );
}
const FROZEN_PRODUCTION_CONFIG = loadFrozenProductionConfig();

/** EIP-55 checksum; accepts any casing (fixes mixed-case typos from UIs / APIs). */
function normalizeEvmAddress(addr) {
  if (addr == null || addr === "") return addr;
  const s = String(addr).trim();
  if (s.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return ethers.ZeroAddress;
  try {
    return ethers.getAddress(s);
  } catch {
    return ethers.getAddress(s.toLowerCase());
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    return cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  credentials: true
}));
app.use("/fhe", fheMatchingRouter);
const enterpriseRouter = createEnterpriseRouter();
app.use("/enterprise", enterpriseRouter);

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 30_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const MODULE4_DEPOSIT_API_SECRET = process.env.MODULE4_DEPOSIT_API_SECRET || "";
const MODULE4_PUBLIC_SUBMIT =
  process.env.MODULE4_PUBLIC_SUBMIT === "true" ||
  (process.env.NODE_ENV !== "production" && process.env.MODULE4_PUBLIC_SUBMIT !== "false");
const MODULE4_SESSION_TTL_MS = Number(process.env.MODULE4_SESSION_TTL_MS || 15 * 60 * 1000);
const MODULE4_RATE_WINDOW_MS = Number(process.env.MODULE4_RATE_WINDOW_MS || 60_000);
const MODULE4_RATE_MAX = Number(process.env.MODULE4_RATE_MAX || 40);
const MODULE4_MAX_BNB_WEI = (() => {
  try {
    return BigInt(process.env.MODULE4_MAX_BNB_WEI || "50000000000000000");
  } catch {
    return 50000000000000000n;
  }
})();
const SHADOW_SWEEP_GAS_BUFFER_WEI = (() => {
  try {
    return BigInt(process.env.SHADOW_SWEEP_GAS_BUFFER_WEI || "2000000000000000"); // 0.002 BNB
  } catch {
    return 2000000000000000n;
  }
})();
const CHAINALYSIS_ENABLED = process.env.CHAINALYSIS_ENABLED === "true";
const CHAINALYSIS_API_KEY = String(process.env.CHAINALYSIS_API_KEY || "").trim();
const CHAINALYSIS_API_URL = String(process.env.CHAINALYSIS_API_URL || "").trim();
/** Free sanctions API: GET https://public.chainalysis.com/api/v1/address/{addr} + header X-API-Key */
const CHAINALYSIS_USE_PUBLIC_SANCTIONS_API =
  process.env.CHAINALYSIS_USE_PUBLIC_API === "true" ||
  CHAINALYSIS_API_URL.includes("public.chainalysis.com") ||
  (CHAINALYSIS_API_KEY && !CHAINALYSIS_API_URL);
const rlBuckets = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const bucket = rlBuckets.get(key) || { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 0 };
  if (now > bucket.resetAt) {
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  rlBuckets.set(key, bucket);
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "rate_limited", retryAfterMs: bucket.resetAt - now });
  }
  return next();
}
app.use(rateLimit);

const module4RlBuckets = new Map();
function module4RateLimit(req, res, next) {
  const key = `m4:${req.ip || req.headers["x-forwarded-for"] || "unknown"}`;
  const now = Date.now();
  const bucket = module4RlBuckets.get(key) || { resetAt: now + MODULE4_RATE_WINDOW_MS, count: 0 };
  if (now > bucket.resetAt) {
    bucket.resetAt = now + MODULE4_RATE_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  module4RlBuckets.set(key, bucket);
  if (bucket.count > MODULE4_RATE_MAX) {
    return res.status(429).json({ error: "module4_rate_limited", retryAfterMs: bucket.resetAt - now });
  }
  return next();
}

function requireModule4SubmitAuth(req, res, next) {
  if (MODULE4_PUBLIC_SUBMIT) return next();
  if (!MODULE4_DEPOSIT_API_SECRET) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({ error: "module4_submit_requires_MODULE4_DEPOSIT_API_SECRET_or_MODULE4_PUBLIC_SUBMIT" });
    }
    console.warn("[module4] submit allowed without auth (dev only; set MODULE4_DEPOSIT_API_SECRET for staging)");
    return next();
  }
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : req.headers["x-module4-secret"];
  if (token !== MODULE4_DEPOSIT_API_SECRET) {
    return res.status(401).json({ error: "invalid_module4_auth" });
  }
  return next();
}

const RELAYER_ENC_PRIVATE_KEY_PEM = process.env.RELAYER_ENC_PRIVATE_KEY_PEM || "";
const RELAYER_ENC_PRIVATE_KEY_PEM_B64 = process.env.RELAYER_ENC_PRIVATE_KEY_PEM_B64 || "";
let relayerEncPublicKeyPem = "";
let relayerEncPrivateKeyPem = "";
let relayerEncKeyId = "";
{
  let resolvedPem = "";
  if (RELAYER_ENC_PRIVATE_KEY_PEM.trim()) {
    resolvedPem = RELAYER_ENC_PRIVATE_KEY_PEM;
  } else if (RELAYER_ENC_PRIVATE_KEY_PEM_B64.trim()) {
    try {
      resolvedPem = Buffer.from(RELAYER_ENC_PRIVATE_KEY_PEM_B64.trim(), "base64").toString("utf8");
    } catch {
      resolvedPem = "";
    }
  }
  if (resolvedPem.trim()) {
    relayerEncPrivateKeyPem = resolvedPem;
    relayerEncPublicKeyPem = crypto.createPublicKey(relayerEncPrivateKeyPem).export({ type: "spki", format: "pem" });
  } else {
    const generated = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    relayerEncPublicKeyPem = generated.publicKey;
    relayerEncPrivateKeyPem = generated.privateKey;
  }
  relayerEncKeyId = crypto.createHash("sha256").update(relayerEncPublicKeyPem).digest("hex").slice(0, 16);
}

function decryptRelayEnvelope(envelope) {
  const encryptedKey = Buffer.from(String(envelope?.encryptedKey || ""), "base64");
  const iv = Buffer.from(String(envelope?.iv || ""), "base64");
  const ciphertext = Buffer.from(String(envelope?.ciphertext || ""), "base64");
  const authTag = Buffer.from(String(envelope?.authTag || ""), "base64");
  if (!encryptedKey.length || !iv.length || !ciphertext.length || !authTag.length) {
    throw new Error("Invalid encrypted envelope fields");
  }
  const aesKey = crypto.privateDecrypt(
    {
      key: relayerEncPrivateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    encryptedKey
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

loadConfig();

const PORT = process.env.PORT || 5050;
const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const SHIELDED_POOL_ADDRESS = process.env.SHIELDED_POOL_ADDRESS;
process.env.SHIELDED_POOL_ADDRESS = SHIELDED_POOL_ADDRESS || process.env.SHIELDED_POOL_ADDRESS || "";
const NOTE_STORAGE_ADDRESS = process.env.NOTE_STORAGE_ADDRESS;
const OFFCHAIN_ORACLE_ADDRESS = process.env.OFFCHAIN_ORACLE_ADDRESS;
const ORACLE_SIGNER_PRIVATE_KEY = process.env.ORACLE_SIGNER_PRIVATE_KEY;
const PROTOCOL_DUST_RECIPIENT = process.env.PROTOCOL_DUST_RECIPIENT || process.env.PROTOCOL_FEE_RECIPIENT || "";
const CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 97;
const RELAYER_DRY_RUN = process.env.RELAYER_DRY_RUN === "true";
const DEV_BYPASS_VALIDATORS = process.env.DEV_BYPASS_VALIDATORS === "true";
const DEV_BYPASS_PROOFS = process.env.DEV_BYPASS_PROOFS === "true";
const PHANTOM_DEPLOYMENT_TIER_RAW = String(process.env.PHANTOM_DEPLOYMENT_TIER || "").toLowerCase().trim();
const PHANTOM_EMERGENCY_BYPASS_DEV_FLAGS = process.env.PHANTOM_EMERGENCY_BYPASS_DEV_FLAGS === "true";
const SWAP_ADAPTOR_ADDRESS = process.env.SWAP_ADAPTOR_ADDRESS;
const RELAYER_STAKING_ADDRESS = process.env.RELAYER_STAKING_ADDRESS;
const VALIDATOR_COORDINATOR_WS_URL = process.env.VALIDATOR_COORDINATOR_WS_URL;
const QUOTE_MODE = process.env.QUOTE_MODE || (CHAIN_ID === 97 ? "mock" : "dex");
const NODE_ENV = process.env.NODE_ENV || "development";
const PROVER_WASM = process.env.PROVER_WASM || path.join(__dirname, "..", "..", "circuits", "joinsplit_js", "joinsplit.wasm");
const PROVER_ZKEY = process.env.PROVER_ZKEY || path.join(__dirname, "..", "..", "circuits", "joinsplit_0001.zkey");
const DB_PATH = (process.env.VERCEL || process.env.RENDER) ? "/tmp/relayer.db" : (process.env.DB_PATH || path.join(__dirname, "..", "data", "relayer.db"));
const CONFIG_DIR = process.env.PHANTOM_CONFIG_DIR || path.join(__dirname, "..", "..", "..", "config");
const CONFIG_PATH = process.env.PHANTOM_CONFIG_PATH || "";
const CANONICAL_PROFILES_PATH = process.env.PHANTOM_CANONICAL_PROFILES_PATH || path.join(CONFIG_DIR, "canonicalProfiles.json");
const CANONICAL_PROFILE_ID = process.env.PHANTOM_CANONICAL_PROFILE || "";
const FROZEN_DEPLOYMENT_VERSION = String(FROZEN_PRODUCTION_CONFIG.version || "").trim();
const FALLBACK_ASSETS_BY_CHAIN = {
  97: [
    { assetId: 0, symbol: "WBNB", decimals: 18, address: "0xae13d989dac2f0debff460ac112a837c89baa7cd" },
    { assetId: 1, symbol: "BUSD", decimals: 18, address: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
    { assetId: 2, symbol: "USDT", decimals: 18, address: "0x798562974aDAC3a11768D0739832c1c9Cf5EE590" },
  ],
  56: [
    { assetId: 0, symbol: "WBNB", decimals: 18, address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
    { assetId: 1, symbol: "BUSD", decimals: 18, address: "0xe9e7cea3dedca5984780bafc599bd69add087d56" },
    { assetId: 2, symbol: "USDT", decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" },
  ],
};
const REQUIRED_BSC_TESTNET_ASSETS = Object.freeze([
  { assetId: 0, symbol: "WBNB", address: "0xae13d989dac2f0debff460ac112a837c89baa7cd" },
  { assetId: 1, symbol: "BUSD", address: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
  { assetId: 2, symbol: "USDT", address: "0x798562974aDAC3a11768D0739832c1c9Cf5EE590" },
]);
const CHAINALYSIS_FAIL_CLOSED = process.env.CHAINALYSIS_FAIL_CLOSED !== "false";
const RELAYER_REQUIRE_ENCRYPTED_ENVELOPE = process.env.RELAYER_REQUIRE_ENCRYPTED_ENVELOPE !== "false";
const RELAYER_SWAP_ATTESTATION_MODE = String(process.env.RELAYER_SWAP_ATTESTATION_MODE || "hash_first_with_fallback").toLowerCase();
const RELAYER_PRIVACY_HARD_SWITCH = process.env.RELAYER_PRIVACY_HARD_SWITCH !== "false";
const PLACEHOLDER_RELAYER_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function toBps(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function toBig(v, fallback) {
  try {
    if (v === undefined || v === null || v === "") return BigInt(fallback);
    return BigInt(v);
  } catch (_) {
    return BigInt(fallback);
  }
}

const RUNTIME_PARAMS = {
  profile: {
    id: "unresolved",
    source: "defaults",
  },
  fees: {
    // Policy targets (override with env when needed)
    dexSwapFeeBps: toBps(process.env.PHANTOM_DEX_SWAP_FEE_BPS, 10), // 0.1%
    internalMatchFeeBps: toBps(process.env.PHANTOM_INTERNAL_MATCH_FEE_BPS, 20), // 0.2%
    depositFeeUsdE8: toBig(process.env.PHANTOM_DEPOSIT_FEE_USD_E8, 2n * 10n ** 8n),
    oracleFeeFloorUsdE8: toBig(process.env.PHANTOM_ORACLE_FEE_FLOOR_USD_E8, 10n * 10n ** 8n),
    oracleFeeRateBps: toBps(process.env.PHANTOM_ORACLE_FEE_BPS, 50), // 0.5%
  },
};

function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

let db;
try {
  db = initDb(DB_PATH);
  if (process.env.RENDER) {
    console.log("[Render] RENDER env set; using DB_PATH=" + DB_PATH);
  }
} catch (e) {
  console.error("initDb failed:", e.message);
  if (DB_PATH !== "/tmp/relayer.db") {
    try {
      console.warn("Falling back to /tmp/relayer.db (read-only filesystem?)");
      db = initDb("/tmp/relayer.db");
    } catch (e2) {
      console.error("Fallback initDb(/tmp) failed:", e2.message);
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}

function assertStagingProductionBypassPolicy() {
  if (PHANTOM_DEPLOYMENT_TIER_RAW !== "staging" && PHANTOM_DEPLOYMENT_TIER_RAW !== "production") return;
  if (PHANTOM_EMERGENCY_BYPASS_DEV_FLAGS) {
    console.warn(
      "[PHANTOM] PHANTOM_EMERGENCY_BYPASS_DEV_FLAGS=true — DEV_BYPASS_VALIDATORS/DEV_BYPASS_PROOFS allowed on staging|production (documented emergency only; rotate off ASAP)"
    );
    return;
  }
  if (DEV_BYPASS_VALIDATORS || DEV_BYPASS_PROOFS) {
    throw new Error(
      "PHANTOM_DEPLOYMENT_TIER=staging|production forbids DEV_BYPASS_VALIDATORS and DEV_BYPASS_PROOFS (set PHANTOM_EMERGENCY_BYPASS_DEV_FLAGS=true only for documented emergency recovery)"
    );
  }
}

function assertProductionReadiness() {
  if (NODE_ENV !== "production") return;
  const guardrailErrors = evaluateInternalMatchingGuardrails(process.env, {
    seeConfig: getSeeConfig(),
    deriveFheSecurityPolicy,
  });
  if (!guardrailErrors.ok) {
    throw new Error(`Production startup blocked by internal matching guardrails: ${guardrailErrors.errors.join(" | ")}`);
  }
  if (DEV_BYPASS_VALIDATORS || DEV_BYPASS_PROOFS) {
    throw new Error("Production startup blocked: DEV_BYPASS_VALIDATORS/DEV_BYPASS_PROOFS must be false.");
  }
  if (!process.env.CORS_ORIGINS || !String(process.env.CORS_ORIGINS).trim()) {
    throw new Error("Production startup blocked: CORS_ORIGINS must be explicitly configured.");
  }
  if (!RELAYER_DRY_RUN) {
    if (!RELAYER_PRIVATE_KEY || String(RELAYER_PRIVATE_KEY).trim() === "" || String(RELAYER_PRIVATE_KEY).toLowerCase() === PLACEHOLDER_RELAYER_KEY) {
      throw new Error("Production startup blocked: valid RELAYER_PRIVATE_KEY is required.");
    }
    if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
      throw new Error("Production startup blocked: RPC_URL and SHIELDED_POOL_ADDRESS are required.");
    }
  }
  const seeMode = String(process.env.SEE_MODE || "disabled").toLowerCase();
  if (seeMode !== "disabled" && !process.env.SEE_SHARED_SECRET) {
    throw new Error("Production startup blocked: SEE_SHARED_SECRET is required when SEE_MODE is enabled.");
  }
  assertFheProductionSafety();
}
assertStagingProductionBypassPolicy();
assertProductionReadiness();
assertRuntimeParameterConsistency();

const VALIDATOR_URLS = process.env.VALIDATOR_URLS
  ? process.env.VALIDATOR_URLS.split(',').map((u) => u.trim()).filter(Boolean)
  : [];
const RELAYER_REQUIRE_VALIDATOR_QUORUM = process.env.RELAYER_REQUIRE_VALIDATOR_QUORUM === "true"; 

const validatorNetwork = new ValidatorNetwork(VALIDATOR_URLS, 6600); 
const complianceEngine = createComplianceEngine({ db });
let settlementSubmitter;
if (String(process.env.SETTLEMENT_SUBMISSION_MODE || "").toLowerCase() === "live_internal_match") {
  try {
    settlementSubmitter = createOnchainInternalMatchSubmitter({
      rpcUrl: process.env.RPC_URL,
      privateKey: process.env.RELAYER_PRIVATE_KEY,
      shieldedPoolAddress: process.env.SHIELDED_POOL_ADDRESS,
    });
  } catch (e) {
    console.warn("[settlement] live internal-match submitter unavailable; falling back to coordinator default:", e.message || e);
  }
}
const settlementCoordinator = createSettlementCoordinator({
  db,
  submitter: settlementSubmitter,
  complianceEngine,
  validatorNetwork,
});

const INTENT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
};
const DEPOSIT_DOMAIN = {
  name: "ShadowDeFiRelayer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
};

const INTENT_TYPES = {
  SwapIntent: [
    { name: "user", type: "address" },
    { name: "inputAssetID", type: "uint256" },
    { name: "outputAssetID", type: "uint256" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
  ],
};
const INTENT_TYPES_V2 = {
  SwapIntentHash: [
    { name: "user", type: "address" },
    { name: "publicInputHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "nullifier", type: "bytes32" },
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
const replayCache = new Map();
const internalOrderRouter = createInternalOrderRouter({
  db,
  chainId: CHAIN_ID,
  verifyingContract: SHIELDED_POOL_ADDRESS || ethers.ZeroAddress,
  complianceEngine,
});

const shadowDeposits = new Map();
const SHADOW_DEPOSITS_FILE = path.join(process.cwd(), "shadow-deposits.json");

function loadShadowDeposits() {
  try {
    if (!fs.existsSync(SHADOW_DEPOSITS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SHADOW_DEPOSITS_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return;
    for (const [addr, data] of Object.entries(raw)) {
      if (!addr || !data) continue;
      shadowDeposits.set(String(addr).toLowerCase(), data);
    }
  } catch (_) {}
}

function persistShadowDeposits() {
  try {
    const out = {};
    for (const [addr, data] of shadowDeposits.entries()) {
      out[addr] = data;
    }
    fs.writeFileSync(SHADOW_DEPOSITS_FILE, JSON.stringify(out), "utf8");
  } catch (_) {}
}

loadShadowDeposits();

function consumeReplayKey(key, ttlSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const existing = replayCache.get(key);
  if (existing && existing > now) return false;
  replayCache.set(key, now + ttlSec);
  if (replayCache.size > 10_000) {
    for (const [k, expiry] of replayCache.entries()) {
      if (expiry <= now) replayCache.delete(k);
    }
  }
  return true;
}

function missingEnv(required) {
  return required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
}

function requireConfigured(res, requiredKeys, featureLabel) {
  const missing = missingEnv(requiredKeys);
  if (missing.length) {
    res.status(503).json({
      error: `${featureLabel} not configured`,
      missing,
      hint: "Set these environment variables and restart the backend. For local dev, put them in phantom-relayer-dashboard/backend/.env",
    });
    return false;
  }
  return true;
}

function readJsonIfExists(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function selectConfigFileByChainId(chainId) {
  if (!chainId) return null;
  const name =
    Number(chainId) === 56 ? "bscMainnet.json"
      : Number(chainId) === 97 ? "bscTestnet.json"
        : null;
  if (!name) return null;
  return path.join(CONFIG_DIR, name);
}

function readCanonicalProfiles() {
  const raw = readJsonIfExists(CANONICAL_PROFILES_PATH);
  return raw && typeof raw === "object" ? raw : null;
}

function resolveCanonicalProfile(chainId) {
  const profiles = readCanonicalProfiles();
  if (!profiles) return null;
  if (CANONICAL_PROFILE_ID && profiles[CANONICAL_PROFILE_ID]) {
    return { id: CANONICAL_PROFILE_ID, profile: profiles[CANONICAL_PROFILE_ID], source: "PHANTOM_CANONICAL_PROFILE" };
  }
  const byChainKey = Number(chainId) === 56 ? "bscMainnet" : Number(chainId) === 97 ? "bscTestnet" : null;
  if (byChainKey && profiles[byChainKey]) {
    return { id: byChainKey, profile: profiles[byChainKey], source: "chainId" };
  }
  return null;
}

function assertRuntimeParameterConsistency() {
  const { dexSwapFeeBps, internalMatchFeeBps, depositFeeUsdE8, oracleFeeFloorUsdE8, oracleFeeRateBps } = RUNTIME_PARAMS.fees;
  if (dexSwapFeeBps <= 0 || internalMatchFeeBps <= 0) {
    throw new Error("Invalid fee parameters: swap fee bps must be > 0.");
  }
  if (internalMatchFeeBps < dexSwapFeeBps) {
    throw new Error("Invalid fee parameters: internal match fee bps must be >= dex swap fee bps.");
  }
  if (depositFeeUsdE8 <= 0n || oracleFeeFloorUsdE8 <= 0n || oracleFeeRateBps <= 0) {
    throw new Error("Invalid fee parameters: deposit/oracle policy values must be > 0.");
  }
}

function getRuntimeConfig() {
  const filePath = CONFIG_PATH || null;
  const fileCfg = readJsonIfExists(filePath) || {};
  const frozen = FROZEN_PRODUCTION_CONFIG || {};
  const normalizeMaybeAddr = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    return normalizeEvmAddress(s);
  };
  const assertSameAddress = (label, expected, actual) => {
    const e = normalizeMaybeAddr(expected);
    const a = normalizeMaybeAddr(actual);
    if (!a) return;
    if (!e || e.toLowerCase() !== a.toLowerCase()) {
      throw new Error(`CONFIG_MISMATCH:${label}: expected ${expected} got ${actual}`);
    }
  };

  const chainId = Number(frozen.chainId ?? 97);
  const rpcUrl = String(process.env.RPC_URL ?? fileCfg.rpcUrl ?? RPC_URL ?? "").trim();
  const addresses = {
    shieldedPool: normalizeMaybeAddr(frozen.addresses?.shieldedPool),
    swapAdaptor: normalizeMaybeAddr(frozen.addresses?.swapAdaptor),
    noteStorage: normalizeMaybeAddr(frozen.addresses?.noteStorage) || null,
    feeOracle: normalizeMaybeAddr(frozen.addresses?.feeOracle),
    relayerStaking: normalizeMaybeAddr(frozen.addresses?.relayerStaking),
    depositHandler: normalizeMaybeAddr(frozen.addresses?.depositHandler),
    matchingHandler: normalizeMaybeAddr(frozen.addresses?.matchingHandler),
    protocolToken: normalizeMaybeAddr(frozen.addresses?.protocolToken),
    fheCoprocessor: normalizeMaybeAddr(frozen.addresses?.fheCoprocessor),
  };

  const assets = Array.isArray(frozen.assets) ? frozen.assets : [];
  if (chainId === 97) {
    for (const req of REQUIRED_BSC_TESTNET_ASSETS) {
      const hit = assets.find((a) => Number(a?.assetId) === req.assetId);
      if (!hit) throw new Error(`CONFIG_MISMATCH: missing required bscTestnet assetId=${req.assetId} (${req.symbol})`);
      if (req.assetId === 0) continue;
      const addr = normalizeMaybeAddr(hit.address);
      const exp = normalizeMaybeAddr(req.address);
      if (!addr || !exp || addr.toLowerCase() !== exp.toLowerCase()) {
        throw new Error(
          `CONFIG_MISMATCH: bscTestnet asset ${req.symbol} address mismatch (expected ${req.address}, got ${hit.address || "unset"})`
        );
      }
    }
  }
  const deploymentVersion = FROZEN_DEPLOYMENT_VERSION;
  if (!deploymentVersion) {
    throw new Error("CONFIG_MISMATCH: missing frozen deployment version");
  }
  if (process.env.PHANTOM_EXPECTED_DEPLOYMENT_VERSION && String(process.env.PHANTOM_EXPECTED_DEPLOYMENT_VERSION) !== deploymentVersion) {
    throw new Error(
      `CONFIG_MISMATCH: expected deployment version ${process.env.PHANTOM_EXPECTED_DEPLOYMENT_VERSION} but frozen config is ${deploymentVersion}`
    );
  }
  assertSameAddress("pool", addresses.shieldedPool, process.env.SHIELDED_POOL_ADDRESS || SHIELDED_POOL_ADDRESS || fileCfg.addresses?.shieldedPool);
  assertSameAddress("oracle", addresses.feeOracle, process.env.OFFCHAIN_ORACLE_ADDRESS || OFFCHAIN_ORACLE_ADDRESS || fileCfg.addresses?.feeOracle);
  assertSameAddress("swapAdaptor", addresses.swapAdaptor, process.env.SWAP_ADAPTOR_ADDRESS || SWAP_ADAPTOR_ADDRESS || fileCfg.addresses?.swapAdaptor);
  assertSameAddress("relayerStaking", addresses.relayerStaking, process.env.RELAYER_STAKING_ADDRESS || RELAYER_STAKING_ADDRESS || fileCfg.addresses?.relayerStaking);
  const requiredForTx =
    RELAYER_DRY_RUN
      ? ["SHIELDED_POOL_ADDRESS"]
      : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  const missingForTx = missingEnv(requiredForTx);
  const mode = missingForTx.length ? "degraded" : "live";
  const resolvedProfile = resolveCanonicalProfile(chainId);
  if (resolvedProfile) {
    RUNTIME_PARAMS.profile = { id: resolvedProfile.id, source: resolvedProfile.source };
  }

  const canonicalProfile = resolvedProfile
    ? {
        id: resolvedProfile.id,
        source: resolvedProfile.source,
        chainId: resolvedProfile.profile?.chainId ?? null,
        addressHints: resolvedProfile.profile?.addresses || null,
      }
    : null;

  const base = {
    mode,
    chainId,
    rpcUrl: rpcUrl || null,
    addresses,
    assets,
    features: {
      relayerOnly: true,
      dryRun: RELAYER_DRY_RUN,
      bypassValidators: DEV_BYPASS_VALIDATORS,
      bypassProofs: DEV_BYPASS_PROOFS,
      quoteMode: QUOTE_MODE,
      chainalysisScreeningEnabled: !!process.env.CHAINALYSIS_API_KEY,
      chainalysisFailClosed: CHAINALYSIS_FAIL_CLOSED,
      fheEnabled: true,
      validatorQuorumEnforced: RELAYER_REQUIRE_VALIDATOR_QUORUM || VALIDATOR_URLS.length > 0,
      validatorUrlCount: VALIDATOR_URLS.length,
    },
    configFile: filePath || null,
    deploymentVersion,
    canonicalProfile,
    missingForTx,
  };
  base.configWarnings = computeCanonicalAlignmentWarnings(base);
  return base;
}

function toAddress(v) {
  if (!v) return ethers.ZeroAddress;
  if (typeof v === "string") return v;
  return (v?.address != null ? String(v.address) : ethers.ZeroAddress) || ethers.ZeroAddress;
}

function getShadowSeed({ depositor, commitment, deadline }) {
  return ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.isHexString(RELAYER_PRIVATE_KEY) ? RELAYER_PRIVATE_KEY : "0x" + Buffer.from(RELAYER_PRIVATE_KEY, "utf8").toString("hex")),
    ethers.getBytes(ethers.zeroPadValue(depositor, 32)),
    ethers.getBytes(commitment),
    ethers.toBeHex(deadline, 32),
  ]));
}

/** One-time withdraw payout shadow (diagram: pool → SA → relayer → user). Domain tag 0x02 vs deposit seed. */
function normalizeNullifierBytes32(nullifier) {
  const s = String(nullifier).trim();
  if (s.startsWith("0x")) return ethers.zeroPadValue(s, 32);
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(s)), 32);
}

function getWithdrawShadowSeed({ finalRecipient, nullifier }) {
  const pk = ethers.isHexString(RELAYER_PRIVATE_KEY) ? RELAYER_PRIVATE_KEY : "0x" + Buffer.from(RELAYER_PRIVATE_KEY, "utf8").toString("hex");
  const addr = ethers.getAddress(String(finalRecipient).trim());
  return ethers.keccak256(ethers.concat([
    ethers.getBytes(pk),
    ethers.getBytes(ethers.zeroPadValue(addr, 32)),
    ethers.getBytes(normalizeNullifierBytes32(nullifier)),
    new Uint8Array([2]),
  ]));
}

async function forwardWithdrawPayoutFromShadow(shadowSigner, finalRecipient) {
  if (!finalRecipient || !ethers.isAddress(finalRecipient)) {
    return { shadowForwardError: "Invalid finalRecipient for shadow forward" };
  }
  const provider = shadowSigner.provider;
  const bal = await provider.getBalance(shadowSigner.address);
  if (bal <= 0n) return { shadowForwardWei: "0", shadowForwardError: "Shadow has zero balance (pool may not have sent native yet)" };
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  if (gasPrice <= 0n) return { shadowForwardError: "Cannot estimate gas price for shadow forward" };
  const gasCost = gasPrice * 21000n;
  if (bal <= gasCost) return { shadowForwardWei: bal.toString(), shadowForwardError: "Insufficient shadow balance after gas reserve" };
  const value = bal - gasCost;
  try {
    const tx = await shadowSigner.sendTransaction({
      to: ethers.getAddress(finalRecipient),
      value,
      gasLimit: 21000n,
      gasPrice,
    });
    const receipt = await tx.wait();
    return {
      shadowForwardTxHash: tx.hash,
      shadowForwardWei: value.toString(),
      shadowForwardBlockNumber: receipt?.blockNumber,
    };
  } catch (e) {
    return { shadowForwardError: e?.reason || e?.shortMessage || e?.message || String(e) };
  }
}

/** Native BNB on shadow for paying gas on an ERC20 `transfer` (pool pays tokens, not gas). */
async function topUpWithdrawShadowNativeGasIfNeeded({ payerSigner, shadowSigner, minBalanceWei }) {
  const min = BigInt(minBalanceWei || "0");
  if (min <= 0n) return { shadowGasTopUpSkipped: true };
  const provider = shadowSigner.provider;
  const bal = await provider.getBalance(shadowSigner.address);
  if (bal >= min) return { shadowGasTopUpSkipped: true, shadowNativeBalanceWei: bal.toString() };
  const deficit = min - bal;
  const tx = await payerSigner.sendTransaction({ to: shadowSigner.address, value: deficit });
  const receipt = await tx.wait();
  return {
    shadowGasTopUpTxHash: tx.hash,
    shadowGasTopUpWei: deficit.toString(),
    shadowGasTopUpBlockNumber: receipt?.blockNumber,
    shadowNativeBalanceWei: (await provider.getBalance(shadowSigner.address)).toString(),
  };
}

/**
 * Forward full ERC20 balance from withdraw-shadow to the user's wallet (e.g. BUSD after shieldedWithdraw).
 * Polls balance briefly: some RPCs lag one block behind `withdraw` receipt state.
 */
async function forwardWithdrawTokenFromShadow(shadowSigner, tokenAddress, finalRecipient, opts = {}) {
  if (!finalRecipient || !ethers.isAddress(finalRecipient)) {
    return { shadowForwardTokenError: "Invalid finalRecipient for token shadow forward" };
  }
  const token = ethers.getAddress(String(tokenAddress).trim());
  const erc20 = new ethers.Contract(
    token,
    ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"],
    shadowSigner
  );
  const maxPolls = Number(opts.maxPolls ?? process.env.SHADOW_ERC20_FORWARD_BALANCE_POLLS ?? 12) || 12;
  const pollMs = Number(opts.pollMs ?? process.env.SHADOW_ERC20_FORWARD_POLL_MS ?? 700) || 700;
  const initialDelayMs = Number(opts.initialDelayMs ?? process.env.SHADOW_ERC20_FORWARD_INITIAL_DELAY_MS ?? 400) || 400;
  await sleep(initialDelayMs);
  let bal = 0n;
  let lastPollErr;
  for (let i = 0; i < maxPolls; i += 1) {
    try {
      bal = await erc20.balanceOf(shadowSigner.address);
    } catch (e) {
      lastPollErr = e?.message || String(e);
      bal = 0n;
    }
    if (bal > 0n) break;
    if (i < maxPolls - 1) await sleep(pollMs);
  }
  if (bal <= 0n) {
    return {
      shadowForwardTokenWei: "0",
      shadowForwardTokenError: lastPollErr
        ? `Shadow has zero token balance after ${maxPolls} polls (${lastPollErr})`
        : "Shadow has zero token balance (pool may not have sent ERC20 yet; check withdraw recipient vs shadow seed)",
      shadowForwardTokenPolls: String(maxPolls),
    };
  }
  try {
    const to = ethers.getAddress(finalRecipient);
    let gasLimit = 120000n;
    try {
      const est = await erc20.transfer.estimateGas(to, bal);
      gasLimit = (BigInt(est) * 115n) / 100n + 15000n;
      if (gasLimit > 500000n) gasLimit = 500000n;
    } catch {
      /* fixed limit */
    }
    const fee = await shadowSigner.provider.getFeeData();
    const txOpts = { gasLimit };
    if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
      txOpts.maxFeePerGas = fee.maxFeePerGas;
      txOpts.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
    } else if (fee.gasPrice != null) {
      txOpts.gasPrice = fee.gasPrice;
    }
    const tx = await erc20.transfer(to, bal, txOpts);
    const receipt = await tx.wait();
    return {
      shadowForwardTokenTxHash: tx.hash,
      shadowForwardTokenWei: bal.toString(),
      shadowForwardToken: token,
      shadowForwardTokenBlockNumber: receipt?.blockNumber,
    };
  } catch (e) {
    return { shadowForwardTokenError: e?.reason || e?.shortMessage || e?.message || String(e) };
  }
}

async function topUpWithdrawShadowIfNeeded({ payerSigner, shadowSigner, requiredWei }) {
  const needed = BigInt(requiredWei || "0");
  if (needed <= 0n) return { shadowTopUpSkipped: true };
  const provider = shadowSigner.provider;
  const bal = await provider.getBalance(shadowSigner.address);
  if (bal >= needed) return { shadowTopUpSkipped: true, shadowBalanceWei: bal.toString() };
  const deficit = needed - bal;
  const tx = await payerSigner.sendTransaction({
    to: shadowSigner.address,
    value: deficit,
  });
  const receipt = await tx.wait();
  return {
    shadowTopUpTxHash: tx.hash,
    shadowTopUpWei: deficit.toString(),
    shadowTopUpBlockNumber: receipt?.blockNumber,
  };
}

async function sweepShadowDeposit(shadowAddress, deposit) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const seed = getShadowSeed(deposit);
  const shadowSigner = new ethers.Wallet(seed, provider);
  // On-chain `Deposit(depositor, …)` must use the shadow EOA so the pool tx does not leak the
  // user's main wallet. The real depositor is still authenticated off-chain via EIP-712 (`deposit.depositor`).
  const poolDepositor = shadowSigner.address;
  const poolAbi = [
    "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable",
    "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external",
  ];
  const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, shadowSigner);

  if (deposit.token === ethers.ZeroAddress) {
    const feeWei = await getDepositFeeBNBWei();
    const totalValue = BigInt(deposit.amount) + feeWei;
    try {
      const tx = await pool.depositForBNB(
        poolDepositor,
        deposit.commitment,
        deposit.assetID,
        { value: totalValue }
      );
      const receipt = await tx.wait();
      storeCommitmentsFromReceipt(receipt);
      const refund = await refundShadowDust(shadowSigner, getProtocolDustRecipient(shadowSigner));
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber, from: shadowSigner.address, ...refund };
    } catch (err) {
      const emergency = await emergencyDrainShadow(shadowSigner, deposit.depositor);
      return {
        shadowSweepFailed: true,
        shadowSweepError: err?.reason || err?.shortMessage || err?.message || "shadow sweep failed",
        from: shadowSigner.address,
        ...emergency
      };
    }
  }

  const erc20Abi = [
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
  ];
  const token = new ethers.Contract(deposit.token, erc20Abi, shadowSigner);
  const allowance = await token.allowance(shadowSigner.address, SHIELDED_POOL_ADDRESS);
  if (allowance < BigInt(deposit.amount)) {
    const approveTx = await token.approve(SHIELDED_POOL_ADDRESS, deposit.amount);
    await approveTx.wait();
  }
  const feeWei = await getDepositFeeBNBWei();
  const tx = await pool.depositFor(
    poolDepositor,
    deposit.token,
    deposit.amount,
    deposit.commitment,
    deposit.assetID,
    { value: feeWei }
  );
  const receipt = await tx.wait();
  storeCommitmentsFromReceipt(receipt);
  const refund = await refundShadowDust(shadowSigner, getProtocolDustRecipient(shadowSigner));
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, from: shadowSigner.address, ...refund };
}

async function emergencyDrainShadow(shadowSigner, recipient) {
  try {
    if (!recipient || !ethers.isAddress(recipient)) return { shadowEmergencyError: "Invalid recipient for emergency drain" };
    const provider = shadowSigner.provider;
    const bal = await provider.getBalance(shadowSigner.address);
    if (bal <= 0n) return { shadowEmergencyDrainedWei: "0" };
    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    if (gasPrice <= 0n) return { shadowEmergencyError: "Cannot estimate gas price for emergency drain" };
    const gasCost = gasPrice * 21000n;
    if (bal <= gasCost) return { shadowEmergencyDrainedWei: "0", shadowEmergencyError: "Insufficient balance after gas" };
    const value = bal - gasCost;
    const tx = await shadowSigner.sendTransaction({
      to: recipient,
      value,
      gasLimit: 21000n,
      gasPrice,
    });
    const receipt = await tx.wait();
    return {
      shadowEmergencyRecipient: recipient,
      shadowEmergencyTxHash: tx.hash,
      shadowEmergencyDrainedWei: value.toString(),
      shadowEmergencyBlockNumber: receipt?.blockNumber,
    };
  } catch (e) {
    return { shadowEmergencyError: e?.message || String(e) };
  }
}

function getProtocolDustRecipient(shadowSigner) {
  if (PROTOCOL_DUST_RECIPIENT && ethers.isAddress(PROTOCOL_DUST_RECIPIENT)) {
    return PROTOCOL_DUST_RECIPIENT;
  }
  if (RELAYER_PRIVATE_KEY) {
    try {
      return new ethers.Wallet(RELAYER_PRIVATE_KEY).address;
    } catch (_) {}
  }
  return shadowSigner.address;
}

async function refundShadowDust(shadowSigner, recipient) {
  try {
    if (!recipient || !ethers.isAddress(recipient)) return {};
    const provider = shadowSigner.provider;
    const bal = await provider.getBalance(shadowSigner.address);
    if (bal <= 0n) return {};

    const fee = await provider.getFeeData();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    if (gasPrice <= 0n) return {};

    const reserve = gasPrice * 21000n;
    if (bal <= reserve) return { shadowBalanceWei: bal.toString() };

    const refundValue = bal - reserve;
    const refundTx = await shadowSigner.sendTransaction({
      to: recipient,
      value: refundValue,
      gasLimit: 21000n,
      gasPrice,
    });
    const refundReceipt = await refundTx.wait();
    return {
      shadowRefundRecipient: recipient,
      shadowRefundTxHash: refundTx.hash,
      shadowRefundWei: refundValue.toString(),
      shadowRefundBlockNumber: refundReceipt?.blockNumber,
    };
  } catch (e) {
    return { shadowRefundError: e?.message || String(e) };
  }
}
const poolInterface = new ethers.Interface([
  "event CommitmentAdded(bytes32 indexed commitment, uint256 index)",
  "event Deposit(address indexed depositor, address indexed token, uint256 assetID, uint256 amount, bytes32 commitment, uint256 commitmentIndex)",
  "event ShieldedSwapJoinSplit(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentSwap, bytes32 outputCommitmentChange, uint256 inputAssetID, uint256 outputAssetIDSwap, uint256 outputAssetIDChange, uint256 inputAmount, uint256 swapAmount, uint256 changeAmount, uint256 outputAmountSwap, address relayer)",
  "event ShieldedWithdraw(bytes32 indexed nullifier, bytes32 indexed inputCommitment, bytes32 indexed outputCommitmentChange, address recipient, uint256 inputAssetID, uint256 withdrawAmount, uint256 changeAmount, address relayer)"
]);

const dexApiToken = "https://api.dexscreener.com/latest/dex/tokens/";

let cachedPoolDepositFeeUsdE8 = null;
let depositFeeBelowChainWarned = false;

async function readPoolDepositFeeUsdE8() {
  if (cachedPoolDepositFeeUsdE8 != null) return cachedPoolDepositFeeUsdE8;
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) return null;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const pool = new ethers.Contract(
      SHIELDED_POOL_ADDRESS,
      ["function DEPOSIT_FEE_USD() view returns (uint256)"],
      provider
    );
    cachedPoolDepositFeeUsdE8 = BigInt(await pool.DEPOSIT_FEE_USD());
    return cachedPoolDepositFeeUsdE8;
  } catch {
    return null;
  }
}

/** On-chain pool `DEPOSIT_FEE_USD` is $2 at 1e8 USD scale (see ShieldedPoolUpgradeableReduced). */
const ONCHAIN_MIN_DEPOSIT_FEE_USD_E8 = 2n * 10n ** 8n;

async function readFeeOracleAddressFromPool() {
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) return null;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const pool = new ethers.Contract(
      SHIELDED_POOL_ADDRESS,
      ["function feeOracle() view returns (address)"],
      provider
    );
    const addr = await pool.feeOracle();
    if (!addr || addr === ethers.ZeroAddress) return null;
    return addr;
  } catch {
    return null;
  }
}

const WBNB_BSC_MAINNET = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const WBNB_BSC_TESTNET = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
const PANCAKE_V2_ROUTER_BSC = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const PANCAKE_V2_ROUTER_BSC_TESTNET = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
// Official Pancake V3 QuoterV2 addresses (Pancake docs, accessed 2026-04-14).
const PANCAKE_V3_QUOTER_V2_BSC = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const PANCAKE_V3_QUOTER_V2_BSC_TESTNET = "0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2";

function getPancakeV3QuoterAddress() {
  if (process.env.PANCAKE_V3_QUOTER_V2) return process.env.PANCAKE_V3_QUOTER_V2;
  if (CHAIN_ID === 56) return PANCAKE_V3_QUOTER_V2_BSC;
  if (CHAIN_ID === 97) return PANCAKE_V3_QUOTER_V2_BSC_TESTNET;
  return "";
}

function getPancakeV2RouterAddress() {
  if (process.env.PANCAKE_V2_ROUTER) return process.env.PANCAKE_V2_ROUTER;
  if (CHAIN_ID === 56) return PANCAKE_V2_ROUTER_BSC;
  if (CHAIN_ID === 97) return PANCAKE_V2_ROUTER_BSC_TESTNET;
  return "";
}

function getWbnbForChain() {
  return process.env.WBNB_ADDRESS || (CHAIN_ID === 56 ? WBNB_BSC_MAINNET : WBNB_BSC_TESTNET);
}

async function tryQuotePancakeV2Router(provider, tokenIn, tokenOut, amountInBn, pathHex) {
  const routerAddr = getPancakeV2RouterAddress();
  if (!routerAddr) return null;
  const wbnb = getWbnbForChain();
  const zero = ethers.ZeroAddress.toLowerCase();
  let tin;
  let tout;
  try {
    tin = (tokenIn || "").toLowerCase() === zero ? wbnb : normalizeEvmAddress(tokenIn);
    tout = (tokenOut || "").toLowerCase() === zero ? wbnb : normalizeEvmAddress(tokenOut);
  } catch {
    return null;
  }
  if (tin.toLowerCase() === tout.toLowerCase()) return null;
  let hopPath = [tin, tout];
  if (pathHex && typeof pathHex === "string" && pathHex.length > 2) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], pathHex);
      if (decoded[0]?.length >= 2) hopPath = decoded[0].map((a) => ethers.getAddress(a));
    } catch {
      /* use two-hop default */
    }
  }
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"],
    provider
  );
  const amounts = await router.getAmountsOut(amountInBn, hopPath);
  const last = amounts[amounts.length - 1];
  return { outAmount: BigInt(last.toString()), hopPath };
}

function encodeV3Path(tokenIn, tokenOut, feeTier) {
  const inHex = normalizeEvmAddress(tokenIn).toLowerCase().slice(2);
  const outHex = normalizeEvmAddress(tokenOut).toLowerCase().slice(2);
  const feeHex = Number(feeTier).toString(16).padStart(6, "0");
  return `0x${inHex}${feeHex}${outHex}`;
}

async function tryQuotePancakeV3Quoter(provider, tokenIn, tokenOut, amountInBn, feeTier = 2500, sqrtPriceLimitX96 = 0) {
  const quoterAddr = getPancakeV3QuoterAddress();
  if (!quoterAddr) return null;
  const wbnb = getWbnbForChain();
  const zero = ethers.ZeroAddress.toLowerCase();
  const inToken = String(tokenIn || "").toLowerCase() === zero ? wbnb : normalizeEvmAddress(tokenIn);
  const outToken = String(tokenOut || "").toLowerCase() === zero ? wbnb : normalizeEvmAddress(tokenOut);
  if (inToken.toLowerCase() === outToken.toLowerCase()) {
    return null;
  }
  const fee = Number(feeTier || 2500);
  const sqrtLimit = toBigInt(sqrtPriceLimitX96 || 0);

  const paramsV1 = {
    tokenIn: inToken,
    tokenOut: outToken,
    amountIn: amountInBn,
    fee,
    sqrtPriceLimitX96: sqrtLimit,
  };
  const paramsV2 = {
    tokenIn: inToken,
    tokenOut: outToken,
    fee,
    amountIn: amountInBn,
    sqrtPriceLimitX96: sqrtLimit,
  };
  const quoterV1 = new ethers.Contract(
    quoterAddr,
    [
      "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external view returns (uint256 amountOut,uint160,uint32,uint256)",
    ],
    provider
  );
  const quoterV2 = new ethers.Contract(
    quoterAddr,
    [
      "function quoteExactInputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) params) external view returns (uint256 amountOut)",
    ],
    provider
  );

  let outAmount;
  try {
    const result = await quoterV1.quoteExactInputSingle.staticCall(paramsV1);
    if (Array.isArray(result)) outAmount = toBigInt(result[0]);
    else outAmount = toBigInt(result);
  } catch (errPrimary) {
    try {
      const result = await quoterV2.quoteExactInputSingle.staticCall(paramsV2);
      if (Array.isArray(result)) outAmount = toBigInt(result[0]);
      else outAmount = toBigInt(result);
    } catch {
      throw errPrimary;
    }
  }

  return {
    outAmount,
    tokenIn: normalizeEvmAddress(inToken),
    tokenOut: normalizeEvmAddress(outToken),
    feeTier: fee,
    sqrtPriceLimitX96: sqrtLimit.toString(),
    path: encodeV3Path(inToken, outToken, fee),
    quoter: quoterAddr,
  };
}

async function getDepositFeeBNBWei() {
  const envUsd = RUNTIME_PARAMS.fees.depositFeeUsdE8;
  const chainMinUsd = await readPoolDepositFeeUsdE8();
  const effectiveUsd = chainMinUsd != null && envUsd < chainMinUsd ? chainMinUsd : envUsd;
  if (chainMinUsd != null && envUsd < chainMinUsd && !depositFeeBelowChainWarned) {
    depositFeeBelowChainWarned = true;
    console.warn(
      `[deposit fee] PHANTOM_DEPOSIT_FEE_USD_E8 (${envUsd}) is below on-chain pool DEPOSIT_FEE_USD (${chainMinUsd}); ` +
        "using chain minimum for BNB fee conversion (lower env alone cannot bypass the contract)."
    );
  }
  const wbnb = CHAIN_ID === 56 ? WBNB_BSC_MAINNET : WBNB_BSC_TESTNET;
  const chainSlug = CHAIN_ID === 56 ? "bsc" : "bsc-testnet";
  // Small cushion over the DEX-implied wei, then verify against the same on-chain FeeOracle the pool uses.
  const safetyBps = Math.max(10000, toBps(process.env.PHANTOM_DEPOSIT_FEE_SAFETY_BPS, 10500));
  const minWeiFloor = toBig(process.env.PHANTOM_DEPOSIT_FEE_MIN_WEI, 2500000000000000n);
  const maxWeiCap = toBig(process.env.PHANTOM_DEPOSIT_FEE_MAX_WEI, CHAIN_ID === 97 ? 5n * 10n ** 17n : 3n * 10n ** 17n);

  const bumpSafety = (wei) => {
    const adjusted = (wei * BigInt(safetyBps) + 9999n) / 10000n;
    return adjusted < minWeiFloor ? minWeiFloor : adjusted;
  };

  let guess;
  try {
    const price = await getDexPriceUsd(wbnb, chainSlug);
    if (!price || price === 0n) throw new Error("No BNB price");
    guess = (effectiveUsd * 10n ** 18n + (price - 1n)) / price;
  } catch {
    guess = CHAIN_ID === 97 ? 3333333333333333n : 3333333333333333n;
  }
  guess = bumpSafety(guess);

  const foAddr = await readFeeOracleAddressFromPool();
  if (!foAddr || !RPC_URL) return guess;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const fo = new ethers.Contract(
    foAddr,
    ["function getUSDValue(address token,uint256 amount) view returns (uint256)"],
    provider
  );

  let wei = guess;
  for (let i = 0; i < 24; i++) {
    let usd = 0n;
    try {
      usd = BigInt((await fo.getUSDValue(ethers.ZeroAddress, wei)).toString());
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (i === 0) {
        console.warn(
          `[deposit fee] FeeOracle.getUSDValue(native) failed (misconfigured/stale offchain oracle or missing BNB/USD feed): ${msg}. ` +
          `[deposit fee] FeeOracle.getUSDValue(native) failed (misconfigured/stale offchain oracle or missing BNB/USD feed): ${msg}. ` +
            "Fix on-chain FeeOracle (see Phantom-Smart-Contracts/scripts/deploy/fix-feeoracle-bnb-usd-bsc-testnet.ts)."
        );
      }
      usd = 0n;
    }
    if (usd >= ONCHAIN_MIN_DEPOSIT_FEE_USD_E8) return wei;
    if (usd === 0n) {
      wei = bumpSafety((wei * 3n) / 2n + 1n);
    } else {
      // ceil to target USD using linear scaling
      wei = bumpSafety((ONCHAIN_MIN_DEPOSIT_FEE_USD_E8 * wei + usd - 1n) / usd);
    }
    if (wei > maxWeiCap) {
      throw new Error(
        `deposit_fee_oracle_unsatisfiable: FeeOracle still prices attached BNB below $2 at feeWei=${wei.toString()} ` +
          `(cap=${maxWeiCap.toString()}). Fix FeeOracle (disable stale offchain oracle + set BNB/USD feed on testnet).`
      );
    }
  }
  throw new Error(
    "deposit_fee_oracle_unsatisfiable: could not find feeWei that satisfies on-chain $2 check. " +
      "Run scripts/deploy/fix-feeoracle-bnb-usd-bsc-testnet.ts with the FeeOracle owner key."
  );
}

const quoteSchema = z.object({
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z.string(),
  tokenInDecimals: z.number().int().min(0).max(36).optional(),
  tokenOutDecimals: z.number().int().min(0).max(36).optional(),
  slippageBps: z.number().int().min(0).max(2000).default(1000),
  chainSlug: z.string().optional(),
  feeTier: z.number().int().optional(),
  sqrtPriceLimitX96: z.union([z.string(), z.number()]).optional(),
  deadlineSec: z.number().int().min(60).max(3600 * 6).optional(),
});

const intentSchema = z.object({
  userAddress: z.string(),
  inputAssetID: z.union([z.string(), z.number()]),
  outputAssetID: z.union([z.string(), z.number()]),
  amountIn: z.string(),
  minAmountOut: z.string(),
  nonce: z.union([z.string(), z.number()]),
  nullifier: z.string(),
  deadline: z.number().int(),
});

const proofShape = z.object({
  a: z.union([z.string(), z.tuple([z.string(), z.string()])]),
  b: z.union([z.string(), z.array(z.array(z.string()).length(2)).length(2)]),
  c: z.union([z.string(), z.tuple([z.string(), z.string()])]),
}).passthrough();

const swapSchema = z.object({
  intentId: z.string().optional(),
  intent: intentSchema.optional(),
  intentSig: z.string().optional(),
  /**
   * Privacy-preserving auth path: no wallet address/signature.
   * Authorization relies on valid join-split proof + nullifier replay protection.
   */
  zkAuthorization: z.object({
    nullifier: z.union([z.string(), z.number()]).optional(),
    deadline: z.union([z.string(), z.number()]).optional(),
    nonce: z.union([z.string(), z.number()]).optional(),
    minAmountOut: z.union([z.string(), z.number()]).optional(),
    userAddress: z.string().optional(),
    publicInputHash: z.string().optional(),
    signature: z.string().optional(),
  }).optional(),
  swapData: z.object({
    proof: proofShape,
    publicInputs: z.any(),
    swapParams: z.any(),
    relayer: z.string().optional(),
    encryptedPayload: z.string().optional(),
    noteHints: z.any().optional(),
  }),
});

const normalizeMerklePath = (path) => {
  if (!Array.isArray(path)) return Array(10).fill("0");
  const formatted = path.slice(0, 10).map((v) => toBigIntString(v));
  while (formatted.length < 10) formatted.push("0");
  return formatted;
};

const normalizeMerkleIndices = (indices) => {
  if (!Array.isArray(indices)) return Array(10).fill("0");
  const formatted = indices.slice(0, 10).map((v) => String(toBigInt(v) % 2n));
  while (formatted.length < 10) formatted.push("0");
  return formatted;
};

const normalizeJoinSplitPublicInputs = (pi, label) => {
  const merklePath = normalizeMerklePath(pi.merklePath);
  const merklePathIndices = normalizeMerkleIndices(pi.merklePathIndices);
  const count = 15 + merklePath.length + merklePathIndices.length;
  if (count !== 35) {
    throw new Error(`${label}: publicInputs must be 35 elements (got ${count})`);
  }
  return { merklePath, merklePathIndices };
};

const buildJoinSplitPublicSignals = (pi) => ([
  toBigIntString(pi.nullifier),
  toBigIntString(pi.inputCommitment),
  toBigIntString(pi.outputCommitmentSwap),
  toBigIntString(pi.outputCommitmentChange),
  toBigIntString(pi.merkleRoot),
  toBigIntString(pi.outputAmountSwap),
  toBigIntString(pi.minOutputAmountSwap),
  toBigIntString(pi.protocolFee),
  toBigIntString(pi.gasRefund),
  toBigIntString(computeJoinSplitRoutingCommitment(pi))
]);

function computeJoinSplitRoutingCommitment(pi) {
  const withdrawMode = toBigInt(pi?.outputCommitmentSwap || 0) === 0n ? 1n : 0n;
  const r0 = mimc7(toBigInt(pi?.inputAssetID || 0), toBigInt(pi?.outputAssetIDSwap || 0));
  const r1 = mimc7(r0, toBigInt(pi?.outputAssetIDChange || 0));
  const r2 = mimc7(r1, toBigInt(pi?.inputAmount || 0));
  const r3 = mimc7(r2, toBigInt(pi?.swapAmount || 0));
  const r4 = mimc7(r3, toBigInt(pi?.changeAmount || 0));
  const r5 = mimc7(r4, toBigInt(pi?.outputAmountSwap || 0));
  const r6 = mimc7(r5, toBigInt(pi?.minOutputAmountSwap || 0));
  const r7 = mimc7(r6, toBigInt(pi?.protocolFee || 0));
  const r8 = mimc7(r7, toBigInt(pi?.gasRefund || 0));
  return mimc7(r8, withdrawMode);
}

const computeMerkleRootFromPath = (leafValue, merklePath, merklePathIndices) => {
  let current = toBigInt(leafValue);
  for (let i = 0; i < 10; i++) {
    const pathVal = toBigInt(merklePath[i] ?? "0");
    const idx = toBigInt(merklePathIndices[i] ?? "0");
    if (idx === 0n) {
      current = mimc7(current, pathVal);
    } else {
      current = mimc7(pathVal, current);
    }
  }
  return current;
};

const fetchMerkleProofFromChain = async (commitment) => {
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
    throw new Error("RPC_URL/SHIELDED_POOL_ADDRESS not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const abi = [
    "function commitmentCount() view returns (uint256)",
    "function commitments(uint256) view returns (bytes32)"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);
  const count = Number(await contract.commitmentCount());
  const commitments = [];
  for (let i = 0; i < count; i += 1) {
    commitments.push(await contract.commitments(i));
  }
  const targetIndex = commitments.findIndex((c) => c.toLowerCase() === String(commitment).toLowerCase());
  if (targetIndex === -1) {
    throw new Error(`Commitment not found on-chain: ${commitment}`);
  }
  const { path, indices, root } = buildMerklePath(commitments, targetIndex);
  return { merklePath: path, merklePathIndices: indices, merkleRoot: root };
};

const withdrawSchema = z.object({
  withdrawData: z.object({
    proof: proofShape,
    publicInputs: z.any(),
    relayer: z.string().optional(),
    recipient: z.string().optional(),
    /** When set, pool pays this 1-time shadow EOA; relayer then forwards native to `recipient` / this address. */
    finalRecipient: z.string().optional(),
    encryptedPayload: z.string().optional(),
    noteHints: z.any().optional(),
    ownerAddress: z.string().optional(),
  }).refine(
    (d) => (d.recipient && String(d.recipient).trim()) || (d.finalRecipient && String(d.finalRecipient).trim()),
    { message: "withdrawData.recipient or withdrawData.finalRecipient is required" }
  ),
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

async function processWithdrawRequestBody(body) {
  const parsed = withdrawSchema.safeParse(body);
  if (!parsed.success) {
    const err = new Error("Invalid withdraw payload");
    err.status = 400;
    err.details = parsed.error.flatten();
    throw err;
  }
  const { withdrawData } = parsed.data;
  try {
    assertWithdrawJoinSplitPublicInputs(withdrawData.publicInputs);
  } catch (e) {
    const err = new Error(e.message || "withdraw_public_inputs_invalid");
    err.status = 400;
    err.code = e.code;
    throw err;
  }
  const frOpt = withdrawData.finalRecipient != null ? String(withdrawData.finalRecipient).trim() : "";
  if (frOpt) {
    if (!ethers.isAddress(frOpt)) {
      const err = new Error("withdraw_invalid_finalRecipient");
      err.status = 400;
      throw err;
    }
    const fr = ethers.getAddress(frOpt);
    const nf = withdrawData.publicInputs?.nullifier;
    if (nf === undefined || nf === null) {
      const err = new Error("withdraw_finalRecipient_requires_publicInputs_nullifier");
      err.status = 400;
      throw err;
    }
    try {
      await screenWithdrawRecipient(fr);
    } catch (e) {
      const out = complianceErrorResponse(e, "chainalysis_recipient_not_allowed");
      const err = new Error(out.body.error);
      err.status = out.status;
      err.details = out.body;
      throw err;
    }
    const seed = getWithdrawShadowSeed({ finalRecipient: fr, nullifier: nf });
    const shadowAddr = new ethers.Wallet(seed).address;
    withdrawData.recipient = shadowAddr;
    withdrawData._shadowPayoutTo = fr;
  } else {
    if (!withdrawData.recipient || !ethers.isAddress(String(withdrawData.recipient).trim())) {
      const err = new Error("withdraw_invalid_recipient");
      err.status = 400;
      throw err;
    }
    try {
      await screenWithdrawRecipient(withdrawData.recipient);
    } catch (e) {
      const out = complianceErrorResponse(e, "chainalysis_recipient_not_allowed");
      const err = new Error(out.body.error);
      err.status = out.status;
      err.details = out.body;
      throw err;
    }
  }
  return RELAYER_DRY_RUN
    ? await simulateSwap(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(withdrawData))))
    : await submitWithdraw(withdrawData);
}

async function processDepositRequestBody(body) {
  const parsed = depositSchema.safeParse(body);
  if (!parsed.success) {
    const err = new Error("Invalid deposit payload");
    err.status = 400;
    err.details = parsed.error.flatten();
    throw err;
  }
  const payload = parsed.data;
  assertTokenAllowed(payload.token, "deposit_token");
  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    const err = new Error("Deposit expired");
    err.status = 400;
    throw err;
  }
  if (!consumeReplayKey(`deposit:${payload.depositor.toLowerCase()}:${payload.commitment.toLowerCase()}`)) {
    const err = new Error("Duplicate deposit request detected");
    err.status = 409;
    throw err;
  }
  const signerAddr = ethers.verifyTypedData(DEPOSIT_DOMAIN, DEPOSIT_TYPES, {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  }, payload.signature);
  if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
    const err = new Error("Invalid deposit signature");
    err.status = 400;
    throw err;
  }
  try {
    await screenDepositDepositor(payload.depositor, "deposit");
  } catch (e) {
    const out = complianceErrorResponse(e, "chainalysis_depositor_not_allowed");
    const err = new Error(out.body.error);
    err.status = out.status;
    err.details = out.body;
    throw err;
  }
  try {
    return RELAYER_DRY_RUN
      ? await simulateSwap(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
        t: Date.now(),
        kind: "deposit",
        depositor: payload.depositor,
        token: payload.token,
        amount: payload.amount,
        assetID: payload.assetID,
      }))))
      : await submitDeposit(payload);
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Deposit failed";
    const e = new Error(msg);
    e.status = 400;
    throw e;
  }
}

const noteFromDepositSchema = z.object({
  txHash: z.string(),
  ownerAddress: z.string().optional(),
  note: z.object({
    assetId: z.union([z.string(), z.number()]).optional(),
    assetID: z.union([z.string(), z.number()]).optional(),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.union([z.string(), z.number()]),
    ownerPublicKey: z.union([z.string(), z.number()]),
  }),
}).passthrough();

const depositSessionSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  depositor: z.string().refine((s) => ethers.isAddress(s)),
  mode: z.enum(["erc20", "bnb"]),
  token: z.string().optional(),
  amount: z.string().optional(),
  assetId: z.union([z.string(), z.number()]),
});

const depositSubmitSchema = z.object({
  sessionId: z.string().min(8),
  sessionToken: z.string().min(16),
  idempotencyKey: z.string().min(8),
  commitment: z.string(),
  note: z.object({
    assetId: z.union([z.string(), z.number()]).optional(),
    assetID: z.union([z.string(), z.number()]).optional(),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.union([z.string(), z.number()]),
    ownerPublicKey: z.union([z.string(), z.number()]),
  }),
});

function noteAuthOwner(req) {
  return String(req.query.ownerAddress || req.headers["x-owner-address"] || "").trim().toLowerCase();
}

function createConfigNoteError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  err.details = details;
  return err;
}

function getActiveNoteConfig() {
  const cfg = getRuntimeConfig();
  return {
    deploymentVersion: String(cfg.deploymentVersion || ""),
    poolAddress: String(cfg.addresses?.shieldedPool || "").toLowerCase(),
    oracleAddress: String(cfg.addresses?.feeOracle || "").toLowerCase(),
    chainId: Number(cfg.chainId || 0),
  };
}

function validateNoteAgainstActiveConfig(noteEnvelope, activeCfg) {
  const status = String(noteEnvelope?.status || "unknown").toLowerCase();
  if (status !== "unspent") {
    throw createConfigNoteError("SPENT_NOTE", "spent note", { status });
  }
  const poolAddress = String(noteEnvelope?.poolAddress || "").toLowerCase();
  if (!poolAddress || poolAddress !== activeCfg.poolAddress) {
    throw createConfigNoteError("POOL_MISMATCH", "pool mismatch", {
      notePoolAddress: poolAddress,
      currentPoolAddress: activeCfg.poolAddress,
    });
  }
  const oracleAddress = String(noteEnvelope?.oracleAddress || "").toLowerCase();
  if (!oracleAddress || oracleAddress !== activeCfg.oracleAddress) {
    throw createConfigNoteError("ORACLE_MISMATCH", "oracle mismatch", {
      noteOracleAddress: oracleAddress,
      currentOracleAddress: activeCfg.oracleAddress,
    });
  }
  const deploymentVersion = String(noteEnvelope?.deploymentVersion || "");
  if (!deploymentVersion || deploymentVersion !== activeCfg.deploymentVersion) {
    throw createConfigNoteError("CONFIG_MISMATCH", "config mismatch", {
      noteDeploymentVersion: deploymentVersion,
      currentDeploymentVersion: activeCfg.deploymentVersion,
    });
  }
}

async function parseDepositEventFromReceipt(txHash) {
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
    throw new Error("RPC_URL/SHIELDED_POOL_ADDRESS not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction receipt not found");
  let depositEvt = null;
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== String(SHIELDED_POOL_ADDRESS).toLowerCase()) continue;
    try {
      const parsed = poolInterface.parseLog(log);
      if (parsed?.name === "Deposit") {
        depositEvt = parsed;
        break;
      }
    } catch (_) { }
  }
  if (!depositEvt) throw new Error("Deposit event not found in tx receipt");
  return { receipt, depositEvt };
}

async function persistNoteFromDepositReceipt(txHash, noteInput, ownerAddressOverride, opts = {}) {
  getNotesEncryptionKey();
  const { receipt, depositEvt } = await parseDepositEventFromReceipt(txHash);
  const onChainCommitment = String(depositEvt.args.commitment).toLowerCase();
  const canonical = canonicalizeNote({
    assetId: noteInput.assetId ?? noteInput.assetID ?? Number(depositEvt.args.assetID),
    amount: noteInput.amount,
    blindingFactor: noteInput.blindingFactor,
    ownerPublicKey: noteInput.ownerPublicKey,
  });

  if (canonical.commitment.toLowerCase() !== onChainCommitment) {
    const err = new Error("Note commitment mismatch with Deposit event");
    err.code = "COMMITMENT_MISMATCH";
    err.expectedCommitment = onChainCommitment;
    err.providedCommitment = canonical.commitment.toLowerCase();
    throw err;
  }

  const rawEventDepositor = String(depositEvt.args.depositor);
  const ownerAddress = (ownerAddressOverride || rawEventDepositor).toLowerCase();
  const activeCfg = getActiveNoteConfig();
  const noteId = noteIdFromCanonical(canonical, `${String(receipt.hash).toLowerCase()}:${ownerAddress}`);
  const encryptedPayload = encryptJsonAtRest({
    note: canonical,
    status: "unspent",
    poolAddress: activeCfg.poolAddress,
    oracleAddress: activeCfg.oracleAddress,
    deploymentVersion: activeCfg.deploymentVersion,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    depositor: ownerAddress,
    ...(ownerAddress !== rawEventDepositor.toLowerCase()
      ? { poolDepositorOnChain: rawEventDepositor }
      : {}),
    token: String(depositEvt.args.token),
    assetId: String(depositEvt.args.assetID),
    amount: String(depositEvt.args.amount),
    commitmentIndex: Number(depositEvt.args.commitmentIndex),
    storedAt: new Date().toISOString(),
    ...(opts.module4 ? { module4: true } : {}),
  });

  saveEncryptedNote(db, noteId, ownerAddress, canonical.commitment, receipt.hash, encryptedPayload);
  saveCommitment(db, Number(depositEvt.args.commitmentIndex), canonical.commitment, receipt.hash);

  return {
    noteId,
    ownerAddress,
    commitment: canonical.commitment,
    commitmentIndex: Number(depositEvt.args.commitmentIndex),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    schema: canonical.schema,
  };
}

async function persistSwapOutputNotes({ txHash, ownerAddress, noteHints, publicInputs }) {
  if (!noteHints || typeof noteHints !== "object") return null;
  if (!noteHints.swap || !noteHints.change) return null;
  getNotesEncryptionKey();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Swap tx receipt not found for note persistence");

  const commitmentIndices = {};
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== String(SHIELDED_POOL_ADDRESS).toLowerCase()) continue;
    try {
      const parsed = poolInterface.parseLog(log);
      if (parsed?.name === "CommitmentAdded") {
        commitmentIndices[String(parsed.args.commitment).toLowerCase()] = Number(parsed.args.index);
      }
    } catch (_) {}
  }

  const swapCanonical = canonicalizeNote(noteHints.swap);
  const changeCanonical = canonicalizeNote(noteHints.change);
  const expectedSwap = normalizeHex32(publicInputs?.outputCommitmentSwap ?? 0).toLowerCase();
  const expectedChange = normalizeHex32(publicInputs?.outputCommitmentChange ?? 0).toLowerCase();
  if (swapCanonical.commitment.toLowerCase() !== expectedSwap) {
    throw new Error("Swap note hint commitment mismatch with proof public input");
  }
  if (changeCanonical.commitment.toLowerCase() !== expectedChange) {
    throw new Error("Change note hint commitment mismatch with proof public input");
  }

  const owner = String(ownerAddress).toLowerCase();
  const activeCfg = getActiveNoteConfig();
  const swapNoteId = noteIdFromCanonical(swapCanonical, `${txHash.toLowerCase()}:${owner}:swap`);
  const changeNoteId = noteIdFromCanonical(changeCanonical, `${txHash.toLowerCase()}:${owner}:change`);
  const swapPayload = encryptJsonAtRest({
    note: swapCanonical,
    status: "unspent",
    poolAddress: activeCfg.poolAddress,
    oracleAddress: activeCfg.oracleAddress,
    deploymentVersion: activeCfg.deploymentVersion,
    txHash,
    kind: "swap_output",
    commitmentIndex: commitmentIndices[swapCanonical.commitment.toLowerCase()] ?? null,
    storedAt: new Date().toISOString(),
  });
  const changePayload = encryptJsonAtRest({
    note: changeCanonical,
    status: "unspent",
    poolAddress: activeCfg.poolAddress,
    oracleAddress: activeCfg.oracleAddress,
    deploymentVersion: activeCfg.deploymentVersion,
    txHash,
    kind: "swap_change",
    commitmentIndex: commitmentIndices[changeCanonical.commitment.toLowerCase()] ?? null,
    storedAt: new Date().toISOString(),
  });
  saveEncryptedNote(db, swapNoteId, owner, swapCanonical.commitment, txHash, swapPayload);
  saveEncryptedNote(db, changeNoteId, owner, changeCanonical.commitment, txHash, changePayload);
  if (commitmentIndices[swapCanonical.commitment.toLowerCase()] != null) {
    saveCommitment(db, commitmentIndices[swapCanonical.commitment.toLowerCase()], swapCanonical.commitment, txHash);
  }
  if (commitmentIndices[changeCanonical.commitment.toLowerCase()] != null) {
    saveCommitment(db, commitmentIndices[changeCanonical.commitment.toLowerCase()], changeCanonical.commitment, txHash);
  }
  return {
    swapNoteId,
    changeNoteId,
    swapCommitmentIndex: commitmentIndices[swapCanonical.commitment.toLowerCase()] ?? null,
    changeCommitmentIndex: commitmentIndices[changeCanonical.commitment.toLowerCase()] ?? null,
  };
}

async function chainalysisScreenAddress(addr, opts = {}) {
  const { notAllowedMessage = "chainalysis_address_not_allowed", label = "module6" } = opts;
  if (!CHAINALYSIS_ENABLED) return { ok: true, skipped: true };
  if (!CHAINALYSIS_API_KEY) {
    console.warn(`[${label}] CHAINALYSIS_ENABLED but CHAINALYSIS_API_KEY missing; skipping screen`);
    return { ok: true, skipped: true };
  }
  if (!CHAINALYSIS_USE_PUBLIC_SANCTIONS_API && !CHAINALYSIS_API_URL) {
    console.warn(`[${label}] CHAINALYSIS_ENABLED but CHAINALYSIS_API_URL missing; skipping screen`);
    return { ok: true, skipped: true };
  }
  const checksum = ethers.getAddress(addr);
  try {
    let r;
    if (CHAINALYSIS_USE_PUBLIC_SANCTIONS_API) {
      const url = `https://public.chainalysis.com/api/v1/address/${checksum}`;
      r = await axios.get(url, {
        timeout: 12_000,
        validateStatus: () => true,
        headers: { "X-API-Key": CHAINALYSIS_API_KEY },
      });
    } else {
      r = await axios.post(
        CHAINALYSIS_API_URL,
        { address: checksum },
        {
          timeout: 12_000,
          validateStatus: () => true,
          headers: { Authorization: `Bearer ${CHAINALYSIS_API_KEY}` },
        }
      );
    }
    if (r.status >= 400) {
      const e = new Error(`chainalysis_http_${r.status}`);
      e.status = 403;
      throw e;
    }
    const idents = r.data?.identifications;
    const sanctionsHit =
      Array.isArray(idents) &&
      idents.some((x) => String(x?.category || "").toLowerCase() === "sanctions");
    if (sanctionsHit || r.data?.blocked === true || String(r.data?.risk || "").toLowerCase() === "severe") {
      const e = new Error(notAllowedMessage);
      e.status = 403;
      throw e;
    }
    return { ok: true };
  } catch (e) {
    if (e.status) throw e;
    if (CHAINALYSIS_FAIL_CLOSED) {
      const err = new Error("chainalysis_api_unavailable");
      err.status = 503;
      throw err;
    }
    console.warn(`[${label}] Chainalysis request failed (non-fatal):`, e.message || e);
    return { ok: true, warn: String(e.message || e) };
  }
}

function complianceErrorResponse(err, fallbackCode) {
  const msg = String(err?.message || fallbackCode || "compliance_error");
  if (msg === "chainalysis_api_unavailable") {
    return {
      status: err?.status || 503,
      body: {
        error: "chainalysis_api_unavailable",
        complianceAction: "block",
        failClosed: true,
      },
    };
  }
  if (/^chainalysis_.*_not_allowed$/.test(msg)) {
    return {
      status: err?.status || 403,
      body: {
        error: msg,
        complianceAction: "block",
      },
    };
  }
  return {
    status: err?.status || 403,
    body: {
      error: fallbackCode || "compliance_error",
      complianceAction: "block",
    },
  };
}

function rejectPlainSensitiveRoute(res, encryptedPath) {
  if (!RELAYER_REQUIRE_ENCRYPTED_ENVELOPE) return false;
  res.status(410).json({
    error: "encrypted_envelope_required",
    useEndpoint: encryptedPath,
  });
  return true;
}

function computeSwapPublicInputHash(publicInputs) {
  const pi = publicInputs || {};
  const routingCommitment = computeJoinSplitRoutingCommitment(pi);
  const asBytes32 = (v) => {
    const raw = v == null ? ethers.ZeroHash : String(v);
    if (raw.startsWith("0x")) return ethers.zeroPadValue(raw, 32);
    return ethers.toBeHex(toBigInt(raw), 32);
  };
  const asU256 = (v) => toBigInt(v ?? "0");
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
      ],
      [
        asBytes32(pi.nullifier),
        asBytes32(pi.inputCommitment),
        asBytes32(pi.outputCommitmentSwap),
        asBytes32(pi.outputCommitmentChange),
        asBytes32(pi.merkleRoot),
        asU256(routingCommitment),
      ]
    )
  );
}

function configuredTokenAllowlist() {
  const cfg = getRuntimeConfig();
  const allowed = new Set([ethers.ZeroAddress.toLowerCase()]);
  for (const a of cfg.assets || []) {
    const s = String(a?.address || "").trim();
    if (!s) continue;
    try {
      allowed.add(normalizeEvmAddress(s).toLowerCase());
    } catch (_) {}
  }
  return allowed;
}

function assertTokenAllowed(token, field) {
  const t = normalizeEvmAddress(token).toLowerCase();
  if (!configuredTokenAllowlist().has(t)) {
    const err = new Error(`${field || "token"}_not_configured_for_pool`);
    err.status = 400;
    throw err;
  }
}

function configuredTokenForAssetId(assetId) {
  const cfg = getRuntimeConfig();
  const n = Number(assetId);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return ethers.ZeroAddress;
  const hit = (cfg.assets || []).find((a) => Number(a?.assetId) === n && a?.address);
  if (!hit) return null;
  try {
    return normalizeEvmAddress(hit.address);
  } catch {
    return null;
  }
}

function assertAssetIdConfigured(assetId, field) {
  const token = configuredTokenForAssetId(assetId);
  if (!token) {
    const err = new Error(`${field || "asset_id"}_not_configured_for_pool`);
    err.status = 400;
    throw err;
  }
}

function canonicalWrappedNative(chainId) {
  if (Number(chainId) === 56) return "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
  return "0xae13d989dac2f0debff460ac112a837c89baa7cd";
}

function assertSwapRoutingConsistency(swapData) {
  const pi = swapData?.publicInputs || {};
  const sp = swapData?.swapParams || {};
  const cfg = getRuntimeConfig();
  const expectedIn = configuredTokenForAssetId(pi.inputAssetID);
  const expectedOut = configuredTokenForAssetId(pi.outputAssetIDSwap);
  if (!expectedIn || !expectedOut) {
    const err = new Error("swap_asset_id_not_configured");
    err.status = 400;
    throw err;
  }
  if (sp.tokenIn) {
    const actualIn = normalizeEvmAddress(sp.tokenIn).toLowerCase();
    const expectedInNorm = expectedIn.toLowerCase();
    const wnative = canonicalWrappedNative(cfg.chainId).toLowerCase();
    const inOk = expectedInNorm === ethers.ZeroAddress.toLowerCase()
      ? (actualIn === ethers.ZeroAddress.toLowerCase() || actualIn === wnative)
      : actualIn === expectedInNorm;
    if (!inOk) {
      const err = new Error("swap_tokenIn_asset_mismatch");
      err.status = 400;
      throw err;
    }
  }
  if (sp.tokenOut) {
    const actualOut = normalizeEvmAddress(sp.tokenOut).toLowerCase();
    const expectedOutNorm = expectedOut.toLowerCase();
    const wnative = canonicalWrappedNative(cfg.chainId).toLowerCase();
    const outOk = expectedOutNorm === ethers.ZeroAddress.toLowerCase()
      ? (actualOut === ethers.ZeroAddress.toLowerCase() || actualOut === wnative)
      : actualOut === expectedOutNorm;
    if (!outOk) {
      const err = new Error("swap_tokenOut_asset_mismatch");
      err.status = 400;
      throw err;
    }
  }
}

function buildCommittedSwapParams(swapData) {
  const pi = swapData?.publicInputs || {};
  const sp = swapData?.swapParams || {};
  const tokenIn = configuredTokenForAssetId(pi.inputAssetID);
  const tokenOut = configuredTokenForAssetId(pi.outputAssetIDSwap);
  if (!tokenIn || !tokenOut) {
    const err = new Error("swap_asset_id_not_configured");
    err.status = 400;
    throw err;
  }
  let path = sp.path;
  if (path && path !== "0x" && typeof path === "string" && path.length > 2) {
    try {
      ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], path);
    } catch {
      path = "0x";
    }
  } else {
    path = "0x";
  }
  return {
    tokenIn: Number(pi.inputAssetID) === 0 ? ethers.ZeroAddress : tokenIn,
    tokenOut: Number(pi.outputAssetIDSwap) === 0 ? ethers.ZeroAddress : tokenOut,
    amountIn: String(pi.swapAmount ?? "0"),
    minAmountOut: String(pi.minOutputAmountSwap ?? "0"),
    fee: Number(sp.fee || 0),
    sqrtPriceLimitX96: String(sp.sqrtPriceLimitX96 || 0),
    path,
  };
}

async function screenWithdrawRecipient(addr) {
  return chainalysisScreenAddress(addr, { notAllowedMessage: "chainalysis_recipient_not_allowed", label: "module6" });
}

async function screenDepositDepositor(addr, source = "deposit") {
  return chainalysisScreenAddress(addr, { notAllowedMessage: "chainalysis_depositor_not_allowed", label: source });
}

async function persistWithdrawChangeNote({ txHash, ownerAddress, noteHints, publicInputs }) {
  if (!noteHints || typeof noteHints !== "object" || !noteHints.change) return null;
  getNotesEncryptionKey();
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Withdraw tx receipt not found for note persistence");
  const commitmentIndices = {};
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== String(SHIELDED_POOL_ADDRESS).toLowerCase()) continue;
    try {
      const parsed = poolInterface.parseLog(log);
      if (parsed?.name === "CommitmentAdded") {
        commitmentIndices[String(parsed.args.commitment).toLowerCase()] = Number(parsed.args.index);
      }
    } catch (_) {}
  }
  const changeCanonical = canonicalizeNote(noteHints.change);
  const expectedChange = normalizeHex32(publicInputs?.outputCommitmentChange ?? 0).toLowerCase();
  if (changeCanonical.commitment.toLowerCase() !== expectedChange) {
    throw new Error("Withdraw change note hint commitment mismatch with proof public input");
  }
  const owner = String(ownerAddress).toLowerCase();
  const activeCfg = getActiveNoteConfig();
  const changeNoteId = noteIdFromCanonical(changeCanonical, `${txHash.toLowerCase()}:${owner}:withdraw_change`);
  const changePayload = encryptJsonAtRest({
    note: changeCanonical,
    status: "unspent",
    poolAddress: activeCfg.poolAddress,
    oracleAddress: activeCfg.oracleAddress,
    deploymentVersion: activeCfg.deploymentVersion,
    txHash,
    kind: "withdraw_change",
    commitmentIndex: commitmentIndices[changeCanonical.commitment.toLowerCase()] ?? null,
    storedAt: new Date().toISOString(),
  });
  saveEncryptedNote(db, changeNoteId, owner, changeCanonical.commitment, txHash, changePayload);
  if (commitmentIndices[changeCanonical.commitment.toLowerCase()] != null) {
    saveCommitment(db, commitmentIndices[changeCanonical.commitment.toLowerCase()], changeCanonical.commitment, txHash);
  }
  return { changeNoteId, changeCommitmentIndex: commitmentIndices[changeCanonical.commitment.toLowerCase()] ?? null };
}

app.post("/notes/from-deposit", async (req, res) => {
  const parsed = noteFromDepositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const { txHash, note } = parsed.data;
    const ownerAddress = parsed.data.ownerAddress
      ? String(parsed.data.ownerAddress).toLowerCase()
      : undefined;
    const out = await persistNoteFromDepositReceipt(txHash, note, ownerAddress);
    return res.json({
      ok: true,
      ...out,
    });
  } catch (err) {
    if (err.code === "COMMITMENT_MISMATCH") {
      return res.status(400).json({
        error: err.message,
        expectedCommitment: err.expectedCommitment,
        providedCommitment: err.providedCommitment,
      });
    }
    return res.status(400).json({ error: err.message || "Failed to store note from deposit" });
  }
});

app.post("/relayer/deposit/session", module4RateLimit, async (req, res) => {
  const parsed = depositSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { idempotencyKey, depositor, mode, assetId } = parsed.data;
  const token = parsed.data.token ? String(parsed.data.token) : "";
  const amount = parsed.data.amount != null ? String(parsed.data.amount) : "";
  try {
    await screenDepositDepositor(depositor, "module4.deposit.session");
  } catch (e) {
    const out = complianceErrorResponse(e, "chainalysis_depositor_not_allowed");
    return res.status(out.status).json(out.body);
  }

  if (mode === "erc20") {
    if (!token || !ethers.isAddress(token) || token === ethers.ZeroAddress) {
      return res.status(400).json({ error: "erc20 mode requires token (non-zero address)" });
    }
    if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      return res.status(400).json({ error: "erc20 mode requires positive integer amount (token wei)" });
    }
  } else {
    if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      return res.status(400).json({ error: "bnb mode requires positive integer amount (wei for depositForBNB)" });
    }
    if (BigInt(amount) > MODULE4_MAX_BNB_WEI) {
      return res.status(400).json({
        error: "bnb amount exceeds MODULE4_MAX_BNB_WEI cap",
        maxWei: MODULE4_MAX_BNB_WEI.toString(),
      });
    }
  }

  const now = Date.now();
  const existing = getDepositSessionByIdempotencyKey(db, idempotencyKey);
  if (existing) {
    if (existing.status === "submitted") {
      return res.status(409).json({
        error: "idempotency_key_already_completed",
        sessionId: existing.sessionId,
        txHash: existing.payload?.txHash || null,
        noteId: existing.payload?.noteId || null,
      });
    }
    if (existing.status === "pending" && now - existing.createdAt < MODULE4_SESSION_TTL_MS) {
      logModule4("deposit.session.reuse", { idempotencyKey, sessionId: existing.sessionId });
      return res.json({
        ok: true,
        sessionId: existing.sessionId,
        sessionToken: existing.sessionToken,
        depositor: existing.depositor.toLowerCase(),
        mode: existing.mode,
        assetId: existing.assetId,
        expiresAt: existing.createdAt + MODULE4_SESSION_TTL_MS,
        flow: "A",
        instructions:
          existing.mode === "erc20"
            ? {
                summary: "User approves ShieldedPool for token; relayer calls depositFor (no user ZK proof).",
                approveSpender: SHIELDED_POOL_ADDRESS || null,
                token: existing.token,
                amount: existing.amount,
              }
            : {
                summary: "Relayer sends BNB via depositForBNB; cap enforced by MODULE4_MAX_BNB_WEI.",
                valueWei: existing.amount,
              },
      });
    }
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const row = {
    sessionId,
    sessionToken,
    idempotencyKey,
    depositor: depositor.toLowerCase(),
    mode,
    token: mode === "erc20" ? ethers.getAddress(token) : null,
    amount,
    assetId: String(assetId),
    status: "pending",
    payload: { shadowDeadline: Math.floor((now + MODULE4_SESSION_TTL_MS) / 1000) },
    createdAt: now,
    updatedAt: now,
  };
  saveDepositSession(db, row);
  logModule4("deposit.session.created", { sessionId, mode, depositor: row.depositor });

  return res.json({
    ok: true,
    sessionId,
    sessionToken,
    depositor: row.depositor,
    mode,
    assetId: row.assetId,
    expiresAt: now + MODULE4_SESSION_TTL_MS,
    flow: "A",
    primaryMvpFlow: "bnb_shadow_or_erc20_pool_approve",
    instructions:
      mode === "erc20"
        ? {
            summary:
              "Flow A (MVP): user approves ShieldedPool as spender for token amount; relayer wallet calls depositFor(depositor, token, amount, commitment, assetID). User never builds ZK proofs.",
            approveSpender: SHIELDED_POOL_ADDRESS || null,
            token: row.token,
            amount: row.amount,
          }
        : {
            summary:
              "BNB: relayer pays msg.value in depositForBNB (relayer must be registered). User reimburses relayer off-chain or via separate payment — abuse limited by MODULE4_MAX_BNB_WEI and rate limits.",
            valueWei: row.amount,
            maxWeiCap: MODULE4_MAX_BNB_WEI.toString(),
          },
  });
});

app.post("/relayer/deposit/submit", requireModule4SubmitAuth, module4RateLimit, async (req, res) => {
  const parsed = depositSubmitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  if (RELAYER_DRY_RUN) {
    return res.status(503).json({
      error: "relayer_dry_run_blocks_module4",
      hint: "Set RELAYER_DRY_RUN=false and configure RPC + RELAYER_PRIVATE_KEY for real deposits.",
    });
  }
  if (!RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS || !RPC_URL) {
    return res.status(503).json({ error: "RELAYER_PRIVATE_KEY, SHIELDED_POOL_ADDRESS, and RPC_URL are required" });
  }

  const { sessionId, sessionToken, idempotencyKey, commitment, note } = parsed.data;
  const session = getDepositSessionBySessionId(db, sessionId);
  if (!session) return res.status(404).json({ error: "session_not_found" });
  if (session.sessionToken !== sessionToken) return res.status(403).json({ error: "invalid_session_token" });
  if (session.idempotencyKey !== idempotencyKey) return res.status(400).json({ error: "idempotency_mismatch" });
  if (session.status !== "pending") {
    return res.status(409).json({ error: "session_not_pending", status: session.status });
  }
  if (Date.now() - session.createdAt > MODULE4_SESSION_TTL_MS) {
    return res.status(410).json({ error: "session_expired" });
  }

  const depositor = session.depositor.toLowerCase();
  if (String(note.amount) !== String(session.amount)) {
    return res.status(400).json({ error: "note.amount must match session amount" });
  }
  const aid = String(note.assetId ?? note.assetID ?? session.assetId);
  if (String(session.assetId) !== aid) {
    return res.status(400).json({ error: "note assetId must match session assetId" });
  }

  const noteCommitment = canonicalizeNote({
    assetId: aid,
    amount: note.amount,
    blindingFactor: note.blindingFactor,
    ownerPublicKey: note.ownerPublicKey,
  }).commitment.toLowerCase();
  if (noteCommitment !== String(commitment).toLowerCase()) {
    return res.status(400).json({ error: "commitment does not match canonical note fields" });
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  try {
    await assertRelayerRegistered(provider, SHIELDED_POOL_ADDRESS, wallet.address);
  } catch (e) {
    logModule4("deposit.submit.relayer_not_registered", { address: wallet.address, message: e.message });
    return res.status(503).json({ error: e.message, code: e.code || "RELAYER_NOT_REGISTERED" });
  }

  let tx;
  try {
    if (session.mode === "erc20") {
      const feeWei = await getDepositFeeBNBWei();
      tx = await sendDepositForErc20(wallet, SHIELDED_POOL_ADDRESS, {
        depositor,
        token: session.token,
        amount: session.amount,
        commitment,
        assetID: session.assetId,
        feeWei,
      });
    } else {
      // For BNB, force shadow route so on-chain Deposit.depositor is shadow, not user EOA.
      const shadowReq = {
        depositor,
        token: ethers.ZeroAddress,
        amount: session.amount,
        commitment,
        assetID: Number(session.assetId),
        deadline: Number(session.payload?.shadowDeadline || Math.floor(Date.now() / 1000) + 900),
      };
      const shadowSeed = getShadowSeed(shadowReq);
      const shadowSigner = new ethers.Wallet(shadowSeed, provider);
      const feeWei = await getDepositFeeBNBWei();
      const totalFunding = BigInt(session.amount) + feeWei + SHADOW_SWEEP_GAS_BUFFER_WEI;
      const fundTx = await wallet.sendTransaction({ to: shadowSigner.address, value: totalFunding });
      await fundTx.wait();
      const sweepOut = await sweepShadowDeposit(shadowSigner.address, shadowReq);
      if (sweepOut?.shadowSweepFailed || !sweepOut?.txHash) {
        throw new Error(sweepOut?.shadowSweepError || "module4_bnb_shadow_sweep_failed");
      }
      tx = { hash: sweepOut.txHash, wait: async () => await provider.getTransactionReceipt(sweepOut.txHash) };
    }
  } catch (e) {
    logModule4("deposit.submit.tx_failed", { message: e?.shortMessage || e?.message });
    return res.status(400).json({ error: e?.shortMessage || e?.message || "deposit tx failed" });
  }

  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    logModule4("deposit.submit.receipt_failed", { message: e?.message });
    return res.status(500).json({ error: e?.message || "receipt wait failed" });
  }

  const txHash = receipt.hash;
  try {
    const receiptJson = JSON.stringify({
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed != null ? String(receipt.gasUsed) : null,
    });
    saveDepositTxReceipt(db, {
      id: crypto.randomUUID(),
      sessionId,
      txHash,
      receiptJson,
    });
  } catch (e) {
    logModule4("deposit.submit.receipt_persist_failed", { message: e?.message });
  }

  let noteOut;
  try {
    noteOut = await persistNoteFromDepositReceipt(txHash, note, depositor, { module4: true });
  } catch (e) {
    if (e.code === "COMMITMENT_MISMATCH") {
      return res.status(500).json({
        error: "on_chain_commitment_mismatch_after_tx",
        txHash,
        expectedCommitment: e.expectedCommitment,
        providedCommitment: e.providedCommitment,
      });
    }
    return res.status(500).json({ error: e.message || "note persist failed", txHash });
  }

  const mergedPayload = {
    ...session.payload,
    txHash,
    noteId: noteOut.noteId,
    commitmentIndex: noteOut.commitmentIndex,
  };
  saveDepositSession(db, {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    idempotencyKey: session.idempotencyKey,
    depositor: session.depositor,
    mode: session.mode,
    token: session.token,
    amount: session.amount,
    assetId: session.assetId,
    status: "submitted",
    payload: mergedPayload,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
  });

  logModule4("deposit.submit.ok", {
    sessionId,
    txHash,
    commitmentIndex: noteOut.commitmentIndex,
    noteId: noteOut.noteId,
  });

  return res.json({
    ok: true,
    txHash,
    commitmentIndex: noteOut.commitmentIndex,
    noteId: noteOut.noteId,
    ownerAddress: noteOut.ownerAddress,
    commitment: noteOut.commitment,
    blockNumber: noteOut.blockNumber,
    flow: "A",
  });
});

app.get("/relayer/deposit/status", (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  const idempotencyKey = String(req.query.idempotencyKey || "").trim();
  if (!sessionId && !idempotencyKey) {
    return res.status(400).json({ error: "sessionId or idempotencyKey query required" });
  }
  try {
    const row = sessionId
      ? getDepositSessionBySessionId(db, sessionId)
      : getDepositSessionByIdempotencyKey(db, idempotencyKey);
    if (!row) return res.status(404).json({ error: "not_found" });
    return res.json({
      sessionId: row.sessionId,
      status: row.status,
      depositor: row.depositor,
      mode: row.mode,
      assetId: row.assetId,
      expiresAt: row.createdAt + MODULE4_SESSION_TTL_MS,
      txHash: row.payload?.txHash || null,
      noteId: row.payload?.noteId || null,
      commitmentIndex: row.payload?.commitmentIndex ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "status failed" });
  }
});

app.get("/notes/:noteId", async (req, res) => {
  try {
    const owner = noteAuthOwner(req);
    if (!owner) {
      return res.status(401).json({ error: "ownerAddress is required (query or x-owner-address header)" });
    }
    const row = getEncryptedNote(db, req.params.noteId);
    if (!row) return res.status(404).json({ error: "Note not found" });
    if (String(row.ownerAddress).toLowerCase() !== owner) {
      return res.status(403).json({ error: "Note does not belong to ownerAddress" });
    }
    const data = decryptJsonAtRest(row.payloadEnc);
    return res.json({
      noteId: row.noteId,
      ownerAddress: row.ownerAddress,
      commitment: row.commitment,
      txHash: row.txHash,
      createdAt: row.createdAt,
      note: data.note,
      metadata: {
        commitmentIndex: data.commitmentIndex,
        blockNumber: data.blockNumber,
        token: data.token,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Failed to load note" });
  }
});

app.get("/notes", async (req, res) => {
  try {
    const owner = noteAuthOwner(req);
    if (!owner) {
      return res.status(401).json({ error: "ownerAddress is required (query or x-owner-address header)" });
    }
    const activeCfg = getActiveNoteConfig();
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const rows = listEncryptedNotesByOwner(db, owner, Number.isFinite(limit) ? limit : 50);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const pool = new ethers.Contract(
      SHIELDED_POOL_ADDRESS,
      ["function isNullifierUsed(bytes32 nullifier) view returns (bool)"],
      provider
    );
    const notes = [];
    const filteredOut = [];
    for (const r of rows) {
      let envelope = null;
      let note = null;
      try {
        envelope = decryptJsonAtRest(r.payloadEnc) || {};
        note = envelope.note;
      } catch {
        filteredOut.push({ noteId: r.noteId, code: "STALE_NOTE", reason: "decrypt_failed" });
        continue;
      }
      if (!note) {
        filteredOut.push({ noteId: r.noteId, code: "STALE_NOTE", reason: "missing_note_payload" });
        continue;
      }
      try {
        validateNoteAgainstActiveConfig(envelope, activeCfg);
      } catch (e) {
        filteredOut.push({ noteId: r.noteId, code: e.code || "STALE_NOTE", reason: e.message });
        continue;
      }
      const nullifier = String(note.nullifier || "").trim();
      if (!nullifier) {
        filteredOut.push({ noteId: r.noteId, code: "STALE_NOTE", reason: "missing_nullifier" });
        continue;
      }
      const isSpent = await pool.isNullifierUsed(nullifier);
      if (isSpent) {
        filteredOut.push({ noteId: r.noteId, code: "SPENT_NOTE", reason: "on_chain_nullifier_used" });
        continue;
      }
      notes.push({
        noteId: r.noteId,
        commitment: r.commitment,
        txHash: r.txHash,
        createdAt: r.createdAt,
        status: "unspent",
        poolAddress: activeCfg.poolAddress,
        oracleAddress: activeCfg.oracleAddress,
        deploymentVersion: activeCfg.deploymentVersion,
        note,
      });
    }
    if (filteredOut.length > 0) {
      const counts = filteredOut.reduce((acc, x) => {
        const k = String(x.code || "UNKNOWN");
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      console.warn("[notes] filtered stale/spent notes", counts);
    }
    return res.json({
      ownerAddress: owner,
      count: notes.length,
      notes,
      filteredOutCount: filteredOut.length,
      filteredOut: filteredOut.slice(0, 50),
      activeConfig: activeCfg,
    });
  } catch (err) {
    console.error("[notes] failed", err?.code || "UNKNOWN", err?.message || err);
    return res.status(400).json({ error: err.message || "Failed to list notes" });
  }
});

app.get("/notes/threat-model", (_req, res) => {
  res.json({
    scope: "MVP testnet only",
    atRestEncryption: "AES-256-GCM using NOTES_ENCRYPTION_KEY_HEX or NOTES_ENCRYPTION_KEY_FILE",
    auth: "Minimal ownerAddress gate via query/header; not strong authentication",
    risks: [
      "If server key is leaked, encrypted note payloads are decryptable",
      "ownerAddress-only gate is weak and should be replaced with signed auth/session",
      "No tenant isolation beyond ownerAddress filtering",
    ],
    productionRecommendation: [
      "Use KMS-managed key (rotation + access policy)",
      "Require wallet signature auth (nonce challenge) before note read/list",
      "Add audit logs and per-tenant access controls",
    ],
  });
});

app.get("/merkle/index/:index", async (req, res) => {
  try {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "Invalid index" });
    if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
      return res.status(500).json({ error: "RPC_URL/SHIELDED_POOL_ADDRESS not configured" });
    }
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const abi = [
      "function commitmentCount() view returns (uint256)",
      "function commitments(uint256) view returns (bytes32)",
      "function merkleRoot() view returns (bytes32)"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);
    const count = Number(await contract.commitmentCount());
    if (index >= count) return res.status(404).json({ error: `Index ${index} out of range`, commitmentCount: count });
    const commitments = [];
    for (let i = 0; i < count; i += 1) commitments.push(await contract.commitments(i));
    const rootOnChain = await contract.merkleRoot();
    const commitment = commitments[index];
    const { path, indices, root } = buildMerklePath10(commitments, index);
    const ok = verifyMerklePath10(commitment, path, indices, rootOnChain);
    return res.json({
      index,
      commitment,
      merkleRoot: root,
      onChainRoot: rootOnChain,
      merklePath: path,
      merklePathIndices: indices,
      verified: ok,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "merkle index failed" });
  }
});

app.get("/merkle/self-check/:commitment", async (req, res) => {
  try {
    const commitment = String(req.params.commitment);
    if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
      return res.status(500).json({ error: "RPC_URL/SHIELDED_POOL_ADDRESS not configured" });
    }
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const abi = [
      "function commitmentCount() view returns (uint256)",
      "function commitments(uint256) view returns (bytes32)",
      "function merkleRoot() view returns (bytes32)"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);
    const count = Number(await contract.commitmentCount());
    const commitments = [];
    for (let i = 0; i < count; i += 1) commitments.push(await contract.commitments(i));
    const targetIndex = commitments.findIndex((c) => String(c).toLowerCase() === commitment.toLowerCase());
    if (targetIndex < 0) return res.status(404).json({ error: "Commitment not found" });
    const onChainRoot = await contract.merkleRoot();
    const { path, indices, root } = buildMerklePath10(commitments, targetIndex);
    const verified = verifyMerklePath10(commitment, path, indices, onChainRoot);
    return res.json({
      commitment,
      index: targetIndex,
      localRoot: root,
      onChainRoot,
      verified,
      merklePath: path,
      merklePathIndices: indices,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "merkle self-check failed" });
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "Phantom Protocol Relayer API",
    health: "/health",
    relayerDashboard: "/relayer/dashboard",
    docs: "See DEVELOPER_SPEC.md or WHITEPAPER.md for endpoints (quote, intent, swap, withdraw, relayer, staking, etc.)",
  });
});

app.get("/health", (req, res) => {
  let cfg = null;
  let cfgError = null;
  try {
    cfg = getRuntimeConfig();
  } catch (e) {
    cfgError = e?.message || String(e);
  }
  const seeCfg = getSeeConfig();
  let notesEncryptionConfigured = true;
  try {
    getNotesEncryptionKey();
  } catch (_) {
    notesEncryptionConfigured = false;
  }
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    mode: cfg?.mode || "unknown",
    chainId: cfg?.chainId ?? null,
    poolConfigured: !!cfg?.addresses?.shieldedPool,
    notesEncryptionConfigured,
    missingForTx: cfg?.missingForTx || [],
    configWarningCount: Array.isArray(cfg?.configWarnings) ? cfg.configWarnings.length : 0,
    configError: cfgError,
    module4: {
      sessionTtlMs: MODULE4_SESSION_TTL_MS,
      publicSubmit: MODULE4_PUBLIC_SUBMIT,
      relayerDryRunBlocks: RELAYER_DRY_RUN,
      ready:
        !!(RELAYER_PRIVATE_KEY && SHIELDED_POOL_ADDRESS && RPC_URL) && !RELAYER_DRY_RUN,
    },
    module6Withdraw: {
      chainalysisEnabled: CHAINALYSIS_ENABLED,
      chainalysisApiConfigured: !!CHAINALYSIS_API_URL,
      encryptedEnvelopeRequired: RELAYER_REQUIRE_ENCRYPTED_ENVELOPE,
      localSnarkVerifyRequired: RELAYER_REQUIRE_LOCAL_SNARK_VERIFY,
      relayerSwapAttestationMode: RELAYER_SWAP_ATTESTATION_MODE,
      relayerPrivacyHardSwitch: RELAYER_PRIVACY_HARD_SWITCH,
      endpoints: ["/withdraw/generate-proof", "/withdraw", "/withdraw/encrypted"],
    },
    module7Hardening: {
      deploymentTier: String(process.env.PHANTOM_DEPLOYMENT_TIER || "").trim() || "unset",
      noMockGateSkipped: process.env.PHANTOM_SKIP_NO_MOCK_GATE === "true",
      mockFingerprintFile: "config/module7-mock-bytecode-hashes.json",
    },
    internalRoutes: {
      intentInternal: true,
      settlementInternal: true,
      seeMode: seeCfg.mode,
      endpoints: [
        "/intent/internal",
        "/intent/internal/cancel",
        "/intent/internal/:id",
        "/settlement/internal/:matchHash/start",
        "/settlement/internal/:matchHash/retry",
        "/settlement/internal/:matchHash/status",
      ],
    },
  });
});

app.get("/internal-matching/health", (req, res) => {
  const seeCfg = getSeeConfig();
  const guardrails = evaluateInternalMatchingGuardrails(process.env, {
    seeConfig: seeCfg,
    deriveFheSecurityPolicy,
  });
  const validatorUrls = String(process.env.VALIDATOR_URLS || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const payload = {
    status: guardrails.ok ? "ok" : "degraded",
    production:
      String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
      String(process.env.PHANTOM_DEPLOYMENT_TIER || "").toLowerCase() === "production",
    guardrails,
    config: {
      settlementMode: String(process.env.SETTLEMENT_SUBMISSION_MODE || "dry_run").toLowerCase(),
      validatorUrlCount: validatorUrls.length,
      attestationRequired: String(process.env.ATTESTATION_REQUIRED || "").toLowerCase() === "true",
      attestationQuorumBps: Number(process.env.ATTESTATION_REQUIRED_QUORUM_BPS || 0),
      compliancePolicyMode: String(process.env.COMPLIANCE_POLICY_MODE || "enforced").toLowerCase(),
      seeMode: seeCfg.mode,
      fheMode: String(process.env.FHE_MODE || "mock").toLowerCase(),
      fhePolicyMode: String(process.env.MATCHING_FHE_POLICY_MODE || "degraded").toLowerCase(),
    },
    routeCoverage: [
      "/intent/internal",
      "/intent/internal/cancel",
      "/intent/internal/:id",
      "/settlement/internal/:matchHash/start",
      "/settlement/internal/:matchHash/retry",
      "/settlement/internal/:matchHash/status",
    ],
  };
  return res.status(guardrails.ok ? 200 : 503).json(payload);
});

app.use("/intent/internal", requireSeeForSensitiveFlow, internalOrderRouter);

app.post("/settlement/internal/:matchHash/start", requireSeeForSensitiveFlow, async (req, res) => {
  const matchHash = String(req.params.matchHash || "").trim();
  if (!matchHash) return res.status(400).json({ error: "match_hash_required" });
  try {
    const out = await settlementCoordinator.start(matchHash, req.body || {});
    return res.json({
      ...out,
      trace: {
        traceId: out.traceId || null,
        matchHash: out.matchHash || matchHash,
        decisionHash: out.decisionHash || null,
        txHash: out.txHash || null,
        orderId: out.takerOrderId || out.makerOrderId || null,
        takerOrderId: out.takerOrderId || null,
        makerOrderId: out.makerOrderId || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "settlement_start_failed", message: e.message || String(e) });
  }
});

app.post("/settlement/internal/:matchHash/retry", requireSeeForSensitiveFlow, async (req, res) => {
  const matchHash = String(req.params.matchHash || "").trim();
  if (!matchHash) return res.status(400).json({ error: "match_hash_required" });
  try {
    const out = await settlementCoordinator.retry(matchHash, req.body || {});
    return res.json({
      ...out,
      trace: {
        traceId: out.traceId || null,
        matchHash: out.matchHash || matchHash,
        decisionHash: out.decisionHash || null,
        txHash: out.txHash || null,
        orderId: out.takerOrderId || out.makerOrderId || null,
        takerOrderId: out.takerOrderId || null,
        makerOrderId: out.makerOrderId || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "settlement_retry_failed", message: e.message || String(e) });
  }
});

app.get("/settlement/internal/:matchHash/status", requireSeeForSensitiveFlow, (req, res) => {
  const matchHash = String(req.params.matchHash || "").trim();
  if (!matchHash) return res.status(400).json({ error: "match_hash_required" });
  const snapshot = settlementCoordinator.getStatus(matchHash);
  if (!snapshot) return res.status(404).json({ error: "settlement_execution_not_found", matchHash });
  return res.json(snapshot);
});

app.get("/config", (req, res) => {
  const cfg = getRuntimeConfig();
  const notesKeySource = process.env.NOTES_ENCRYPTION_KEY_HEX
    ? "env:NOTES_ENCRYPTION_KEY_HEX"
    : (process.env.NOTES_ENCRYPTION_KEY_FILE ? "file:NOTES_ENCRYPTION_KEY_FILE" : "missing");
  res.json({
    mode: cfg.mode,
    chainId: cfg.chainId,
    deploymentVersion: cfg.deploymentVersion,
    rpcUrl: cfg.rpcUrl,
    addresses: cfg.addresses,
    assets: cfg.assets,
    features: cfg.features,
    see: getSeeConfig(),
    missingForTx: cfg.missingForTx,
    configFile: cfg.configFile,
    canonicalProfile: cfg.canonicalProfile,
    configWarnings: cfg.configWarnings || [],
    frozenConfig: true,
    notesAtRest: {
      encryption: "AES-256-GCM",
      keySource: notesKeySource,
      authModel: "minimal_owner_address_gate",
    },
    module4RelayerDeposit: {
      sessionTtlMs: MODULE4_SESSION_TTL_MS,
      publicSubmit: MODULE4_PUBLIC_SUBMIT,
      maxBnbWei: MODULE4_MAX_BNB_WEI.toString(),
      shadowSweepGasBufferWei: SHADOW_SWEEP_GAS_BUFFER_WEI.toString(),
      endpoints: ["/relayer/deposit/session", "/relayer/deposit/submit", "/relayer/deposit/status"],
    },
    module5QuoteConfig: {
      pancakeV3QuoterV2: getPancakeV3QuoterAddress() || "missing",
      pancakeV3DefaultFeeTier: Number(process.env.PANCAKE_V3_DEFAULT_FEE_TIER || 2500),
      pancakeV2RouterFallback: getPancakeV2RouterAddress() || "missing",
      executionPath: "relayer -> shieldedSwapJoinSplit -> ShieldedPool + adaptor",
    },
    module6Withdraw: {
      chainalysisEnabled: CHAINALYSIS_ENABLED,
      chainalysisFailClosed: CHAINALYSIS_FAIL_CLOSED,
      chainalysisApiUrlSet: !!CHAINALYSIS_API_URL,
      encryptedEnvelopeRequired: RELAYER_REQUIRE_ENCRYPTED_ENVELOPE,
      localSnarkVerifyRequired: RELAYER_REQUIRE_LOCAL_SNARK_VERIFY,
      relayerSwapAttestationMode: RELAYER_SWAP_ATTESTATION_MODE,
      relayerPrivacyHardSwitch: RELAYER_PRIVACY_HARD_SWITCH,
      feePolicy: "on_chain_oracle_floor_matches_ShieldedPool_shieldedWithdraw (see MODULE6-WITHDRAW.md)",
      endpoints: ["/withdraw/generate-proof", "/withdraw", "/withdraw/encrypted"],
    },
  });
});

app.get("/parameters", (_req, res) => {
  res.json({
    profile: RUNTIME_PARAMS.profile,
    fees: {
      dexSwapFeeBps: RUNTIME_PARAMS.fees.dexSwapFeeBps,
      internalMatchFeeBps: RUNTIME_PARAMS.fees.internalMatchFeeBps,
      depositFeeUsdE8: RUNTIME_PARAMS.fees.depositFeeUsdE8.toString(),
      oracleFeeFloorUsdE8: RUNTIME_PARAMS.fees.oracleFeeFloorUsdE8.toString(),
      oracleFeeRateBps: RUNTIME_PARAMS.fees.oracleFeeRateBps,
    },
  });
});

app.get("/see/config", (req, res) => {
  res.json(getSeeConfig());
});

app.post("/see/verify", (req, res) => {
  const result = verifyAttestation(req);
  if (!result.ok) return res.status(401).json(result);
  return res.json(result);
});

app.get("/ready", (req, res) => {
  const required = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  const missing = missingEnv(required);
  if (missing.length) {
    return res.status(503).json({
      ok: false,
      missing,
      configured: {
        SHIELDED_POOL_ADDRESS: !!process.env.SHIELDED_POOL_ADDRESS,
        RPC_URL: !!process.env.RPC_URL,
        RELAYER_PRIVATE_KEY: !!process.env.RELAYER_PRIVATE_KEY,
      },
    });
  }
  res.json({ ok: true });
});

app.get("/deposit/required-fee-bnb", async (req, res) => {
  try {
    const feeWei = await getDepositFeeBNBWei();
    res.json({ feeWei: feeWei.toString(), feeUsd: "2" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to get deposit fee" });
  }
});

const ESTIMATED_SHIELDED_SWAP_GAS_UNITS = 900000n;
const SWAP_GAS_REFUND_MAX_WEI = toBig(
  process.env.PHANTOM_SWAP_GAS_REFUND_MAX_WEI,
  CHAIN_ID === 97 ? 2n * 10n ** 15n : 8n * 10n ** 15n
);

async function attachQuoteExecutionHints(payload, slippageBps) {
  let suggestedGasRefundWei = "0";
  let gasPriceWei = "0";
  try {
    if (RPC_URL) {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const fd = await provider.getFeeData();
      const gp = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
      if (gp && gp > 0n) {
        gasPriceWei = gp.toString();
        let suggested = gp * ESTIMATED_SHIELDED_SWAP_GAS_UNITS;
        if (SWAP_GAS_REFUND_MAX_WEI > 0n && suggested > SWAP_GAS_REFUND_MAX_WEI) {
          suggested = SWAP_GAS_REFUND_MAX_WEI;
        }
        suggestedGasRefundWei = suggested.toString();
      }
    }
  } catch (_) {}
    const dexBps = RUNTIME_PARAMS.fees.dexSwapFeeBps;
  const src = payload.quoteSource;
  let routeDescription;
  if (src === "swap_adaptor") {
    routeDescription = "Shielded pool → swap adaptor (on-chain quote; same path as adaptor execution)";
  } else if (src === "pancake_v3_quoter_v2") {
    routeDescription = "Quote: PancakeSwap V3 QuoterV2 (official testnet/mainnet addresses). Execution: relayer submits shieldedSwapJoinSplit via ShieldedPool.";
  } else if (src === "pancake_v2_router") {
    routeDescription = "Quote: PancakeSwap V2 Router getAmountsOut (on-chain). Execution: relayer submits shielded pool tx.";
  } else if (src === "dex_oracle") {
    routeDescription = "Shielded pool → relayer quote (Dexscreener / oracle or mock)";
  } else {
    routeDescription =
      SWAP_ADAPTOR_ADDRESS && RPC_URL
        ? "Shielded pool → swap adaptor (BSC / Pancake-style liquidity)"
        : "Shielded pool → relayer quote (oracle or mock)";
  }
  return {
    ...payload,
    slippageToleranceBps: slippageBps,
    suggestedGasRefundWei,
    gasPriceWei,
    estimatedGasUnits: ESTIMATED_SHIELDED_SWAP_GAS_UNITS.toString(),
    relayerGasPolicy: "user_note_gasRefund",
    relayerPaysNetworkGas: false,
    protocolDexFeeBps: dexBps,
    routeDescription,
  };
}

app.post("/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let { tokenIn, tokenOut, amountIn, tokenInDecimals, tokenOutDecimals, slippageBps, chainSlug, feeTier, sqrtPriceLimitX96, deadlineSec } = parsed.data;
  try {
    tokenIn = normalizeEvmAddress(tokenIn);
    tokenOut = normalizeEvmAddress(tokenOut);
    assertTokenAllowed(tokenIn, "tokenIn");
    assertTokenAllowed(tokenOut, "tokenOut");
  } catch (e) {
    return res.status(400).json({ error: "invalid_token_address", message: e?.message || String(e) });
  }

  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return res.status(400).json({
      error: "identical_token_in_out",
      message: "tokenIn and tokenOut resolve to the same address (e.g. both native/tBNB). Pick two different assets for a swap quote.",
    });
  }

  // Keep quote source aligned with execution path: when a SwapAdaptor is configured,
  // quote via adaptor first so `outputAmountSwap` matches on-chain swap execution.
  if (RPC_URL && !SWAP_ADAPTOR_ADDRESS) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const amountInBn = parseAmount(amountIn);
      const v3 = await tryQuotePancakeV3Quoter(
        provider,
        tokenIn,
        tokenOut,
        amountInBn,
        feeTier || Number(process.env.PANCAKE_V3_DEFAULT_FEE_TIER || 2500),
        sqrtPriceLimitX96 || 0
      );
      if (v3) {
        const minOut = (v3.outAmount * BigInt(10000 - slippageBps)) / 10000n;
        const payload = {
          quoteSource: "pancake_v3_quoter_v2",
          quoteVersion: "pancake-v3-quoter-v2",
          amountOut: v3.outAmount.toString(),
          minAmountOut: minOut.toString(),
          priceIn: "0",
          priceOut: "0",
          quotePath: [v3.tokenIn.toLowerCase(), v3.tokenOut.toLowerCase()],
          routeParams: {
            feeTier: Number(v3.feeTier),
            sqrtPriceLimitX96: String(v3.sqrtPriceLimitX96),
            path: v3.path,
            deadlineSec: Number(deadlineSec || 900),
          },
          quoterAddress: v3.quoter,
          fees: {
            oracleFee: "0",
            swapFee: "0",
            totalFee: "0",
            oracleFeeUsd: "0"
          }
        };
        const enriched = await attachQuoteExecutionHints(payload, slippageBps);
        saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(enriched))), null, enriched);
        return res.json(enriched);
      }
    } catch (e) {
      console.warn("Pancake V3 quoter quote failed, falling back:", e.message);
    }
  }

  if (SWAP_ADAPTOR_ADDRESS && RPC_URL) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const adaptorAbi = [
        "function getExpectedOutput((address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint24 fee,uint160 sqrtPriceLimitX96,bytes path)) view returns (uint256)"
      ];
      const adaptor = new ethers.Contract(SWAP_ADAPTOR_ADDRESS, adaptorAbi, provider);
      const amountInBn = parseAmount(amountIn);

      const swapParams = {
        tokenIn: normalizeEvmAddress(tokenIn),
        tokenOut: normalizeEvmAddress(tokenOut),
        amountIn: amountInBn,
        minAmountOut: 0,
        fee: 0,
        sqrtPriceLimitX96: 0,
        path: req.body?.path || "0x"
      };
      const outAmount = BigInt((await adaptor.getExpectedOutput(swapParams)).toString());
      const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;
      const payload = {
        quoteSource: "swap_adaptor",
        amountOut: outAmount.toString(),
        minAmountOut: minOut.toString(),
        priceIn: "0",
        priceOut: "0",
        fees: {
          oracleFee: "0",
          swapFee: "0",
          totalFee: "0",
          oracleFeeUsd: "0"
        }
      };
      const enriched = await attachQuoteExecutionHints(payload, slippageBps);
      saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(enriched))), null, enriched);
      return res.json(enriched);
    } catch (e) {
      console.warn("On-chain quote via SwapAdaptor failed, falling back:", e.message);
    }
  }

  if (RPC_URL && getPancakeV2RouterAddress() && !SWAP_ADAPTOR_ADDRESS) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const amountInBn = parseAmount(amountIn);
      const pq = await tryQuotePancakeV2Router(provider, tokenIn, tokenOut, amountInBn, req.body?.path);
      if (pq) {
        const minOut = (pq.outAmount * BigInt(10000 - slippageBps)) / 10000n;
        const payload = {
          quoteSource: "pancake_v2_router",
          amountOut: pq.outAmount.toString(),
          minAmountOut: minOut.toString(),
          priceIn: "0",
          priceOut: "0",
          quotePath: pq.hopPath.map((a) => a.toLowerCase()),
          fees: {
            oracleFee: "0",
            swapFee: "0",
            totalFee: "0",
            oracleFeeUsd: "0"
          }
        };
        const enriched = await attachQuoteExecutionHints(payload, slippageBps);
        saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(enriched))), null, enriched);
        return res.json(enriched);
      }
    } catch (e) {
      console.warn("Pancake V2 router quote failed, falling back:", e.message);
    }
  }

  let priceIn;
  let priceOut;

  try {
    priceIn = await getDexPriceUsd(tokenIn, chainSlug);
    priceOut = await getDexPriceUsd(tokenOut, chainSlug);
  } catch (dexError) {
    console.warn(`DEXScreener failed: ${dexError.message}, trying PancakeSwap fallback`);

    const mockPrices = {
      "0x0000000000000000000000000000000000000000": 60000000000n, 

      "0xae13d989dac2f0debff460ac112a837c89baa7cd": 60000000000n, 

      "0x7ef95a0fee0dd31b22626fa2e10ee6a223f8a684": 100000000n,   

      "0x64544969ed7ebf5f083679233325356ebe738930": 100000000n,   

      "0x78867bbeef44f2326bf8ddd1941a4439382ef2a7": 100000000n,   

      "0xfa60d973f7642b748046464e165a65b7323b0dee": 500000000n,   

      "0x8babbb98678facc7342735486c851abd7a0d17ca": 300000000000n, 

      "0x6ce8da28e2f864420840cf74474eff5fd80e65b8": 6000000000000n, 

      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": 60000000000n, 

      "0x55d398326f99059ff775485246999027b3197955": 100000000n,   

      "0xe9e7cea3dedca5984780bafc599bd69add087d56": 100000000n,   

      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 100000000n,   

      "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": 500000000n,   

      "0x2170ed0880ac9a755fd29b2688956bd959f933f8": 300000000000n, 

      "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": 6000000000000n, 

    };

    priceIn = mockPrices[tokenIn.toLowerCase()] || 100000000n;
    priceOut = mockPrices[tokenOut.toLowerCase()] || 100000000n;

    console.log(`Using fallback prices: tokenIn=${tokenIn} @ $${Number(priceIn) / 1e8}, tokenOut=${tokenOut} @ $${Number(priceOut) / 1e8}`);
  }

  const amountInBn = parseAmount(amountIn);
  const inDecimals = BigInt(tokenInDecimals ?? 18);
  const outDecimals = BigInt(tokenOutDecimals ?? 18);
  const usdValue = (amountInBn * priceIn) / 10n ** inDecimals;
  const outAmount = (usdValue * 10n ** outDecimals) / priceOut;
  const minOut = (outAmount * BigInt(10000 - slippageBps)) / 10000n;
  const oracleFeeUsd = calcOracleFeeUsd(usdValue);
  const oracleFeeToken = (oracleFeeUsd * 10n ** inDecimals) / priceIn;
  const swapFeeToken = (amountInBn * BigInt(RUNTIME_PARAMS.fees.dexSwapFeeBps)) / 10000n;
  const totalFeeToken = oracleFeeToken + swapFeeToken;

  const payload = {
    quoteSource: "dex_oracle",
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
  const enriched = await attachQuoteExecutionHints(payload, slippageBps);
  saveQuote(db, ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(enriched))), null, enriched);
  res.json(enriched);
});

app.post("/intent", async (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const payload = {
    userAddress: ethers.getAddress(parsed.data.userAddress),
    inputAssetID: Number(parsed.data.inputAssetID),
    outputAssetID: Number(parsed.data.outputAssetID),
    amountIn: String(parsed.data.amountIn),
    minAmountOut: String(parsed.data.minAmountOut),
    nonce: String(parsed.data.nonce),
    nullifier: parsed.data.nullifier,
    deadline: Number(parsed.data.deadline),
  };
  const intentId = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({ ...payload, t: Date.now() }))
  );
  intents.set(intentId, payload);
  saveIntent(db, intentId, payload.userAddress, payload);
  res.json({ intentId, intent: payload, domain: INTENT_DOMAIN, types: INTENT_TYPES, typesV2: INTENT_TYPES_V2 });
});

async function processSwapRequestBody(body) {
  const parsed = swapSchema.safeParse(body);
  if (!parsed.success) {
    const err = new Error("Invalid swap payload");
    err.status = 400;
    err.details = parsed.error.flatten();
    throw err;
  }

  const { intentId: incomingIntentId, intent: incomingIntent, intentSig, swapData, zkAuthorization } = parsed.data;
  const pi = swapData?.publicInputs || {};
  assertAssetIdConfigured(pi?.inputAssetID, "swap_inputAssetID");
  assertAssetIdConfigured(pi?.outputAssetIDSwap, "swap_outputAssetIDSwap");
  const usingLegacyIntent = !!(incomingIntentId && incomingIntent && intentSig);
  let intentId = incomingIntentId || "";
  let intent = null;
  let ownerAddress = null;
  const swapPublicInputHash = computeSwapPublicInputHash(pi);

  if (usingLegacyIntent) {
    intent = incomingIntent;
    if (Number(intent.deadline) < Math.floor(Date.now() / 1000)) {
      const err = new Error("Intent expired");
      err.status = 400;
      throw err;
    }
    if (!consumeReplayKey(`swap_intent:${String(intent.nullifier).toLowerCase()}:${String(intent.nonce)}`)) {
      const err = new Error("Intent already processed or replay detected");
      err.status = 409;
      throw err;
    }
    const cached = intents.get(intentId) || getIntent(db, intentId)?.payload;
    // Serverless instances do not share in-memory/disk state across invocations.
    // If /intent and /swap/encrypted land on different instances, cached intent may be missing.
    // In that case, continue with signature-bound payload validation below.
    if (cached) {
      try {
        const sameNullifier = String(cached.nullifier || "").toLowerCase() === String(intent.nullifier || "").toLowerCase();
        const sameNonce = String(cached.nonce || "") === String(intent.nonce || "");
        if (!sameNullifier || !sameNonce) {
          const err = new Error("intent payload mismatch for provided intentId");
          err.status = 400;
          throw err;
        }
      } catch (e) {
        if (e?.status) throw e;
      }
    }

    const typedIntent = {
      user: ethers.getAddress(intent.userAddress),
      inputAssetID: BigInt(intent.inputAssetID),
      outputAssetID: BigInt(intent.outputAssetID),
      amountIn: BigInt(intent.amountIn),
      minAmountOut: BigInt(intent.minAmountOut),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      nullifier: intent.nullifier,
    };
    const signerAddr = ethers.verifyTypedData(INTENT_DOMAIN, INTENT_TYPES, typedIntent, intentSig);
    if (signerAddr.toLowerCase() !== String(intent.userAddress).toLowerCase()) {
      const err = new Error("Invalid intent signature");
      err.status = 400;
      throw err;
    }
    ownerAddress = intent.userAddress;
  } else {
    const nullifierHex = canonicalNullifierHex(zkAuthorization?.nullifier ?? pi?.nullifier);
    if (!nullifierHex) {
      const err = new Error("swap publicInputs.nullifier is required");
      err.status = 400;
      throw err;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const deadline = Number(zkAuthorization?.deadline ?? (nowSec + 900));
    if (!Number.isFinite(deadline) || deadline < nowSec) {
      const err = new Error("ZK authorization expired");
      err.status = 400;
      throw err;
    }
    const nonce = String(zkAuthorization?.nonce ?? "0");
    const minAmountOut = String(zkAuthorization?.minAmountOut ?? pi?.minOutputAmountSwap ?? swapData?.swapParams?.minAmountOut ?? "0");
    if (!consumeReplayKey(`swap_zk:${nullifierHex}`)) {
      const err = new Error("Swap already processed or replay detected");
      err.status = 409;
      throw err;
    }
    intent = {
      userAddress: ethers.ZeroAddress,
      inputAssetID: String(pi?.inputAssetID ?? 0),
      outputAssetID: String(pi?.outputAssetIDSwap ?? 0),
      amountIn: String(pi?.swapAmount ?? 0),
      minAmountOut,
      nonce,
      nullifier: nullifierHex,
      deadline,
    };
    if (zkAuthorization?.publicInputHash) {
      if (String(zkAuthorization.publicInputHash).toLowerCase() !== String(swapPublicInputHash).toLowerCase()) {
        const err = new Error("zkAuthorization.publicInputHash mismatch");
        err.status = 400;
        throw err;
      }
    }
    if (zkAuthorization?.signature) {
      if (!zkAuthorization?.userAddress) {
        const err = new Error("zkAuthorization.userAddress is required with signature");
        err.status = 400;
        throw err;
      }
      const typedIntentV2 = {
        user: ethers.getAddress(zkAuthorization.userAddress),
        publicInputHash: swapPublicInputHash,
        deadline: BigInt(deadline),
        nonce: BigInt(nonce),
        nullifier: nullifierHex,
      };
      const signerAddr = ethers.verifyTypedData(INTENT_DOMAIN, INTENT_TYPES_V2, typedIntentV2, zkAuthorization.signature);
      if (signerAddr.toLowerCase() !== String(zkAuthorization.userAddress).toLowerCase()) {
        const err = new Error("Invalid zkAuthorization signature");
        err.status = 400;
        throw err;
      }
      ownerAddress = ethers.getAddress(zkAuthorization.userAddress);
      intent.userAddress = ownerAddress;
    }
    intentId = incomingIntentId || ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({
        publicInputHash: swapPublicInputHash,
        nullifier: intent.nullifier,
        deadline: intent.deadline,
        nonce: intent.nonce,
      }))
    );
  }
  assertIntentNullifierMatchesSwapPublicInputs(intent, swapData?.publicInputs);
  if (ownerAddress && ownerAddress !== ethers.ZeroAddress) {
    try {
      await screenDepositDepositor(ethers.getAddress(ownerAddress), "swap");
    } catch (e) {
      if (e?.status) {
        const out = complianceErrorResponse(e, "chainalysis_depositor_not_allowed");
        const err = new Error(out.body.error);
        err.status = out.status;
        err.details = out.body;
        throw err;
      }
      throw e;
    }
  }
  if (usingLegacyIntent) {
    if (String(pi.outputAssetIDSwap) !== String(intent.outputAssetID) || String(pi.inputAssetID) !== String(intent.inputAssetID)) {
      const err = new Error("Intent asset IDs do not match swap public inputs");
      err.status = 400;
      throw err;
    }
    if (toBigInt(pi.swapAmount || 0) !== toBigInt(intent.amountIn || 0)) {
      const err = new Error("Intent amountIn must match swap publicInputs.swapAmount");
      err.status = 400;
      throw err;
    }
    if (toBigInt(pi.minOutputAmountSwap || 0) !== toBigInt(intent.minAmountOut || 0)) {
      const err = new Error("Intent minAmountOut must match swap publicInputs.minOutputAmountSwap");
      err.status = 400;
      throw err;
    }
  }
  if (toBigInt(swapData?.swapParams?.minAmountOut || 0) !== toBigInt(intent.minAmountOut || 0)) {
    const err = new Error("Intent minAmountOut must match swapParams.minAmountOut");
    err.status = 400;
    throw err;
  }
  if (!RELAYER_PRIVACY_HARD_SWITCH) assertSwapRoutingConsistency(swapData);
  swapData.commitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256", "uint256"],
      [intent.nullifier, swapPublicInputHash, intent.deadline, intent.nonce]
    )
  );
  swapData.deadline = Number(intent.deadline);
  swapData.nonce = BigInt(intent.nonce).toString();
  let internalFheMatch = null;
  try {
    const piForFhe = swapData?.publicInputs || {};
    const enc = swapData?.encryptedPayload;
    if (enc && enc !== "0x" && enc.length > 10 && piForFhe.inputAssetID != null && piForFhe.outputAssetIDSwap != null) {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const [fheEncryptedInputAmount, fheEncryptedMinOutput] = coder.decode(["bytes", "bytes"], enc);
      const reg = await registerOrderAndTryMatch({
        fheEncryptedInputAmount: ethers.hexlify(fheEncryptedInputAmount),
        fheEncryptedMinOutput: ethers.hexlify(fheEncryptedMinOutput),
        inputAssetID: piForFhe.inputAssetID,
        outputAssetID: piForFhe.outputAssetIDSwap,
      });
      if (reg.matched && reg.matchResult) {
        internalFheMatch = {
          matched: true,
          executionId: reg.matchResult.executionId,
          fheEncryptedResult: reg.matchResult.fheEncryptedResult,
          fheMode: getFheMatchMode(),
        };
      }
    }
  } catch (e) {
    console.warn("[swap] internal FHE order book:", e.message || e);
  }

  const txResult = RELAYER_DRY_RUN
    ? await simulateSwap(intentId)
    : await submitSwap(swapData);
  if (internalFheMatch) txResult.internalFheMatch = internalFheMatch;
  if (!RELAYER_DRY_RUN && txResult?.txHash && ownerAddress && ownerAddress !== ethers.ZeroAddress) {
    try {
      const persisted = await persistSwapOutputNotes({
        txHash: txResult.txHash,
        ownerAddress,
        noteHints: swapData.noteHints,
        publicInputs: swapData.publicInputs,
      });
      if (persisted) txResult.module3Notes = persisted;
    } catch (e) {
      txResult.module3NotesWarning = e.message || String(e);
    }
  }

  const receipt = buildReceipt(intentId, swapData, txResult);
  receipts.set(intentId, receipt);
  saveReceipt(db, intentId, ownerAddress || ethers.ZeroAddress, receipt);

  return {
    version: "1.0",
    intentId,
    swapOutput: {
      amount: receipt.outputAmountSwap || "0",
      assetId: receipt.outputAssetIdSwap || 0,
      minAmount: intent.minAmountOut,
    },
    commitments: {
      swap: receipt.outputCommitmentSwap || ethers.ZeroHash,
      change: receipt.outputCommitmentChange || ethers.ZeroHash,
    },
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    encryptedPayload: receipt.encryptedPayload,
    internalFheMatch: receipt.internalFheMatch ?? null,
  };
}

app.post("/swap", requireSeeForSensitiveFlow, async (req, res) => {
  if (rejectPlainSensitiveRoute(res, "/swap/encrypted")) return;
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Swap")) return;
  try {
    const payload = await processSwapRequestBody(req.body);
    res.json(payload);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    console.error("[Swap] Error:", err.message);
    return res.status(500).json({ error: err.message || "swap failed" });
  }
});

app.post("/swap/encrypted", requireSeeForSensitiveFlow, async (req, res) => {
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Swap encrypted")) return;
  try {
    const envelope = req.body?.envelope;
    const decryptedBody = decryptRelayEnvelope(envelope);
    const payload = await processSwapRequestBody(decryptedBody);
    res.json(payload);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    return res.status(400).json({ error: err.message || "Encrypted swap failed" });
  }
});

app.post("/withdraw", requireSeeForSensitiveFlow, async (req, res) => {
  if (rejectPlainSensitiveRoute(res, "/withdraw/encrypted")) return;
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Withdraw")) return;
  try {
    const txResult = await processWithdrawRequestBody(req.body);
    res.json(txResult);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    res.status(500).json({ error: err.message || "withdraw failed" });
  }
});

app.post("/withdraw/encrypted", requireSeeForSensitiveFlow, async (req, res) => {
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Withdraw encrypted")) return;
  try {
    const envelope = req.body?.envelope;
    const decryptedBody = decryptRelayEnvelope(envelope);
    const txResult = await processWithdrawRequestBody(decryptedBody);
    res.json(txResult);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    res.status(500).json({ error: err.message || "withdraw failed" });
  }
});

const portfolioSwapSchema = z.object({
  swapData: z.any()
}).passthrough();

app.post("/portfolio/swap", async (req, res) => {
  const parsed = portfolioSwapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioSwap(parsed.data.swapData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio swap failed" });
  }
});

const portfolioDepositSchema = z.object({
  depositData: z.any()
}).passthrough();

app.post("/portfolio/deposit", async (req, res) => {
  const parsed = portfolioDepositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioDeposit(parsed.data.depositData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio deposit failed" });
  }
});

const portfolioWithdrawSchema = z.object({
  withdrawData: z.any()
}).passthrough();

app.post("/portfolio/withdraw", async (req, res) => {
  const parsed = portfolioWithdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const txResult = await submitPortfolioWithdraw(parsed.data.withdrawData);
    res.json(txResult);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio withdraw failed" });
  }
});

app.get("/relayer/network", (req, res) => {
  res.json({
    rpcUrl: RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
    chainId: CHAIN_ID || 97
  });
});

app.get("/relayer", (req, res) => {
  if (!requireConfigured(res, ["RELAYER_PRIVATE_KEY"], "Relayer")) return;
  const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
  res.json({
    relayer: relayer.address,
    dryRun: RELAYER_DRY_RUN,
    bypassValidators: DEV_BYPASS_VALIDATORS,
    bypassProofs: DEV_BYPASS_PROOFS,
    validatorUrls: VALIDATOR_URLS,
    coordinatorWsUrl: VALIDATOR_COORDINATOR_WS_URL || null
  });
});

app.get("/relayer/encryption-key", (req, res) => {
  res.json({
    algorithm: "RSA-OAEP-256 + AES-256-GCM",
    keyId: relayerEncKeyId,
    publicKeyPem: relayerEncPublicKeyPem,
  });
});

app.get("/verification-key", (req, res) => {
  const vkPath = path.join(__dirname, "..", "..", "circuits", "verification_key.json");
  if (!fs.existsSync(vkPath)) return res.status(404).json({ error: "Verification key not found" });
  res.json(JSON.parse(fs.readFileSync(vkPath, "utf8")));
});

async function getStakingContract(provider) {
  let stakingAddr = RELAYER_STAKING_ADDRESS;
  if (!stakingAddr && SHIELDED_POOL_ADDRESS) {
    try {
      const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, ["function relayerRegistry() view returns (address)"], provider);
      stakingAddr = await pool.relayerRegistry();
    } catch (_) {}
  }
  if (!stakingAddr || stakingAddr === ethers.ZeroAddress) {
    throw new Error("Pool has no staking contract. Set RELAYER_STAKING_ADDRESS.");
  }
  return new ethers.Contract(stakingAddr, [
    "function totalStaked() view returns (uint256)",
    "function minStake() view returns (uint256)",
    "function token() view returns (address)",
    "function stakedBalance(address) view returns (uint256)",
    "function getRewardTokens() view returns (address[])"
  ], provider);
}

app.get("/staking/stats", async (req, res) => {
  if (RELAYER_DRY_RUN) {
    return res.json({
      stakingAddress: RELAYER_STAKING_ADDRESS || ethers.ZeroAddress,
      protocolTokenAddress: ethers.ZeroAddress,
      totalStaked: "0",
      minStake: "0",
      rewardTokenCount: 0
    });
  }
  if (!requireConfigured(res, ["RPC_URL", "SHIELDED_POOL_ADDRESS"], "Staking stats")) return;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const staking = await getStakingContract(provider);
    const [totalStaked, minStake, tokenAddr, rewardTokens] = await Promise.all([
      staking.totalStaked(),
      staking.minStake(),
      staking.token(),
      staking.getRewardTokens().catch(() => [])
    ]);
    res.json({
      stakingAddress: staking.target,
      protocolTokenAddress: tokenAddr,
      totalStaked: totalStaked.toString(),
      minStake: minStake.toString(),
      rewardTokenCount: rewardTokens?.length ?? 0
    });
  } catch (err) {
    console.error("[staking/stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/staking/balance", async (req, res) => {
  const addr = req.query.address;
  if (!addr || !ethers.isAddress(addr)) return res.status(400).json({ error: "Missing or invalid address" });
  if (RELAYER_DRY_RUN) {
    return res.json({
      address: addr,
      staked: "0",
      minStake: "0",
      isValid: true
    });
  }
  if (!requireConfigured(res, ["RPC_URL", "SHIELDED_POOL_ADDRESS"], "Staking balance")) return;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const staking = await getStakingContract(provider);
    const [staked, minStake] = await Promise.all([
      staking.stakedBalance(addr),
      staking.minStake()
    ]);
    res.json({
      address: addr,
      staked: staked.toString(),
      minStake: minStake.toString(),
      isValid: staked >= minStake
    });
  } catch (err) {
    console.error("[staking/balance]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/relayer/proof-stats", (req, res) => {
  try {
    res.json(getProofStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/relayer/dashboard", (req, res) => {
  try {
    const activity = getSnapshot();
    res.json({
      uptimeSec: Math.floor(process.uptime()),
      rateLimit: {
        defaultWindowMs: RATE_LIMIT_WINDOW_MS,
        defaultMaxPerWindow: RATE_LIMIT_MAX,
        module4WindowMs: MODULE4_RATE_WINDOW_MS,
        module4MaxPerWindow: MODULE4_RATE_MAX
      },
      fees: {
        dexSwapFeeBps: RUNTIME_PARAMS.fees.dexSwapFeeBps,
        internalMatchFeeBps: RUNTIME_PARAMS.fees.internalMatchFeeBps,
        depositFeeUsdE8: RUNTIME_PARAMS.fees.depositFeeUsdE8.toString(),
        oracleFeeFloorUsdE8: RUNTIME_PARAMS.fees.oracleFeeFloorUsdE8.toString(),
        oracleFeeRateBps: RUNTIME_PARAMS.fees.oracleFeeRateBps
      },
      documentation: {
        operatorRunbook: "RUNBOOK.md (repo root)",
        parametersEndpoint: "/parameters",
        configEndpoint: "/config"
      },
      ...activity
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/relayer/staking-status", async (req, res) => {
  if (RELAYER_DRY_RUN) {
    return res.json({
      relayer: RELAYER_PRIVATE_KEY ? new ethers.Wallet(RELAYER_PRIVATE_KEY).address : ethers.ZeroAddress,
      stakingAddress: RELAYER_STAKING_ADDRESS || ethers.ZeroAddress,
      staked: "0",
      minStake: "0",
      totalStaked: "0",
      isRelayerValid: true
    });
  }
  if (!RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) return res.status(500).json({ error: "Relayer or pool not configured" });
  if (!RPC_URL) return res.status(500).json({ error: "RPC_URL not configured" });
  try {
    const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY);
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    let stakingAddr = RELAYER_STAKING_ADDRESS;
    if (!stakingAddr) {
      try {
        const poolAbi = ["function relayerRegistry() view returns (address)"];
        const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, provider);
        stakingAddr = await pool.relayerRegistry();
      } catch (e) {
        return res.status(500).json({ error: `Pool read failed: ${e.message}. Check SHIELDED_POOL_ADDRESS and RPC_URL.` });
      }
      if (!stakingAddr || stakingAddr === ethers.ZeroAddress) {
        return res.status(500).json({ error: "Pool has no staking contract. Set RELAYER_STAKING_ADDRESS on Render (Environment)." });
      }
    }
    const stakingAbi = [
      "function stakedBalance(address) view returns (uint256)",
      "function minStake() view returns (uint256)",
      "function totalStaked() view returns (uint256)",
      "function isRelayer(address) view returns (bool)"
    ];
    const staking = new ethers.Contract(stakingAddr, stakingAbi, provider);
    const [staked, minStake, totalStaked, isValid] = await Promise.all([
      staking.stakedBalance(relayer.address),
      staking.minStake(),
      staking.totalStaked(),
      staking.isRelayer(relayer.address)
    ]);
    res.json({
      relayer: relayer.address,
      stakingAddress: stakingAddr,
      staked: staked.toString(),
      minStake: minStake.toString(),
      totalStaked: totalStaked.toString(),
      isRelayerValid: isValid
    });
  } catch (err) {
    console.error("[staking-status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/portfolio/swap-fee", async (req, res) => {
  if (!SHIELDED_POOL_ADDRESS || !RPC_URL) {
    return res.status(500).json({ error: "Pool not configured" });
  }
  try {
    const inputAssetId = parseInt(req.query.inputAssetId ?? "0", 10);
    const amount = req.query.amount ?? "0";
    const amountBigInt = BigInt(amount);
    if (amountBigInt === 0n) return res.json({ protocolFee: "0", swapFee: "0", totalProtocolFee: "0" });

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const poolAbi = [
      "function assetRegistry(uint256) view returns (address)",
      "function feeOracle() view returns (address)"
    ];
    const feeOracleAbi = ["function calculateFee(address token, uint256 amount) view returns (uint256)"];
    const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, provider);
    const inputToken = await pool.assetRegistry(inputAssetId);
    const feeOracleAddress = await pool.feeOracle();
    const feeOracle = new ethers.Contract(feeOracleAddress, feeOracleAbi, provider);

    let protocolFeeFromOracle = 0n;
    try {
      protocolFeeFromOracle = BigInt((await feeOracle.calculateFee(inputToken, amount)).toString());
      if (protocolFeeFromOracle > amountBigInt) protocolFeeFromOracle = amountBigInt; 

    } catch (e) {
      console.warn("FeeOracle.calculateFee failed, using 0:", e.message);
    }
    // DEX swap fee bps must stay aligned with M3 on-chain fee (default PHANTOM_DEX_SWAP_FEE_BPS=10).
    const dexBps = BigInt(RUNTIME_PARAMS.fees.dexSwapFeeBps);
    const swapFee = (amountBigInt * dexBps) / 10000n;
    const totalProtocolFee = protocolFeeFromOracle + swapFee;

    res.json({
      protocolFee: protocolFeeFromOracle.toString(),
      swapFee: swapFee.toString(),
      totalProtocolFee: totalProtocolFee.toString()
    });
  } catch (err) {
    console.error("swap-fee error:", err);
    res.status(500).json({ error: err.message || "Failed to compute swap fee" });
  }
});

app.post("/shadow-address", async (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const payload = parsed.data;
  if (payload.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Deposit request expired" });
  }
  const signerAddr = ethers.verifyTypedData(DEPOSIT_DOMAIN, DEPOSIT_TYPES, {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  }, payload.signature);
  if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
    return res.status(400).json({ error: "Invalid deposit signature" });
  }
  try {
    await screenDepositDepositor(payload.depositor, "shadow-address");
  } catch (e) {
    const out = complianceErrorResponse(e, "chainalysis_depositor_not_allowed");
    return res.status(out.status).json({
      ...out.body,
      action: "do_not_fund_shadow",
    });
  }
  const seed = getShadowSeed(payload);
  const shadowWallet = new ethers.Wallet(seed);
  const shadowAddress = shadowWallet.address;
  shadowDeposits.set(shadowAddress.toLowerCase(), {
    depositor: payload.depositor,
    token: payload.token,
    amount: payload.amount,
    commitment: payload.commitment,
    assetID: Number(payload.assetID),
    deadline: payload.deadline,
  });
  persistShadowDeposits();
  const out = { shadowAddress };
  if (payload.token === ethers.ZeroAddress) {
    try {
      out.feeWei = (await getDepositFeeBNBWei()).toString();
    } catch (_) {}
  }
  res.json(out);
});

app.post("/shadow-sweep", async (req, res) => {
  if (!SHIELDED_POOL_ADDRESS || !RELAYER_PRIVATE_KEY || !RPC_URL) {
    return res.status(500).json({ error: "Relayer env not configured" });
  }
  const { shadowAddress, commitment, deposit } = req.body || {};
  const normalizedCommitment = String(commitment || deposit?.commitment || "").toLowerCase();
  let entry;
  let entryAddress = shadowAddress;
  if (shadowAddress) {
    entry = shadowDeposits.get(String(shadowAddress).toLowerCase());
  } else if (commitment) {
    for (const [addr, data] of shadowDeposits.entries()) {
      if (String(data.commitment).toLowerCase() === String(commitment).toLowerCase()) {
        entry = data;
        entryAddress = addr;
        break;
      }
    }
  }
  // Serverless-safe fallback: reconstruct from signed deposit payload when in-memory map is missing.
  if (!entry && deposit && typeof deposit === "object") {
    const parsed = depositSchema.safeParse(deposit);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid shadow sweep deposit payload", details: parsed.error.flatten() });
    }
    const payload = parsed.data;
    const signerAddr = ethers.verifyTypedData(
      DEPOSIT_DOMAIN,
      DEPOSIT_TYPES,
      {
        depositor: payload.depositor,
        token: payload.token,
        amount: payload.amount,
        commitment: payload.commitment,
        assetID: Number(payload.assetID),
        deadline: payload.deadline,
      },
      payload.signature
    );
    if (signerAddr.toLowerCase() !== payload.depositor.toLowerCase()) {
      return res.status(400).json({ error: "Invalid shadow sweep deposit signature" });
    }
    if (normalizedCommitment && String(payload.commitment).toLowerCase() !== normalizedCommitment) {
      return res.status(400).json({ error: "Commitment mismatch for shadow sweep payload" });
    }
    const seed = getShadowSeed(payload);
    const derivedShadowAddress = new ethers.Wallet(seed).address;
    if (shadowAddress && derivedShadowAddress.toLowerCase() !== String(shadowAddress).toLowerCase()) {
      return res.status(400).json({ error: "shadowAddress does not match signed deposit payload" });
    }
    entryAddress = derivedShadowAddress;
    entry = {
      depositor: payload.depositor,
      token: payload.token,
      amount: payload.amount,
      commitment: payload.commitment,
      assetID: Number(payload.assetID),
      deadline: payload.deadline,
    };
  }
  if (!entry) {
    return res.status(404).json({ error: "Shadow deposit not found" });
  }
  if (entry.deadline < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: "Shadow deposit expired" });
  }
  try {
    const result = await sweepShadowDeposit(entryAddress, entry);
    if (result?.shadowSweepFailed || !result?.txHash) {
      return res.status(500).json({
        error: result?.shadowSweepError || "Shadow sweep failed",
        shadowAddress: entryAddress,
        signedDepositor: entry.depositor,
        poolDepositorOnChain: String(entryAddress).toLowerCase(),
        ...result,
      });
    }
    shadowDeposits.delete(String(entryAddress).toLowerCase());
    persistShadowDeposits();
    res.json({
      shadowAddress: entryAddress,
      signedDepositor: entry.depositor,
      poolDepositorOnChain: String(entryAddress).toLowerCase(),
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Shadow sweep failed" });
  }
});

app.post("/deposit", requireSeeForSensitiveFlow, async (req, res) => {
  if (rejectPlainSensitiveRoute(res, "/deposit/encrypted")) return;
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Deposit")) return;
  try {
    const txResult = await processDepositRequestBody(req.body);
    res.json(txResult);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    return res.status(400).json({ error: err.message || "Deposit failed" });
  }
});

app.post("/deposit/encrypted", requireSeeForSensitiveFlow, async (req, res) => {
  const requiredKeys = process.env.RELAYER_DRY_RUN === "true"
    ? ["SHIELDED_POOL_ADDRESS"]
    : ["RPC_URL", "SHIELDED_POOL_ADDRESS", "RELAYER_PRIVATE_KEY"];
  if (!requireConfigured(res, requiredKeys, "Deposit encrypted")) return;
  try {
    const envelope = req.body?.envelope;
    const decryptedBody = decryptRelayEnvelope(envelope);
    const txResult = await processDepositRequestBody(decryptedBody);
    res.json(txResult);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, details: err.details });
    return res.status(400).json({ error: err.message || "Encrypted deposit failed" });
  }
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

    if (!RPC_URL || !SHIELDED_POOL_ADDRESS) {
      return res.status(500).json({ error: "RPC_URL/SHIELDED_POOL_ADDRESS not configured" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const abi = [
      "function commitmentCount() view returns (uint256)",
      "function commitments(uint256) view returns (bytes32)",
      "function merkleRoot() view returns (bytes32)"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, provider);

    const onChainRoot = await contract.merkleRoot();

    const count = Number(await contract.commitmentCount());
    console.log(`[Merkle] Syncing ${count} commitments from contract...`);

    try {
      const clearStmt = db.prepare("DELETE FROM commitments");
      clearStmt.run();
      console.log(`[Merkle] Cleared old commitments from database`);
    } catch (e) {
      console.log(`[Merkle] Note: Could not clear old commitments (using in-memory only): ${e.message}`);
    }

    const syncedCommitments = [];
    for (let i = 0; i < count; i += 1) {
      const c = await contract.commitments(i);
      try {
        saveCommitment(db, i, c, null);
      } catch (e) {

      }
      syncedCommitments.push({ idx: i, commitment: c });
      if (i < 3 || (i < 10 && i % 2 === 0) || i === count - 1) {
        console.log(`[Merkle]   [${i}]: ${c}`);
      }
    }
    console.log(`[Merkle] ✅ Synced ${count} commitments from contract`);

    if (syncedCommitments.length !== count) {
      throw new Error(`Failed to sync all commitments: got ${syncedCommitments.length}, expected ${count}`);
    }

    const row = syncedCommitments.find(r => r.commitment === commitment)
      || syncedCommitments.find(r => r.commitment.toLowerCase() === commitment.toLowerCase());
    if (!row) {
      console.error(`[Merkle] ❌ Commitment not found: ${commitment}`);
      return res.status(404).json({
        error: "commitment not found after sync",
        syncedCount: syncedCommitments.length,
        searched: commitment,
        available: syncedCommitments.map(r => r.commitment)
      });
    }

    const commitments = syncedCommitments.sort((a, b) => Number(a.idx) - Number(b.idx)).map(r => r.commitment);
    console.log(`[Merkle] Building tree with ${commitments.length} commitments (contract has ${count}), looking for index ${row.idx}`);

    if (commitments[row.idx]?.toLowerCase() !== commitment.toLowerCase()) {
      console.error(`[Merkle] ❌ Commitment mismatch at index ${row.idx}`);
      console.error(`[Merkle]   Expected: ${commitment}`);
      console.error(`[Merkle]   Got: ${commitments[row.idx]}`);
      throw new Error(`Commitment mismatch at index ${row.idx}`);
    }

    const { path, indices, root } = buildMerklePath(commitments, row.idx);

    const mimc7Match = root.toLowerCase() === onChainRoot.toLowerCase();

    console.log(`[Merkle] Built tree (MiMC7): root=${root.substring(0, 20)}...`);
    console.log(`[Merkle] On-chain root:      ${onChainRoot.substring(0, 20)}...`);
    console.log(`[Merkle] MiMC7 root matches: ${mimc7Match ? "✅ YES" : "❌ NO"}`);

    if (!mimc7Match) {
      console.error(`[Merkle] ❌ CRITICAL: MiMC7 root does not match on-chain root`);
      console.error(`[Merkle]   MiMC7 root: ${root}`);
      console.error(`[Merkle]   On-chain:   ${onChainRoot}`);
      return res.status(500).json({
        error: "merkle root mismatch",
        mimc7Root: root,
        onChainRoot
      });
    }

    console.log(`[Merkle] ✅ Contract uses MiMC7 - perfect match!`);
    res.json({
      commitment,
      index: row.idx,
      merkleRoot: root,
      merklePath: path,
      merklePathIndices: indices
    });
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

const portfolioProofSchema = z.object({
  oldBalances: z.array(z.any()),
  newBalances: z.array(z.any()),
  oldBlindingFactor: z.any(),
  newBlindingFactor: z.any(),
  ownerPublicKey: z.any(),
  oldNonce: z.any(),
  newNonce: z.any(),
  oldCommitment: z.any(),
  newCommitment: z.any(),
  inputAssetID: z.any(),
  outputAssetID: z.any(),
  swapAmount: z.any(),
  outputAmount: z.any(),
  minOutputAmount: z.any(),
  protocolFee: z.any(),
  gasRefund: z.any()
}).passthrough();

app.post("/portfolio/prove", async (req, res) => {
  const parsed = portfolioProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    const result = await generatePortfolioProof(parsed.data);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "portfolio prove failed" });
  }
});

const generateProofBodySchema = z.object({

  inputNote: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    ownerPublicKey: z.string(),
    nullifier: z.string(),
    commitment: z.string(),
  }).optional(),
  outputNoteSwap: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    commitment: z.string(),
  }).optional(),
  outputNoteChange: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    commitment: z.string(),
  }).optional(),
  merkleRoot: z.string().optional(),
  merklePath: z.array(z.string()).optional(),
  merklePathIndices: z.array(z.union([z.string(), z.number()])).optional(),
  swapAmount: z.string().optional(),
  minOutputAmount: z.string().optional(),
  protocolFee: z.string().optional(),
  gasRefund: z.string().optional(),

  inputAssetId: z.union([z.string(), z.number()]).optional(),
  inputAmount: z.string().optional(),
  inputBlinding: z.string().optional(),
  inputOwnerKey: z.string().optional(),
  nullifier: z.string().optional(),
  inputCommitment: z.string().optional(),
  outputAssetIdSwap: z.union([z.string(), z.number()]).optional(),
  outputAmountSwap: z.string().optional(),
  swapBlindingFactor: z.string().optional(),
  outputCommitmentSwap: z.string().optional(),
  outputAssetIdChange: z.union([z.string(), z.number()]).optional(),
  outputAmountChange: z.string().optional(),
  changeBlindingFactor: z.string().optional(),
  outputCommitmentChange: z.string().optional(),
  minOutputAmountSwap: z.string().optional(),
}).passthrough();

app.post("/swap/generate-proof", async (req, res) => {
  const parsed = generateProofBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const hasNested = body.inputNote && body.outputNoteSwap && body.outputNoteChange;
  const hasFlattened = body.inputAmount != null && body.inputBlinding != null && body.inputOwnerKey != null
    && body.nullifier != null && body.inputCommitment != null
    && body.outputAmountSwap != null && body.swapBlindingFactor != null && body.outputCommitmentSwap != null
    && body.outputAmountChange != null && body.changeBlindingFactor != null && body.outputCommitmentChange != null
    && body.merkleRoot != null && body.swapAmount != null;
  if (!hasNested && !hasFlattened) {
    return res.status(400).json({ error: "Invalid request", message: "Provide either (inputNote, outputNoteSwap, outputNoteChange) or flattened circuit inputs." });
  }
  let swapData;
  if (hasNested) {
    swapData = {
      inputNote: body.inputNote,
      outputNoteSwap: body.outputNoteSwap,
      outputNoteChange: body.outputNoteChange,
      merkleRoot: body.merkleRoot,
      merklePath: body.merklePath || [],
      merklePathIndices: body.merklePathIndices || [],
      swapAmount: body.swapAmount,
      minOutputAmount: body.minOutputAmount,
      protocolFee: body.protocolFee || "0",
      gasRefund: body.gasRefund || "0",
    };
  } else {
    swapData = {
      inputNote: {
        assetID: body.inputAssetId,
        amount: body.inputAmount,
        blindingFactor: body.inputBlinding,
        ownerPublicKey: body.inputOwnerKey,
        nullifier: body.nullifier,
        commitment: body.inputCommitment,
      },
      outputNoteSwap: {
        assetID: body.outputAssetIdSwap,
        amount: body.outputAmountSwap,
        blindingFactor: body.swapBlindingFactor,
        commitment: body.outputCommitmentSwap,
      },
      outputNoteChange: {
        assetID: body.outputAssetIdChange,
        amount: body.outputAmountChange,
        blindingFactor: body.changeBlindingFactor,
        commitment: body.outputCommitmentChange,
      },
      merkleRoot: body.merkleRoot,
      merklePath: body.merklePath || [],
      merklePathIndices: body.merklePathIndices || [],
      swapAmount: body.swapAmount,
      minOutputAmount: body.minOutputAmount || body.minOutputAmountSwap,
      protocolFee: body.protocolFee || "0",
      gasRefund: body.gasRefund || "0",
    };
  }
  try {
    const result = await generateSwapProof(swapData);
    res.json({
      proof: result.proof,
      publicSignals: result.publicSignals,
      publicInputs: result.publicInputs,
      generationTime: result.generationTime
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Proof generation failed", message: err.message });
    }
  }
});

const withdrawGenerateProofSchema = z.object({
  inputNote: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    ownerPublicKey: z.string(),
    nullifier: z.string(),
    commitment: z.string(),
  }),
  outputNoteChange: z.object({
    assetID: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    blindingFactor: z.string(),
    commitment: z.string().optional(),
  }),
  merkleRoot: z.string(),
  merklePath: z.array(z.union([z.string(), z.number()])),
  merklePathIndices: z.array(z.union([z.string(), z.number()])),
  protocolFee: z.string(),
  gasRefund: z.string(),
  withdrawAmount: z.string().optional(),
}).passthrough();

app.post("/withdraw/generate-proof", async (req, res) => {
  const parsed = withdrawGenerateProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    const result = await generateWithdrawProof(parsed.data);
    return res.json({
      proof: result.proof,
      publicSignals: result.publicSignals,
      publicInputs: result.publicInputs,
      generationTime: result.generationTime,
    });
  } catch (err) {
    return res.status(500).json({ error: "Withdraw proof generation failed", message: err.message });
  }
});

app.use("/", enterpriseRouter);

const dashboardDist = path.join(__dirname, "..", "..", "dist");
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
} else {
  app.use((req, res) => {
    res.status(404).json({ error: "Not Found", path: req.path });
  });
}

function startServer(tryPort) {
  const server = app.listen(tryPort, "0.0.0.0", () => {
    console.log(`Relayer API running on 0.0.0.0:${tryPort}`);
    console.log(`ShieldedPool: ${process.env.SHIELDED_POOL_ADDRESS || "(not set)"}`);
    const cfg = getRuntimeConfig();
    const w = cfg.configWarnings || [];
    if (w.length) {
      console.warn("[config] Canonical profile vs runtime:");
      for (const line of w) console.warn(`  - ${line}`);
    }
  });
  // Groth16 prove can exceed Node's default HTTP server timeouts (client sees "socket hang up").
  const proveMs = Number(process.env.HTTP_SERVER_PROVE_TIMEOUT_MS || 900000);
  server.requestTimeout = proveMs;
  server.headersTimeout = proveMs + 60000;
  server.on("error", (err) => {
    const portNum = Number(tryPort);
    if (err.code === "EADDRINUSE" && portNum < Number(PORT) + 10) {
      console.warn(`Port ${tryPort} in use, trying ${portNum + 1}...`);
      startServer(portNum + 1);
    } else if (err.code === "EADDRINUSE") {
      console.error(`Port in use. Free it: netstat -ano | findstr ":5050" then taskkill /PID <pid> /F (run PowerShell as Administrator if needed)`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}

if (!process.env.VERCEL && !process.env.FIREBASE_FUNCTIONS) {
  (async () => {
    try {
      await assertNoMockRuntimeGate();
      await assertRequiredBscAssetsOnChain();
    } catch (e) {
      console.error("[FATAL] startup gate:", e.message || e);
      process.exit(1);
    }
    startServer(PORT);
  })();
}

module.exports = { app, processSwapRequestBody, evaluateInternalMatchingGuardrails };

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

const encodeGroth16Proof = (proof) => {
  const coder = ethers.AbiCoder?.defaultAbiCoder
    ? ethers.AbiCoder.defaultAbiCoder()
    : ethers.utils.defaultAbiCoder;
  const a = [
    String(proof?.a?.[0] ?? 0),
    String(proof?.a?.[1] ?? 0)
  ];

  let b;
  if (Array.isArray(proof?.b?.[0]) && Array.isArray(proof?.b?.[1])) {
    b = [
      [String(proof.b[0][0] ?? 0), String(proof.b[0][1] ?? 0)],
      [String(proof.b[1][0] ?? 0), String(proof.b[1][1] ?? 0)]
    ];
  } else if (Array.isArray(proof?.b) && proof.b.length >= 4) {
    const flat = proof.b;
    b = [
      [String(flat[0] ?? 0), String(flat[1] ?? 0)],
      [String(flat[2] ?? 0), String(flat[3] ?? 0)]
    ];
  } else {
    b = [
      [String(proof?.b?.[0]?.[0] ?? 0), String(proof?.b?.[0]?.[1] ?? 0)],
      [String(proof?.b?.[1]?.[0] ?? 0), String(proof?.b?.[1]?.[1] ?? 0)]
    ];
  }
  const c = [
    String(proof?.c?.[0] ?? 0),
    String(proof?.c?.[1] ?? 0)
  ];
  return {
    a: coder.encode(["uint256[2]"], [a]),
    b: coder.encode(["uint256[2][2]"], [b]),
    c: coder.encode(["uint256[2]"], [c])
  };
};

const RELAYER_REQUIRE_LOCAL_SNARK_VERIFY = process.env.RELAYER_REQUIRE_LOCAL_SNARK_VERIFY !== "false";
let localVerificationKeyCache = null;
function normalizeGroth16ProofForSnarkjs(proof) {
  const a = proof?.a || proof?.pi_a;
  const b = proof?.b || proof?.pi_b;
  const c = proof?.c || proof?.pi_c;
  if (!a || !b || !c) return null;
  return {
    pi_a: Array.isArray(a) ? [String(a[0]), String(a[1])] : a,
    pi_b: Array.isArray(b)
      ? [
          [String(b[0][1]), String(b[0][0])],
          [String(b[1][1]), String(b[1][0])],
        ]
      : b,
    pi_c: Array.isArray(c) ? [String(c[0]), String(c[1])] : c,
    protocol: "groth16",
    curve: "bn128",
  };
}
function getLocalVerificationKey() {
  if (localVerificationKeyCache) return localVerificationKeyCache;
  const vkPath = path.join(__dirname, "..", "..", "circuits", "verification_key.json");
  if (!fs.existsSync(vkPath)) {
    throw new Error("verification_key.json not found for local relayer SNARK verification");
  }
  localVerificationKeyCache = JSON.parse(fs.readFileSync(vkPath, "utf8"));
  return localVerificationKeyCache;
}
async function assertRelayerLocalSnarkVerify(proof, publicSignals, label) {
  if (!RELAYER_REQUIRE_LOCAL_SNARK_VERIFY) return;
  const vk = getLocalVerificationKey();
  const p = normalizeGroth16ProofForSnarkjs(proof);
  if (!p) throw new Error(`${label}: invalid_proof_shape_for_local_verify`);
  const ok = await snarkjs.groth16.verify(vk, publicSignals.map((x) => String(x)), p);
  if (!ok) throw new Error(`${label}: local_snark_verification_failed`);
}

const getThresholdVerifier = async (signer) => {
  const poolAbi = ["function thresholdVerifier() view returns (address)"];
  const pool = new ethers.Contract(SHIELDED_POOL_ADDRESS, poolAbi, signer);
  return await pool.thresholdVerifier();
};

const submitThresholdValidations = async (signer, proof, publicSignals, signatures, label) => {
  const thresholdVerifierAddress = await getThresholdVerifier(signer);
  if (!thresholdVerifierAddress || thresholdVerifierAddress === ethers.ZeroAddress) {
    console.warn(`⚠️ Threshold verifier not set on pool (${label})`);
    return;
  }
  const usableSignatures = (signatures || []).filter((s) => s && s.timestamp != null);
  if (usableSignatures.length === 0) {
    console.warn(`⚠️ No usable validator signatures (${label})`);
    return;
  }
  const tvAbi = [
    "function submitValidations((bytes,bytes,bytes) proof, uint256[] publicInputs, (address validator, uint256 votingPower, bytes signature, uint256 timestamp)[] signatures, bool isValid)"
  ];
  const tv = new ethers.Contract(thresholdVerifierAddress, tvAbi, signer);
  const proofForTV = encodeGroth16Proof(proof);
  const proofTuple = [proofForTV.a, proofForTV.b, proofForTV.c];
  const pubInputs = publicSignals.map((x) => toBigInt(x));
  const formattedSignatures = usableSignatures.map((s) => ([
    s.validator,
    s.votingPower,
    s.signature,
    s.timestamp
  ]));
  const tx = await tv.submitValidations(proofTuple, pubInputs, formattedSignatures, true);
  await tx.wait();
  console.log(`✅ Submitted threshold validations (${label})`);
};

const submitSelfThresholdValidation = async (signer, proof, publicSignals, label) => {
  const thresholdVerifierAddress = await getThresholdVerifier(signer);
  if (!thresholdVerifierAddress || thresholdVerifierAddress === ethers.ZeroAddress) {
    console.warn(`⚠️ Threshold verifier not set on pool (${label})`);
    return;
  }
  const tvAbi = [
    "function submitValidations((bytes,bytes,bytes) proof, uint256[] publicInputs, (address validator, uint256 votingPower, bytes signature, uint256 timestamp)[] signatures, bool isValid)",
    "function stakingContract() view returns (address)"
  ];
  const tv = new ethers.Contract(thresholdVerifierAddress, tvAbi, signer);
  let stakingAddress;
  try {
    stakingAddress = await tv.stakingContract();
  } catch (e) {

    console.warn(`⚠️ Threshold verifier has no stakingContract (direct verifier mode) - skipping validation submission`);
    return;
  }
  let votingPower = 0n;
  if (stakingAddress && stakingAddress !== ethers.ZeroAddress) {
    const stakingAbi = ["function stakedBalance(address) view returns (uint256)"];
    const staking = new ethers.Contract(stakingAddress, stakingAbi, signer);
    votingPower = await staking.stakedBalance(signer.address);
  }
  if (votingPower === 0n) {
    console.warn(`⚠️ Relayer has no voting power (${label})`);
    return;
  }

  const proofForTV = encodeGroth16Proof(proof);
  const pubInputs = publicSignals.map((x) => toBigInt(x));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const proofHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "bytes", "bytes", "uint256[]"],
      [proofForTV.a, proofForTV.b, proofForTV.c, pubInputs]
    )
  );
  const messageHash = ethers.solidityPackedKeccak256(
    ["bytes32", "bool", "uint256"],
    [proofHash, true, timestamp]
  );
  const sig = await signer.signMessage(ethers.getBytes(messageHash));
  const flatSig = ethers.Signature.from(sig);
  const vByte = (flatSig.v >= 27 ? flatSig.v : flatSig.v + 27);
  const sigBytes = ethers.concat([flatSig.r, flatSig.s, ethers.toBeHex(vByte, 1)]);
  const validatorSig = {
    validator: signer.address,
    votingPower,
    signature: sigBytes,
    timestamp
  };
  await submitThresholdValidations(signer, proof, publicSignals, [validatorSig], label);
};

/**
 * Match swapParams to ShieldedPool + PancakeSwapAdaptor semantics:
 * - Pool assetID 0 is native BNB; the pool forwards swapAmount as msg.value. Adaptor must see tokenIn == 0x0
 *   to use swapExactETHForTokens (not ERC20 transferFrom from the pool).
 * - Likewise tokenOut == 0x0 selects the native-BNB-out branch.
 * - Adaptor decodes `path` as abi.encode(address[]). V3-style compact paths from Quoter must be cleared so
 *   _getPath() builds the default [WBNB, token] hop list for the pinned V2 router.
 */
function normalizeJoinSplitSwapParamsForChain(swapData) {
  if (!swapData?.publicInputs) return;
  swapData.swapParams = buildCommittedSwapParams(swapData);
}

async function precheckSwapOutDeterminism(swapData) {
  if (!RPC_URL || !SWAP_ADAPTOR_ADDRESS) return;
  const pi = swapData?.publicInputs || {};
  const sp = swapData?.swapParams || {};
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const adaptorAbi = [
    "function getExpectedOutput((address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint24 fee,uint160 sqrtPriceLimitX96,bytes path)) view returns (uint256)"
  ];
  const adaptor = new ethers.Contract(SWAP_ADAPTOR_ADDRESS, adaptorAbi, provider);
  const expectedOut = toBigInt(
    await adaptor.getExpectedOutput({
      tokenIn: toAddress(sp.tokenIn),
      tokenOut: toAddress(sp.tokenOut),
      amountIn: toBigInt(sp.amountIn || 0),
      minAmountOut: 0,
      fee: Number(sp.fee || 0),
      sqrtPriceLimitX96: toBigInt(sp.sqrtPriceLimitX96 || 0),
      path: sp.path || "0x",
    })
  );
  const proofOut = toBigInt(pi.outputAmountSwap || 0);
  const minOut = toBigInt(pi.minOutputAmountSwap || 0);
  if (expectedOut !== proofOut) {
    const err = new Error("Swap output mismatch before submit (proof output != adaptor output)");
    err.code = "SP_OUT_PRECHECK_MISMATCH";
    err.status = 409;
    err.details = {
      reason: "SP_OUT_PRECHECK_MISMATCH",
      adaptorOutput: expectedOut.toString(),
      proofOutputAmountSwap: proofOut.toString(),
      proofMinOutputAmountSwap: minOut.toString(),
      note: "Regenerate quote+proof from the same swap adaptor quote immediately before submit."
    };
    throw err;
  }
  if (expectedOut < minOut) {
    const err = new Error("Swap output below minimum before submit (adaptor output < min output)");
    err.code = "SP_OUT_PRECHECK_BELOW_MIN";
    err.status = 409;
    err.details = {
      reason: "SP_OUT_PRECHECK_BELOW_MIN",
      adaptorOutput: expectedOut.toString(),
      proofMinOutputAmountSwap: minOut.toString(),
      note: "Refresh quote and lower minOutput/slippage, then regenerate proof."
    };
    throw err;
  }
}

async function precheckSwapNullifierUnused(swapData) {
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) return;
  const pi = swapData?.publicInputs || {};
  const nullifier = pi?.nullifier;
  if (!nullifier) return;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pool = new ethers.Contract(
    SHIELDED_POOL_ADDRESS,
    ["function isNullifierUsed(bytes32 nullifier) view returns (bool used)"],
    provider
  );
  const nullifierBytes32 = (() => {
    const s = String(nullifier);
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
    return ethers.zeroPadValue(ethers.toBeHex(toBigInt(s)), 32);
  })();
  let used = false;
  try {
    used = Boolean(await pool.isNullifierUsed(nullifierBytes32));
  } catch {
    // Fallback for reduced/legacy pools where helper may be absent.
    used = false;
  }
  if (used) {
    const err = new Error("Swap note already spent on-chain (nullifier already used). Unlock notes and use a fresh note.");
    err.code = "SWAP_NULLIFIER_ALREADY_USED";
    err.status = 409;
    err.details = {
      reason: "SWAP_NULLIFIER_ALREADY_USED",
      nullifier: String(nullifier),
      note: "This note was already consumed by a confirmed transaction or another pending swap."
    };
    throw err;
  }
}

async function submitSwap(swapData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }

  normalizeJoinSplitSwapParamsForChain(swapData);
  await precheckSwapNullifierUnused(swapData);
  await precheckSwapOutDeterminism(swapData);

  console.log("\n🔐 Phase 2: Collecting validator signatures...");

  const pi = swapData.publicInputs || {};
  const publicSignals = buildJoinSplitPublicSignals(pi);
  await assertRelayerLocalSnarkVerify(swapData.proof, publicSignals, "swap");

  const skipValidatorQuorum =
    DEV_BYPASS_VALIDATORS ||
    (!RELAYER_REQUIRE_VALIDATOR_QUORUM && VALIDATOR_URLS.length === 0);
  if (skipValidatorQuorum && !DEV_BYPASS_VALIDATORS && VALIDATOR_URLS.length === 0) {
    console.warn("[swap] No VALIDATOR_URLS and RELAYER_REQUIRE_VALIDATOR_QUORUM is not set — skipping validator quorum (single-relayer / dev mode).");
  }
  let validationResult;
  try {
    validationResult = skipValidatorQuorum
      ? { valid: true, signatures: [], reason: DEV_BYPASS_VALIDATORS ? "DEV_BYPASS_VALIDATORS" : "validator_quorum_skipped" }
      : await validatorNetwork.verifyProof(swapData.proof, publicSignals, computeSwapPublicInputHash(pi));
  } catch (e) {
    logProofFailure("validator.verifyProof.swap", e);
    throw e;
  }

  if (!validationResult.valid) {
    logProofFailure("validator.verifyProof.swap", new Error(validationResult.reason || "Threshold not met"));
    throw new Error(`Validator consensus failed: ${validationResult.reason || 'Threshold not met'}`);
  }

  console.log(`✅ Validator consensus achieved (${validationResult.signatures.length} signatures)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function commitSwap(bytes32 commitmentHash, uint256 deadline) external",
    "function shieldedSwapJoinSplit(((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),(address,address,uint256,uint256,uint24,uint160,bytes),address,bytes,bytes32,uint256,uint256,bytes,uint256,uint256)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  console.log("📤 Submitting transaction to ShieldedPool...");
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");

  const { merklePath, merklePathIndices } = normalizeJoinSplitPublicInputs(pi, "swap");
  console.log(`📏 Swap public inputs count: ${15 + merklePath.length + merklePathIndices.length}`);
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(swapData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.nullifier),
    toBytes32(pi.inputCommitment),
    toBytes32(pi.outputCommitmentSwap),
    toBytes32(pi.outputCommitmentChange),
    toBytes32(pi.merkleRoot),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetIDSwap),
    toU256(pi.outputAssetIDChange),
    toU256(pi.inputAmount),
    toU256(pi.swapAmount),
    toU256(pi.changeAmount),
    toU256(pi.outputAmountSwap),
    toU256(pi.minOutputAmountSwap),
    toU256(pi.gasRefund),
    toU256(pi.protocolFee),
    merklePath.map((x) => toU256(x)),
    merklePathIndices.map((x) => toU256(x))
  ];
  const swapParamsTuple = [
    toAddress(swapData.swapParams?.tokenIn),
    toAddress(swapData.swapParams?.tokenOut),
    toU256(swapData.swapParams?.amountIn),
    toU256(swapData.swapParams?.minAmountOut),
    Number(swapData.swapParams?.fee || 0),
    toU256(swapData.swapParams?.sqrtPriceLimitX96 || 0),
    swapData.swapParams?.path || "0x"
  ];
  const relayerAddr = (swapData.relayer && swapData.relayer !== ethers.ZeroAddress) ? swapData.relayer : signer.address;
  const attestationDeadline = Number(
    swapData.relayerAttestationDeadline ||
    swapData.deadline ||
    (Math.floor(Date.now() / 1000) + 900)
  );
  const attestationNonce = toU256(
    swapData.relayerAttestationNonce ||
    `${Date.now()}${Math.floor(Math.random() * 1000000)}`
  );
  const proofHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes", "bytes"], proofTuple)
  );
  const swapPublicInputHash = computeSwapPublicInputHash(pi);
  const attestationChainId = Number(CHAIN_ID || 97);
  const attestationDomain = {
    name: "PhantomRelayerAttestation",
    version: "1",
    chainId: attestationChainId,
    verifyingContract: SHIELDED_POOL_ADDRESS,
  };
  const attestationTypes = {
    RelayerSwapAttestation: [
      { name: "proofHash", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "inputAssetID", type: "uint256" },
      { name: "outputAssetIDSwap", type: "uint256" },
      { name: "swapAmount", type: "uint256" },
      { name: "minOutputAmountSwap", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "pool", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const attestationTypesHashFirst = {
    RelayerSwapAttestationHashFirst: [
      { name: "proofHash", type: "bytes32" },
      { name: "publicInputHash", type: "bytes32" },
      { name: "relayer", type: "address" },
      { name: "pool", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const buildLegacyAttestationValue = () => ({
    proofHash,
    nullifier: toBytes32(pi.nullifier),
    inputAssetID: toU256(pi.inputAssetID),
    outputAssetIDSwap: toU256(pi.outputAssetIDSwap),
    swapAmount: toU256(pi.swapAmount),
    minOutputAmountSwap: toU256(pi.minOutputAmountSwap),
    relayer: relayerAddr,
    pool: SHIELDED_POOL_ADDRESS,
    chainId: BigInt(attestationChainId),
    deadline: BigInt(attestationDeadline),
    nonce: attestationNonce,
  });
  const buildHashFirstAttestationValue = () => ({
    proofHash,
    publicInputHash: swapPublicInputHash,
    relayer: relayerAddr,
    pool: SHIELDED_POOL_ADDRESS,
    chainId: BigInt(attestationChainId),
    deadline: BigInt(attestationDeadline),
    nonce: attestationNonce,
  });
  async function signRelayerAttestation(mode) {
    if (mode === "hash_first") {
      return signer.signTypedData(attestationDomain, attestationTypesHashFirst, buildHashFirstAttestationValue());
    }
    return signer.signTypedData(attestationDomain, attestationTypes, buildLegacyAttestationValue());
  }
  const preferHashFirst =
    RELAYER_SWAP_ATTESTATION_MODE === "hash_first" ||
    RELAYER_SWAP_ATTESTATION_MODE === "hash_first_with_fallback";
  const allowLegacyFallback = RELAYER_SWAP_ATTESTATION_MODE === "hash_first_with_fallback";
  let relayerAttestationModeUsed = preferHashFirst ? "hash_first" : "legacy";
  let relayerAttestationSig = await signRelayerAttestation(relayerAttestationModeUsed);
  const buildSwapDataForContract = (attestationSig) => [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    relayerAddr,
    swapData.encryptedPayload || "0x",
    (swapData.commitment && swapData.commitment !== ethers.ZeroHash) ? swapData.commitment : ethers.ZeroHash,
    Number(swapData.deadline || 0),
    toU256(swapData.nonce || 0),
    attestationSig,
    BigInt(attestationDeadline),
    attestationNonce
  ];
  let swapDataForContract = buildSwapDataForContract(relayerAttestationSig);

  if (DEV_BYPASS_VALIDATORS) {
    await submitSelfThresholdValidation(signer, swapData.proof, publicSignals, "swap bypass");
  } else if (validationResult.signatures.length > 0) {
    await submitThresholdValidations(signer, swapData.proof, publicSignals, validationResult.signatures, "swap");
  }

  let tx;
  try {
    if (swapDataForContract[5] !== ethers.ZeroHash) {
      try {
        await (await contract.commitSwap(swapDataForContract[5], swapDataForContract[6])).wait();
      } catch (commitErr) {
        const raw = `${commitErr?.message || ""} ${commitErr?.shortMessage || ""}`.toLowerCase();
        // Reduced pool deployments do not implement commitSwap; continue without pre-commit in that case.
        if (/no data present|unsupported|is not a function|call_exception/.test(raw)) {
          console.warn("[swap] commitSwap unavailable on this pool; continuing without commitSwap pre-step");
        } else {
          throw commitErr;
        }
      }
    }
    try {
      await contract.shieldedSwapJoinSplit.staticCall(swapDataForContract);
    } catch (simErr) {
      const simRaw = `${simErr?.reason || ""} ${simErr?.message || ""} ${simErr?.shortMessage || ""}`.toLowerCase();
      const looksLikeAttestationFailure =
        simRaw.includes("poolerr(48)") ||
        simRaw.includes("poolerr(49)") ||
        simRaw.includes("invalid relayer") ||
        simRaw.includes("attestation");
      if (relayerAttestationModeUsed === "hash_first" && allowLegacyFallback && looksLikeAttestationFailure) {
        console.warn("[swap] hash-first relayer attestation not accepted by pool; retrying with legacy attestation mode");
        relayerAttestationModeUsed = "legacy";
        relayerAttestationSig = await signRelayerAttestation("legacy");
        swapDataForContract = buildSwapDataForContract(relayerAttestationSig);
        await contract.shieldedSwapJoinSplit.staticCall(swapDataForContract);
      } else {
        logRelayerOnchainFailure("shieldedSwapJoinSplit.staticCall", simErr);
        const err = new Error(`swap_simulation_failed: ${simErr?.reason || simErr?.message || String(simErr)}`);
        err.status = 400;
        throw err;
      }
    }
    tx = await contract.shieldedSwapJoinSplit(swapDataForContract);
  } catch (e) {
    logRelayerOnchainFailure("shieldedSwapJoinSplit", e);
    throw e;
  }

  console.log("⏳ Waiting for confirmation...");
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e) {
    logRelayerOnchainFailure("shieldedSwapJoinSplit:wait", e);
    throw e;
  }

  console.log(`✅ Transaction confirmed: ${receipt.hash}`);
  try {
    pushTransaction({ op: "shieldedSwap", txHash: receipt.hash, blockNumber: receipt.blockNumber });
  } catch (_) {
    /* ignore activity buffer */
  }
  try {
    storeCommitmentsFromReceipt(receipt);
  } catch (e) {
    console.log(`[Swap] Could not store commitments: ${e.message}`);
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    validatorSignatures: validationResult.signatures.length,
    relayer: relayerAddr,
    relayerAttestationMode: relayerAttestationModeUsed
  };
}

async function submitWithdraw(withdrawData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }

  console.log("\n🔐 Phase 2: Collecting validator signatures for withdrawal...");

  const pi = withdrawData.publicInputs || {};
  const publicSignals = buildJoinSplitPublicSignals(pi);
  await assertRelayerLocalSnarkVerify(withdrawData.proof, publicSignals, "withdraw");

  const skipValidatorQuorumWd =
    DEV_BYPASS_VALIDATORS ||
    (!RELAYER_REQUIRE_VALIDATOR_QUORUM && VALIDATOR_URLS.length === 0);
  let validationResultWd;
  try {
    validationResultWd = skipValidatorQuorumWd
      ? { valid: true, signatures: [], reason: DEV_BYPASS_VALIDATORS ? "DEV_BYPASS_VALIDATORS" : "validator_quorum_skipped" }
      : await validatorNetwork.verifyProof(withdrawData.proof, publicSignals, null);
  } catch (e) {
    logProofFailure("validator.verifyProof.withdraw", e);
    throw e;
  }

  if (!validationResultWd.valid) {
    logProofFailure("validator.verifyProof.withdraw", new Error(validationResultWd.reason || "Threshold not met"));
    throw new Error(`Validator consensus failed: ${validationResultWd.reason || 'Threshold not met'}`);
  }

  console.log(`✅ Validator consensus achieved (${validationResultWd.signatures.length} signatures)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  let { merklePath, merklePathIndices } = normalizeJoinSplitPublicInputs(pi, "withdraw");
  let merkleRoot = pi.merkleRoot;
  console.log(`📏 Withdraw public inputs count: ${15 + merklePath.length + merklePathIndices.length}`);

  const computedRoot = computeMerkleRootFromPath(pi.inputCommitment, merklePath, merklePathIndices);
  const expectedRoot = toBigInt(merkleRoot);
  if (computedRoot !== expectedRoot) {
    console.warn("⚠️ Merkle proof mismatch for withdrawal inputs. Refreshing from chain...");
    const refreshed = await fetchMerkleProofFromChain(pi.inputCommitment);
    merklePath = normalizeMerklePath(refreshed.merklePath);
    merklePathIndices = normalizeMerkleIndices(refreshed.merklePathIndices);
    merkleRoot = refreshed.merkleRoot;
  }

  if (DEV_BYPASS_VALIDATORS) {
    await submitSelfThresholdValidation(signer, withdrawData.proof, publicSignals, "withdraw bypass");
  } else if (validationResultWd.signatures.length > 0) {
    await submitThresholdValidations(signer, withdrawData.proof, publicSignals, validationResultWd.signatures, "withdraw");
  }

  const abi = [
    "function shieldedWithdraw(((bytes,bytes,bytes),(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256[10],uint256[10]),address,address,bytes)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  console.log("📤 Submitting withdrawal to ShieldedPool...");
  const withdrawProofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(withdrawData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const withdrawPublicInputsTuple = [
    toBytes32(pi.nullifier),
    toBytes32(pi.inputCommitment),
    toBytes32(pi.outputCommitmentSwap),
    toBytes32(pi.outputCommitmentChange),
    toBytes32(merkleRoot),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetIDSwap),
    toU256(pi.outputAssetIDChange),
    toU256(pi.inputAmount),
    toU256(pi.swapAmount),
    toU256(pi.changeAmount),
    toU256(pi.outputAmountSwap),
    toU256(pi.minOutputAmountSwap),
    toU256(pi.gasRefund),
    toU256(pi.protocolFee),
    merklePath.map((x) => toU256(x)),
    merklePathIndices.map((x) => toU256(x))
  ];
  const recipient = ethers.getAddress(withdrawData.recipient);
  const relayerAddr = (withdrawData.relayer && withdrawData.relayer !== ethers.ZeroAddress) ? withdrawData.relayer : signer.address;
  const withdrawDataForContract = [
    withdrawProofTuple,
    withdrawPublicInputsTuple,
    recipient,
    relayerAddr,
    withdrawData.encryptedPayload || "0x"
  ];
  let receipt;
  try {
    await contract.shieldedWithdraw.staticCall(withdrawDataForContract);
  } catch (simErr) {
    logRelayerOnchainFailure("shieldedWithdraw.staticCall", simErr);
    const err = new Error(`withdraw_simulation_failed: ${simErr?.reason || simErr?.message || String(simErr)}`);
    err.status = 400;
    throw err;
  }
  try {
    const tx = await contract.shieldedWithdraw(withdrawDataForContract);
    console.log("⏳ Waiting for confirmation...");
    receipt = await tx.wait();
  } catch (e) {
    logRelayerOnchainFailure("shieldedWithdraw", e);
    const raw = `${e?.message || ""} ${e?.shortMessage || ""} ${e?.reason || ""}`.toLowerCase();
    if (/nullifier|poolerr\(4\)|already|used/.test(raw)) {
      const err = new Error("withdraw_nullifier_already_spent");
      err.status = 400;
      throw err;
    }
    if (/poolerr\(6\)|verify|invalid proof|groth16/.test(raw)) {
      const err = new Error("withdraw_proof_rejected");
      err.status = 400;
      throw err;
    }
    if (/poolerr\(5\)|fee\s*mismatch|withdrawhandler:\s*fee\s*mismatch|protocol\s*fee\s*insufficient/i.test(raw)) {
      const err = new Error("withdraw_protocol_fee_insufficient_for_on_chain_policy");
      err.status = 400;
      throw err;
    }
    if (/poolerr\(43\)|conservation|poolerr\(19\)|change/.test(raw)) {
      const err = new Error("withdraw_amount_conservation_or_change_invalid");
      err.status = 400;
      throw err;
    }
    throw e;
  }

  console.log(`✅ Withdrawal confirmed: ${receipt.hash}`);
  let shadowForward = null;
  if (withdrawData._shadowPayoutTo) {
    try {
      const wSeed = getWithdrawShadowSeed({ finalRecipient: withdrawData._shadowPayoutTo, nullifier: pi.nullifier });
      const shadowSigner = new ethers.Wallet(wSeed, provider);
      if (String(shadowSigner.address).toLowerCase() !== String(recipient).toLowerCase()) {
        console.warn("[withdraw] shadow address mismatch vs contract recipient; skip forward");
        shadowForward = {
          shadowForwardSkippedMismatch: true,
          shadowSignerDerived: shadowSigner.address,
          withdrawRecipient: recipient,
        };
      } else {
        const poolAsset = new ethers.Contract(
          SHIELDED_POOL_ADDRESS,
          ["function assetRegistry(uint256) view returns (address)"],
          provider
        );
        const inputAssetIdBn = toBigInt(pi.inputAssetID ?? 0);
        const inputTokenAddr = inputAssetIdBn === 0n ? ethers.ZeroAddress : await poolAsset.assetRegistry(inputAssetIdBn);
        const isNativePayout =
          !inputTokenAddr || String(inputTokenAddr).toLowerCase() === ethers.ZeroAddress.toLowerCase();

        if (isNativePayout) {
          const topUp = await topUpWithdrawShadowIfNeeded({
            payerSigner: signer,
            shadowSigner,
            requiredWei: pi.swapAmount ?? "0",
          });
          shadowForward = await forwardWithdrawPayoutFromShadow(shadowSigner, withdrawData._shadowPayoutTo);
          shadowForward = { ...topUp, ...shadowForward };
        } else {
          const minGasWei = BigInt(
            process.env.SHADOW_ERC20_FORWARD_MIN_NATIVE_WEI || "5000000000000000"
          );
          const topGas = await topUpWithdrawShadowNativeGasIfNeeded({
            payerSigner: signer,
            shadowSigner,
            minBalanceWei: minGasWei,
          });
          shadowForward = await forwardWithdrawTokenFromShadow(
            shadowSigner,
            inputTokenAddr,
            withdrawData._shadowPayoutTo
          );
          shadowForward = { ...topGas, ...shadowForward };
        }
      }
    } catch (e) {
      shadowForward = { shadowForwardError: e?.message || String(e) };
      console.error("[withdraw] shadow forward failed", e);
    }
  }
  try {
    pushTransaction({ op: "shieldedWithdraw", txHash: receipt.hash, blockNumber: receipt.blockNumber });
  } catch (_) {
    /* ignore activity buffer */
  }
  try {
    storeCommitmentsFromReceipt(receipt);
  } catch (e) {
    console.log(`[Withdraw] Could not store commitments: ${e.message}`);
  }
  let module3Notes = null;
  let module3NotesWarning = null;
  if (withdrawData.noteHints && withdrawData.ownerAddress) {
    try {
      module3Notes = await persistWithdrawChangeNote({
        txHash: receipt.hash,
        ownerAddress: withdrawData.ownerAddress,
        noteHints: withdrawData.noteHints,
        publicInputs: withdrawData.publicInputs,
      });
    } catch (e) {
      module3NotesWarning = e.message || String(e);
    }
  }

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    validatorSignatures: validationResultWd.signatures.length,
    relayer: relayerAddr,
    ...(withdrawData._shadowPayoutTo
      ? {
          withdrawPayoutShadow: recipient,
          userFinalRecipient: withdrawData._shadowPayoutTo,
        }
      : {}),
    ...(shadowForward || {}),
    ...(module3Notes ? { module3Notes } : {}),
    ...(module3NotesWarning ? { module3NotesWarning } : {}),
  };
}

async function submitPortfolioSwap(swapData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const abi = [
    "function portfolioSwap(((bytes,bytes,bytes),(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),(address,address,uint256,uint256,uint24,uint160,bytes),address,address,bytes)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  const pi = swapData.publicInputs || {};
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(swapData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.oldCommitment),
    toBytes32(pi.newCommitment),
    toU256(pi.oldNonce),
    toU256(pi.newNonce),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetID),
    toU256(pi.swapAmount),
    toU256(pi.outputAmount),
    toU256(pi.minOutputAmount),
    toU256(pi.protocolFee),
    toU256(pi.gasRefund)
  ];
  const swapParamsTuple = [
    toAddress(swapData.swapParams?.tokenIn),
    toAddress(swapData.swapParams?.tokenOut),
    toU256(swapData.swapParams?.amountIn),
    toU256(swapData.swapParams?.minAmountOut),
    Number(swapData.swapParams?.fee || 0),
    toU256(swapData.swapParams?.sqrtPriceLimitX96 || 0),
    swapData.swapParams?.path || "0x"
  ];
  const dataForContract = [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    swapData.owner || signer.address,
    swapData.relayer || signer.address,
    swapData.encryptedPayload || "0x"
  ];
  try {
    const tx = await contract.portfolioSwap(dataForContract);
    const receipt = await tx.wait();
    let noteStored = false;
    const owner = swapData.owner || signer.address;
    if (NOTE_STORAGE_ADDRESS && swapData.encryptedNextNote) {
      try {
        const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
        const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
        const enc = typeof swapData.encryptedNextNote === "string" ? swapData.encryptedNextNote : ethers.hexlify(swapData.encryptedNextNote);
        await (await ns.storeNoteFor(owner, enc)).wait();
        noteStored = true;
      } catch (nsErr) {
        console.warn("[PortfolioSwap] NoteStorage.storeNoteFor failed:", nsErr.message);
      }
    }
    try {
      pushTransaction({ op: "portfolioSwap", txHash: receipt.hash, blockNumber: receipt.blockNumber });
    } catch (_) {
      /* ignore */
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
  } catch (err) {
    const decoded = decodeSwapError(err);
    console.error("[PortfolioSwap] Revert:", decoded);
    throw new Error(decoded || err.message || "Portfolio swap failed");
  }
}

function decodeSwapError(err) {
  const msg = err.reason || err.shortMessage || err.message || "";
  if (!err?.data) return msg;
  const data = typeof err.data === "string" ? err.data : err.data?.data || err.data;
  if (!data || data === "0x") return msg;
  if (data.length >= 74) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], "0x" + data.slice(10, 74));
      const code = Number(decoded[0]);
      const codes = {
        5: "PoolErr(5): Protocol fee mismatch — backend fee ≠ contract. Check /portfolio/swap-fee and FeeOracle.",
        6: "PoolErr(6): Invalid proof — verify proof inputs and circuit match.",
        7: "PoolErr(7): gasRefund exceeds input amount.",
        11: "PoolErr(11): Invalid asset — assetRegistry not set for this assetId.",
        15: "PoolErr(15): Slippage exceeded — swap output < minOutputAmount. Increase slippage or retry.",
        19: "PoolErr(19): Change note is zero. Lower swap amount or gasRefund so a positive change remains.",
        40: "PoolErr(40): Threshold verifier rejected the proof bundle.",
        41: "PoolErr(41): Merkle root mismatch. Refresh Merkle data and regenerate proof.",
        42: "PoolErr(42): Merkle path invalid for the selected note commitment.",
        43: "PoolErr(43): Conservation mismatch. inputAmount must equal swap + change + protocolFee + gasRefund.",
        24: "PoolErr(24): Portfolio state mismatch — commitment/nonce changed. Refresh and rebuild proof.",
        25: "PoolErr(25): Invalid nonce — newNonce must equal oldNonce + 1."
      };
      return codes[code] || `PoolErr(${code})`;
    } catch (_) {}
  }
  if (typeof data === "string" && data.includes("PancakeRouter")) return "PancakeSwap: Output < minAmountOut. Price moved or wrong path. Increase slippage.";
  if (msg.includes("FeeOracle")) return "FeeOracle: " + (msg || "Oracle price stale or missing.");
  if (msg.includes("PancakeSwapAdaptor")) return "Adaptor: " + (msg || "Swap failed.");
  return msg;
}

async function submitPortfolioDeposit(depositData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const readAbi = [
    "function userPortfolioCommitment(address) view returns (bytes32)",
    "function userPortfolioNonce(address) view returns (uint256)"
  ];
  const readContract = new ethers.Contract(SHIELDED_POOL_ADDRESS, readAbi, provider);
  const owner = depositData.owner || signer.address;
  const [storedCommitment, storedNonce] = await Promise.all([
    readContract.userPortfolioCommitment(owner),
    readContract.userPortfolioNonce(owner)
  ]);
  const pi = depositData.publicInputs || {};
  const expectedOldCommitment = storedCommitment === ethers.ZeroHash ? ethers.ZeroHash : storedCommitment;
  const expectedOldNonce = Number(storedNonce);
  const toBytes32ForCmp = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const sentOldCommitment = toBytes32ForCmp(pi.oldCommitment);
  const sentOldNonce = Number(toBigInt(pi.oldNonce ?? "0"));
  if (sentOldCommitment !== expectedOldCommitment || sentOldNonce !== expectedOldNonce) {
    throw new Error(
      `Portfolio state mismatch (PoolErr 24): on-chain commitment=${expectedOldCommitment}, nonce=${expectedOldNonce}; ` +
      `sent commitment=${sentOldCommitment}, nonce=${sentOldNonce}. Ensure frontend fetches on-chain state before building proof.`
    );
  }
  const abi = [
    "function portfolioDeposit(address,uint256,((bytes,bytes,bytes),(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),(address,address,uint256,uint256,uint24,uint160,bytes),address,address,bytes)) external payable"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");
  const proofTuple = DEV_BYPASS_PROOFS
    ? ["0x", "0x", "0x"]
    : (() => {
        const encoded = encodeGroth16Proof(depositData.proof);
        return [encoded.a, encoded.b, encoded.c];
      })();
  const publicInputsTuple = [
    toBytes32(pi.oldCommitment),
    toBytes32(pi.newCommitment),
    toU256(pi.oldNonce),
    toU256(pi.newNonce),
    toU256(pi.inputAssetID),
    toU256(pi.outputAssetID),
    toU256(pi.swapAmount),
    toU256(pi.outputAmount),
    toU256(pi.minOutputAmount),
    toU256(pi.protocolFee),
    toU256(pi.gasRefund)
  ];
  const swapParamsTuple = [
    toAddress(depositData.swapParams?.tokenIn),
    toAddress(depositData.swapParams?.tokenOut),
    toU256(depositData.swapParams?.amountIn || 0),
    toU256(depositData.swapParams?.minAmountOut || 0),
    Number(depositData.swapParams?.fee || 0),
    toU256(depositData.swapParams?.sqrtPriceLimitX96 || 0),
    depositData.swapParams?.path || "0x"
  ];
  const dataForContract = [
    proofTuple,
    publicInputsTuple,
    swapParamsTuple,
    depositData.owner || signer.address,
    depositData.relayer || signer.address,
    depositData.encryptedPayload || "0x"
  ];
  const tx = await contract.portfolioDeposit(
    depositData.token || ethers.ZeroAddress,
    toU256(depositData.amount || 0),
    dataForContract,
    { value: depositData.token === ethers.ZeroAddress ? toU256(depositData.amount || 0) : 0 }
  );
  const receipt = await tx.wait();
  let noteStored = false;
  if (NOTE_STORAGE_ADDRESS && depositData.encryptedNextNote) {
    try {
      const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
      const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
      const enc = typeof depositData.encryptedNextNote === "string" ? depositData.encryptedNextNote : ethers.hexlify(depositData.encryptedNextNote);
      await (await ns.storeNoteFor(owner, enc)).wait();
      noteStored = true;
    } catch (nsErr) {
      console.warn("[PortfolioDeposit] NoteStorage.storeNoteFor failed:", nsErr.message);
    }
  }
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
}

async function submitPortfolioWithdraw(withdrawData) {
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !SHIELDED_POOL_ADDRESS) {
    throw new Error("Relayer env not configured");
  }
  if (!withdrawData?.proof || !withdrawData?.publicInputs) {
    throw new Error("portfolio withdraw requires proof and publicInputs");
  }
  if (!withdrawData.recipient || !ethers.isAddress(withdrawData.recipient)) {
    throw new Error("portfolio withdraw requires valid recipient address");
  }
  if (!withdrawData.owner || !ethers.isAddress(withdrawData.owner)) {
    throw new Error("portfolio withdraw requires valid owner address");
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  const pi = withdrawData.publicInputs || {};
  const toBytes32 = (v) => {
    if (v === undefined || v === null) return ethers.ZeroHash;
    const bi = toBigInt(v);
    return ethers.zeroPadValue(ethers.toBeHex(bi), 32);
  };
  const toU256 = (v) => toBigInt(v ?? "0");

  let proofEncoded;
  try {
    proofEncoded = DEV_BYPASS_PROOFS
      ? { a: "0x", b: "0x", c: "0x" }
      : encodeGroth16Proof(withdrawData.proof);
  } catch (e) {
    throw new Error(`Proof encoding failed: ${e.message}. Proof format: a=${Array.isArray(withdrawData.proof?.a) ? "array" : typeof withdrawData.proof?.a}, b=${Array.isArray(withdrawData.proof?.b) ? (Array.isArray(withdrawData.proof.b[0]) ? "nested" : "flat") : typeof withdrawData.proof?.b}`);
  }

  const dataForContract = {
    proof: { a: proofEncoded.a, b: proofEncoded.b, c: proofEncoded.c },
    publicInputs: {
      oldCommitment: toBytes32(pi.oldCommitment),
      newCommitment: toBytes32(pi.newCommitment),
      oldNonce: toU256(pi.oldNonce),
      newNonce: toU256(pi.newNonce),
      inputAssetID: toU256(pi.inputAssetID),
      outputAssetID: toU256(pi.outputAssetID),
      swapAmount: toU256(pi.swapAmount),
      outputAmount: toU256(pi.outputAmount),
      minOutputAmount: toU256(pi.minOutputAmount),
      protocolFee: toU256(pi.protocolFee),
      gasRefund: toU256(pi.gasRefund)
    },
    recipient: ethers.getAddress(withdrawData.recipient),
    owner: ethers.getAddress(withdrawData.owner || signer.address),
    relayer: ethers.getAddress(withdrawData.relayer || signer.address),
    encryptedPayload: withdrawData.encryptedPayload || "0x"
  };

  const artifactPath = path.join(__dirname, "..", "..", "artifacts", "contracts", "core", "ShieldedPool.sol", "ShieldedPool.json");
  const artifact = fs.existsSync(artifactPath) ? JSON.parse(fs.readFileSync(artifactPath, "utf8")) : null;
  const portfolioWithdrawAbi = artifact?.abi?.find((x) => x.type === "function" && x.name === "portfolioWithdraw");
  const abi = portfolioWithdrawAbi ? [portfolioWithdrawAbi] : [
    "function portfolioWithdraw((tuple(bytes a,bytes b,bytes c),tuple(bytes32 oldCommitment,bytes32 newCommitment,uint256 oldNonce,uint256 newNonce,uint256 inputAssetID,uint256 outputAssetID,uint256 swapAmount,uint256 outputAmount,uint256 minOutputAmount,uint256 protocolFee,uint256 gasRefund),address recipient,address owner,address relayer,bytes encryptedPayload)) external"
  ];
  const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);

  const tx = await contract.portfolioWithdraw(dataForContract);
  const receipt = await tx.wait();
  let noteStored = false;
  const owner = ethers.getAddress(withdrawData.owner || signer.address);
  if (NOTE_STORAGE_ADDRESS && withdrawData.encryptedNextNote) {
    try {
      const nsAbi = ["function storeNoteFor(address owner, bytes calldata encryptedNote) external"];
      const ns = new ethers.Contract(NOTE_STORAGE_ADDRESS, nsAbi, signer);
      const enc = typeof withdrawData.encryptedNextNote === "string" ? withdrawData.encryptedNextNote : ethers.hexlify(withdrawData.encryptedNextNote);
      await (await ns.storeNoteFor(owner, enc)).wait();
      noteStored = true;
    } catch (nsErr) {
      console.warn("[PortfolioWithdraw] NoteStorage.storeNoteFor failed:", nsErr.message);
    }
  }
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, noteStored };
}

async function submitDeposit(payload) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

  if (payload.token === ethers.ZeroAddress) {

    const feeWei = await getDepositFeeBNBWei();
    const totalValue = BigInt(payload.amount) + feeWei;
    const abi = [
      "function depositForBNB(address depositor,bytes32 commitment,uint256 assetID) external payable"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositForBNB(
      payload.depositor,
      payload.commitment,
      payload.assetID,
      { value: totalValue }
    );
    const receipt = await tx.wait();
    try {
      storeCommitmentsFromReceipt(receipt);
    } catch (e) {
      console.log(`[Deposit] Could not store commitments (e.g. read-only DB): ${e.message}`);
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  } else {
    const feeWei = await getDepositFeeBNBWei();
    const abi = [
      "function depositFor(address depositor,address token,uint256 amount,bytes32 commitment,uint256 assetID) external"
    ];
    const contract = new ethers.Contract(SHIELDED_POOL_ADDRESS, abi, signer);
    const tx = await contract.depositFor(
      payload.depositor,
      payload.token,
      payload.amount,
      payload.commitment,
      payload.assetID,
      { value: feeWei }
    );
    const receipt = await tx.wait();
    try {
      storeCommitmentsFromReceipt(receipt);
    } catch (e) {
      console.log(`[Deposit] Could not store commitments (e.g. read-only DB): ${e.message}`);
    }
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
    } catch (_) { }
  }
}

async function assertRequiredBscAssetsOnChain() {
  const cfg = getRuntimeConfig();
  if (Number(cfg.chainId) !== 97) return;
  if (!RPC_URL || !SHIELDED_POOL_ADDRESS) return;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pool = new ethers.Contract(
    SHIELDED_POOL_ADDRESS,
    ["function assetRegistry(uint256) view returns (address)"],
    provider
  );
  for (const req of REQUIRED_BSC_TESTNET_ASSETS) {
    if (req.assetId === 0) continue;
    const onchain = normalizeEvmAddress(await pool.assetRegistry(req.assetId));
    const expected = normalizeEvmAddress(req.address);
    if (onchain.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `ONCHAIN_ASSET_MISMATCH: assetId=${req.assetId} expected=${expected} onchain=${onchain}`
      );
    }
  }
}

function buildLeaves(rows) {
  const depth = 10;
  const size = 1 << depth;
  const leaves = new Array(size).fill(0n);
  for (const row of rows) {
    const idx = Number(row.idx);
    if (idx >= 0 && idx < size) {
      leaves[idx] = toBigInt(row.commitment);
    }
  }
  return leaves;
}

function rebuildKeccak256Tree(commitments) {
  let root = ethers.ZeroHash; 

  for (let idx = 0; idx < commitments.length; idx++) {
    const commitment = commitments[idx];

    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "uint256"],
      [root, commitment, idx]
    );
    root = ethers.keccak256(packed);
  }

  return root;
}

function rebuildIncrementalTree(commitments) {
  const depth = 10;

  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 1; i < depth; i++) {
    currentZero = mimc7(currentZero, currentZero);
    zeros.push(currentZero);
  }

  const filledSubtrees = new Array(depth).fill(null);

  const nodeValues = [];
  for (let i = 0; i <= depth; i++) nodeValues[i] = {};

  let root = zeros[depth - 1];

  for (let idx = 0; idx < commitments.length; idx++) {
    const leaf = toBigInt(commitments[idx]);
    nodeValues[0][idx] = leaf; 

    let currentHash = leaf;
    let currentIndex = idx;

    for (let i = 0; i < depth; i++) {
      if (currentIndex % 2 === 0) {
        filledSubtrees[i] = currentHash;
        currentHash = mimc7(currentHash, zeros[i]);
      } else {
        if (filledSubtrees[i] === null) {
          throw new Error(`filledSubtrees[${i}] is null for index ${idx} - tree state inconsistent`);
        }
        currentHash = mimc7(filledSubtrees[i], currentHash);
      }
      currentIndex = Math.floor(currentIndex / 2);
      const posAtNextLevel = idx >> (i + 1);
      nodeValues[i + 1][posAtNextLevel] = currentHash;
    }

    root = currentHash;
  }

  return { root, filledSubtrees, nodeValues, zeros };
}

function buildFullMerkleTree(commitments) {
  const depth = 10;
  const numLeaves = 1 << depth; 

  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 1; i < depth; i++) {
    currentZero = mimc7(currentZero, currentZero);
    zeros.push(currentZero);
  }

  const levels = [];
  const level0 = [];
  for (let i = 0; i < numLeaves; i++) {
    level0.push(i < commitments.length ? toBigInt(commitments[i]) : zeros[0]);
  }
  levels.push(level0);

  for (let lev = 1; lev < depth; lev++) {
    const prev = levels[lev - 1];
    const size = prev.length >> 1;
    const curr = [];
    for (let j = 0; j < size; j++) {
      curr.push(mimc7(prev[2 * j], prev[2 * j + 1]));
    }
    levels.push(curr);
  }

  const top = levels[depth - 1];
  const root = mimc7(top[0], top[1]);
  return { levels, zeros, root };
}

function buildMerklePath(commitments, targetIndex) {
  const depth = 10;
  if (targetIndex < 0 || targetIndex >= commitments.length) {
    throw new Error(`buildMerklePath: index ${targetIndex} out of range [0, ${commitments.length})`);
  }

  const { root, nodeValues, zeros } = rebuildIncrementalTree(commitments);

  const path = [];
  const indices = [];

  for (let i = 0; i < depth; i++) {
    const pos = targetIndex >> i;
    const siblingPos = pos ^ 1;
    const sibling = (nodeValues[i] && nodeValues[i][siblingPos] !== undefined)
      ? nodeValues[i][siblingPos]
      : zeros[i];
    path.push(`0x${sibling.toString(16).padStart(64, "0")}`);
    indices.push(pos % 2); 

  }

  return { path, indices, root: `0x${root.toString(16).padStart(64, "0")}` };
}

async function simulateSwap(intentId) {
  const fake = ethers.keccak256(ethers.toUtf8Bytes(intentId));
  let relayer = ethers.ZeroAddress;
  try {
    if (RELAYER_PRIVATE_KEY) relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY).address;
  } catch (_) {}
  return { txHash: fake, blockNumber: 0, relayer };
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
    relayer: txResult?.relayer || swapData.relayer || ethers.ZeroAddress,
    timestamp: Math.floor(Date.now() / 1000),
    internalFheMatch: txResult?.internalFheMatch ?? null,
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
  const feeFloor = RUNTIME_PARAMS.fees.oracleFeeFloorUsdE8;
  const percentageFee = (usdValue * BigInt(RUNTIME_PARAMS.fees.oracleFeeRateBps)) / 10000n;
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
    if (raw.PORT != null && process.env.PORT === undefined) process.env.PORT = String(raw.PORT);
  } catch (_) { }
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
