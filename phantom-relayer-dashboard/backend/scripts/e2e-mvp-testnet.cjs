#!/usr/bin/env node
/**
 * Module 7 — Scripted E2E against a running relayer + BSC testnet (deposit → swap → withdraw).
 *
 * Prerequisites:
 *   - Relayer backend live (`npm run dev` in backend) with pool + RPC + relayer key.
 *   - User wallet `E2E_USER_PRIVATE_KEY` funded with testnet BNB + enough `E2E_TOKEN` (BUSD-style) approved or balance for deposit amount.
 *   - For swap/withdraw without local prover: relayer often needs `DEV_BYPASS_PROOFS=true` (documented; not for production NODE_ENV).
 *
 * Usage (from backend/):
 *   API_URL=http://127.0.0.1:5050 \
 *   E2E_USER_PRIVATE_KEY=0x... \
 *   E2E_MODE=bnb \
 *   E2E_TOKEN=0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7 \
 *   E2E_OUTPUT_TOKEN=0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7 \
 *   node scripts/e2e-mvp-testnet.cjs
 *
 * Default swap-out token is the same BUSD-style testnet token as `E2E_TOKEN` — Pancake V2 has a
 * WBNB pair for it on BSC testnet. `0x7eF95…` BUSD often has **no V2 liquidity** on testnet (router reverts).
 *
 * BNB mode + Module4: server caps `depositForBNB` note size (`/config` → maxBnbWei, default 0.05 tBNB).
 * Default `E2E_DEPOSIT_WEI` for `bnb` is 0.045 tBNB so you stay under the cap without tuning.
 *
 * Swap leaves a **reserved** BNB change note (`E2E_RESERVE_CHANGE_AFTER_SWAP_WEI`, default 0.012 tBNB)
 * so withdraw (which needs a positive change output) does not fail after a “full” swap.
 *
 * Important: `/quote` may return `fees.totalFee` (oracle/DEX UI fee estimate). That is **not** the same
 * field as join-split `protocolFee` in ZK / `ShieldedPool` public inputs. The script uses
 * `E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI` (default **0**) for conservation; using quote fees there shrinks
 * `swapAmount` and often breaks Pancake execution (revert with no data) or leaves absurd splits.
 *
 * Optional: MODULE4_DEPOSIT_API_SECRET, E2E_DEPOSIT_WEI, E2E_EXPECT_USER_ADDRESS (sanity check),
 *   E2E_MAX_SWAP_GAS_REFUND_WEI, E2E_RESERVE_CHANGE_AFTER_SWAP_WEI, E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI,
 *   E2E_WITHDRAW_PAYOUT_WEI, E2E_PROTOCOL_FEE_WEI, E2E_GAS_REFUND_WEI (withdraw leg),
 *   E2E_POST_SWAP_WAIT_MS (default 3000), MERKLE_POLL_MS / MERKLE_POLL_MAX
 *
 * Before E2E: `npm run mvp:preflight` — checks withdrawHandler, relayer registry, RPC, /health.
 *
 * If the pool has no withdraw handler yet, set `E2E_SKIP_WITHDRAW=true` to validate deposit+swap only,
 * or run `set-pathb-withdraw-handler.ts` as the **pool owner** (`owner()` on-chain), then re-run full E2E.
 *
 * Deposit fee: the pool contract enforces `DEPOSIT_FEE_USD` (e.g. $2 in 1e8 units). The relayer’s
 * `getDepositFeeBNBWei()` uses max(`PHANTOM_DEPOSIT_FEE_USD_E8`, on-chain minimum) so lowering env alone
 * cannot underpay and revert the pool; a new deployment is required for a lower on-chain floor.
 */
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");
const { canonicalizeNote, computeNullifier } = require(path.join(__dirname, "..", "src", "noteModel"));
const FROZEN_CONFIG = require(path.join(__dirname, "..", "..", "..", "frozenProductionConfig.json"));

let API_URL = (process.env.API_URL || "").trim().replace(/\/$/, "");
const E2E_USER_PRIVATE_KEY = String(process.env.E2E_USER_PRIVATE_KEY || "").trim();
const E2E_MODE = String(process.env.E2E_MODE || "erc20").trim().toLowerCase();

function checksumAddr(hex) {
  const s = String(hex || "").trim();
  if (!s) return s;
  try {
    return ethers.getAddress(s);
  } catch {
    return s;
  }
}

const TOKEN = checksumAddr(process.env.E2E_TOKEN || "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7");
const OUTPUT_TOKEN = checksumAddr(
  process.env.E2E_OUTPUT_TOKEN || "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7"
);

const DEPOSIT_WEI = String(
  process.env.E2E_DEPOSIT_WEI != null && String(process.env.E2E_DEPOSIT_WEI).trim() !== ""
    ? process.env.E2E_DEPOSIT_WEI
    : E2E_MODE === "bnb"
      ? "45000000000000000"
      : "1000000000000000000"
);

const E2E_MAX_SWAP_GAS_REFUND_WEI = String(process.env.E2E_MAX_SWAP_GAS_REFUND_WEI || "2500000000000000");
const E2E_RESERVE_CHANGE_AFTER_SWAP_WEI = String(process.env.E2E_RESERVE_CHANGE_AFTER_SWAP_WEI || "12000000000000000");
const E2E_SWAP_GAS_REFUND_FALLBACK_WEI = String(process.env.E2E_SWAP_GAS_REFUND_FALLBACK_WEI || "1000000000000000");
/** Join-split / ZK `protocolFee` (wei). Keep 0 unless your pool enforces a non-zero shielded protocol fee on swap. */
const E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI = String(process.env.E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI ?? "0");
const MODULE4_DEPOSIT_API_SECRET = String(process.env.MODULE4_DEPOSIT_API_SECRET || "").trim();
const SLIPPAGE_BPS = Number(process.env.E2E_SLIPPAGE_BPS || 500);
const MERKLE_POLL_MS = Number(process.env.MERKLE_POLL_MS || 3000);
const MERKLE_POLL_MAX = Number(process.env.MERKLE_POLL_MAX || 45);
const E2E_ALLOW_EXISTING_NOTES = String(process.env.E2E_ALLOW_EXISTING_NOTES || "").toLowerCase() === "true";

function getAssetIdForToken(addr) {
  const n = String(addr || "").toLowerCase();
  if (n === ethers.ZeroAddress.toLowerCase()) return 0;
  if (n === "0x78867bbeeef44f2326bf8ddd1941a4439382ef2a7") return 1;
  if (n === "0x7ef95a0fe8a5f4f9c1824fbf6656e2f95fa6bf13") return 2;
  return Number(process.env.E2E_INPUT_ASSET_ID || 1);
}

function outputAssetId(addr) {
  const n = String(addr || "").toLowerCase();
  if (n === "0x78867bbeeef44f2326bf8ddd1941a4439382ef2a7") return 1;
  if (n === "0x7ef95a0fe8a5f4f9c1824fbf6656e2f95fa6bf13") return 2;
  return Number(process.env.E2E_OUTPUT_ASSET_ID || 1);
}

function canonicalWbnb(chainId) {
  return Number(chainId) === 56
    ? "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
    : "0xae13d989dac2f0debff460ac112a837c89baa7cd";
}

function requestJson(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const proveTimeout = Number(process.env.E2E_HTTP_TIMEOUT_MS || 900000);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: proveTimeout,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || "{}"), raw: buf });
          } catch {
            resolve({ status: res.statusCode, text: buf, raw: buf });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`request timeout (${proveTimeout}ms) ${method} ${urlStr}`));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function encryptRelayEnvelope(apiUrl, payload) {
  const keyResp = await requestJson("GET", `${apiUrl}/relayer/encryption-key`);
  if (keyResp.status !== 200 || !keyResp.json?.publicKeyPem) {
    throw new Error(`relayer encryption key fetch failed: ${keyResp.status} ${keyResp.raw || ""}`);
  }
  const publicKeyPem = String(keyResp.json.publicKeyPem);
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey
  );
  return {
    keyId: String(keyResp.json.keyId || ""),
    encryptedKey: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function loadMockFingerprints() {
  const fpPath = path.join(__dirname, "..", "..", "..", "config", "module7-mock-bytecode-hashes.json");
  if (!fs.existsSync(fpPath)) return null;
  return JSON.parse(fs.readFileSync(fpPath, "utf8"));
}

async function assertPoolNotMockOnChain(rpcUrl, poolAddr) {
  const fp = loadMockFingerprints();
  if (!fp?.mockVerifierBytecodeHash) {
    console.warn("[e2e] skip on-chain mock check: no module7-mock-bytecode-hashes.json");
    return;
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const pool = new ethers.Contract(
    poolAddr,
    [
      "function verifier() view returns (address)",
      "function swapAdaptor() view returns (address)",
    ],
    provider
  );
  const [v, s] = await Promise.all([pool.verifier(), pool.swapAdaptor()]);
  const [codeV, codeS] = await Promise.all([provider.getCode(v), provider.getCode(s)]);
  const hv = ethers.keccak256(codeV);
  const hs = ethers.keccak256(codeS);
  if (hv === fp.mockVerifierBytecodeHash) throw new Error("E2E abort: verifier bytecode matches MockVerifier");
  if (hs === fp.mockSwapAdaptorBytecodeHash) throw new Error("E2E abort: swapAdaptor bytecode matches MockSwapAdaptor");
  console.log("[e2e] on-chain mock fingerprint check OK");
}

async function pollMerkle(commitment) {
  for (let i = 0; i < MERKLE_POLL_MAX; i += 1) {
    const r = await requestJson("GET", `${API_URL}/merkle/${encodeURIComponent(commitment)}`);
    if (r.status === 200 && r.json?.merkleRoot) {
      return r.json;
    }
    console.log(`[e2e] merkle poll ${i + 1}/${MERKLE_POLL_MAX} status=${r.status}`);
    await new Promise((res) => setTimeout(res, MERKLE_POLL_MS));
  }
  throw new Error("Merkle path not available in time — indexer / chain lag?");
}

function assertEq(label, actual, expected) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label} mismatch: expected=${expected} actual=${actual}`);
  }
}

async function fetchUsableNotes(apiUrl, ownerAddress) {
  const out = await requestJson(
    "GET",
    `${apiUrl}/notes?ownerAddress=${encodeURIComponent(ownerAddress)}&limit=200`
  );
  if (out.status !== 200) {
    throw new Error(`/notes failed: ${out.status} ${out.raw || ""}`);
  }
  return out.json;
}

function assertNotesPinnedToFrozenConfig(notesResp, cfg) {
  const currentPool = String(cfg.addresses?.shieldedPool || "").toLowerCase();
  const currentOracle = String(cfg.addresses?.feeOracle || "").toLowerCase();
  const currentVersion = String(cfg.deploymentVersion || "");
  for (const n of notesResp.notes || []) {
    if (String(n.status || "").toLowerCase() !== "unspent") {
      throw new Error(`note ${n.noteId} is not unspent`);
    }
    assertEq(`note ${n.noteId} poolAddress`, String(n.poolAddress || "").toLowerCase(), currentPool);
    assertEq(`note ${n.noteId} oracleAddress`, String(n.oracleAddress || "").toLowerCase(), currentOracle);
    assertEq(`note ${n.noteId} deploymentVersion`, String(n.deploymentVersion || ""), currentVersion);
  }
}

async function main() {
  const { discoverRelayerApiUrl } = require("./lib/relayerApiDiscover.cjs");
  const d = await discoverRelayerApiUrl(API_URL || process.env.API_URL);
  API_URL = d.url;
  if (d.hint) console.warn("[e2e]", d.hint);
  console.log("[e2e] API_URL", API_URL);

  if (!E2E_USER_PRIVATE_KEY) {
    console.error("Set E2E_USER_PRIVATE_KEY (funded testnet user).");
    process.exit(1);
  }
  if (E2E_MODE !== "erc20" && E2E_MODE !== "bnb") {
    throw new Error("E2E_MODE must be 'erc20' or 'bnb'");
  }
  let userPk = String(E2E_USER_PRIVATE_KEY).trim();
  if (!userPk.startsWith("0x") && /^[0-9a-fA-F]{64}$/.test(userPk)) userPk = `0x${userPk}`;
  const wallet = new ethers.Wallet(userPk);
  console.log("[e2e] user", wallet.address);

  const expectUser = String(process.env.E2E_EXPECT_USER_ADDRESS || "").trim();
  if (expectUser) {
    let expectCs;
    try {
      expectCs = ethers.getAddress(expectUser);
    } catch {
      throw new Error(`[e2e] invalid E2E_EXPECT_USER_ADDRESS: ${expectUser}`);
    }
    if (wallet.address.toLowerCase() !== expectCs.toLowerCase()) {
      throw new Error(`[e2e] wallet ${wallet.address} does not match E2E_EXPECT_USER_ADDRESS ${expectCs}`);
    }
    console.log("[e2e] E2E_EXPECT_USER_ADDRESS OK");
  }

  const health = await requestJson("GET", `${API_URL}/health`);
  if (health.status !== 200) throw new Error(`health failed: ${health.status} ${health.raw || ""}`);
  const cfg = await requestJson("GET", `${API_URL}/config`);
  if (cfg.status !== 200) throw new Error(`config failed: ${cfg.status}`);
  const chainId = Number(cfg.json.chainId || 97);
  const encryptedEnvelopeRequired = !!cfg.json?.module6Withdraw?.encryptedEnvelopeRequired;
  const pool = cfg.json.addresses?.shieldedPool;
  const rpcUrl = String(cfg.json.rpcUrl || process.env.RPC_URL || "").trim();
  if (!pool) throw new Error("config.addresses.shieldedPool missing");
  if (!cfg.json.frozenConfig) throw new Error("config is not marked as frozenConfig");
  if (!cfg.json.deploymentVersion) throw new Error("config.deploymentVersion missing");
  assertEq("config.version", cfg.json.deploymentVersion, FROZEN_CONFIG.version);
  assertEq("config.chainId", Number(cfg.json.chainId), Number(FROZEN_CONFIG.chainId));
  assertEq(
    "config.pool",
    String(cfg.json.addresses?.shieldedPool || "").toLowerCase(),
    String(FROZEN_CONFIG.addresses?.shieldedPool || "").toLowerCase()
  );
  assertEq(
    "config.oracle",
    String(cfg.json.addresses?.feeOracle || "").toLowerCase(),
    String(FROZEN_CONFIG.addresses?.feeOracle || "").toLowerCase()
  );
  if (rpcUrl) await assertPoolNotMockOnChain(rpcUrl, pool);

  const notesAtStart = await fetchUsableNotes(API_URL, wallet.address);
  if (!E2E_ALLOW_EXISTING_NOTES && (notesAtStart.count || 0) !== 0) {
    throw new Error(`fresh wallet gate failed: expected 0 usable notes, found ${notesAtStart.count}`);
  }
  if (E2E_ALLOW_EXISTING_NOTES && (notesAtStart.count || 0) !== 0) {
    console.warn(`[e2e] continuing with existing usable notes=${notesAtStart.count}`);
  }

  if (E2E_MODE === "bnb") {
    const capRaw = cfg.json.module4RelayerDeposit?.maxBnbWei ?? cfg.json.maxBnbWei;
    const cap = capRaw != null ? BigInt(String(capRaw)) : 50000000000000000n;
    if (BigInt(DEPOSIT_WEI) > cap) {
      throw new Error(
        `[e2e] E2E_DEPOSIT_WEI=${DEPOSIT_WEI} exceeds Module4 BNB cap ${cap.toString()} wei (see GET /config → module4RelayerDeposit.maxBnbWei). Lower E2E_DEPOSIT_WEI or raise MODULE4_MAX_BNB_WEI on the server.`
      );
    }
    console.log("[e2e] BNB deposit vs Module4 cap OK", { depositWei: DEPOSIT_WEI, maxBnbWei: cap.toString() });
  }

  if (rpcUrl) {
    const rp = new ethers.JsonRpcProvider(rpcUrl);
    const poolRead = new ethers.Contract(pool, ["function withdrawHandler() view returns (address)"], rp);
    const wh = await poolRead.withdrawHandler();
    if (String(wh).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
      console.warn(
        "[e2e] withdrawHandler on ShieldedPool is unset — withdraw will revert until the pool owner deploys+wires WithdrawHandler (see Phantom-Smart-Contracts/scripts/deploy/set-pathb-withdraw-handler.ts). Or set E2E_SKIP_WITHDRAW=true to stop after swap."
      );
    }
  }

  const authHeaders = MODULE4_DEPOSIT_API_SECRET
    ? { Authorization: `Bearer ${MODULE4_DEPOSIT_API_SECRET}` }
    : {};

  const idempotencyKey = `e2e-${crypto.randomBytes(8).toString("hex")}`;
  const inputAssetId = E2E_MODE === "bnb" ? 0 : getAssetIdForToken(TOKEN);
  const sessionBody = {
    idempotencyKey,
    depositor: wallet.address,
    mode: E2E_MODE,
    ...(E2E_MODE === "erc20" ? { token: TOKEN } : {}),
    amount: DEPOSIT_WEI,
    assetId: inputAssetId,
  };
  const s = await requestJson("POST", `${API_URL}/relayer/deposit/session`, sessionBody);
  if (s.status !== 200 || !s.json?.sessionId) throw new Error(`deposit session failed: ${s.status} ${JSON.stringify(s.json || s.text)}`);
  const { sessionId, sessionToken } = s.json;

  const blindingFactor = String(BigInt("0x" + crypto.randomBytes(16).toString("hex")));
  const ownerPublicKey = String(BigInt("0x" + crypto.randomBytes(16).toString("hex")));
  const note = {
    assetId: inputAssetId,
    amount: DEPOSIT_WEI,
    blindingFactor,
    ownerPublicKey,
  };
  const canonDep = canonicalizeNote({ ...note, assetID: note.assetId });
  const commitment = canonDep.commitment;
  const commitmentDecDeposit = String(BigInt(commitment));

  const provider = new ethers.JsonRpcProvider(rpcUrl || "https://data-seed-prebsc-1-s1.binance.org:8545");
  const userWithProvider = wallet.connect(provider);
  if (E2E_MODE === "erc20") {
    const erc20 = new ethers.Contract(
      TOKEN,
      ["function approve(address spender,uint256 amount) external returns (bool)", "function allowance(address,address) view returns (uint256)"],
      userWithProvider
    );
    const cur = await erc20.allowance(wallet.address, pool);
    if (cur < BigInt(DEPOSIT_WEI)) {
      console.log("[e2e] approving ShieldedPool for token spend…");
      const txa = await erc20.approve(pool, ethers.MaxUint256);
      console.log("[e2e] approve tx", txa.hash);
      await txa.wait();
    }
  }

  const sub = await requestJson(
    "POST",
    `${API_URL}/relayer/deposit/submit`,
    {
      sessionId,
      sessionToken,
      idempotencyKey,
      commitment,
      note,
    },
    authHeaders
  );
  if (sub.status !== 200) throw new Error(`deposit submit failed: ${sub.status} ${JSON.stringify(sub.json || sub.text)}`);
  console.log("[e2e] deposit OK", JSON.stringify(sub.json, null, 0));
  const afterDepositNotes = await fetchUsableNotes(API_URL, wallet.address);
  if ((afterDepositNotes.count || 0) < 1) {
    throw new Error("deposit assertion failed: /notes returned no usable note");
  }
  assertNotesPinnedToFrozenConfig(afterDepositNotes, cfg.json);

  const merkle = await pollMerkle(commitment);
  console.log("[e2e] merkle root", merkle.merkleRoot);

  const notePayload = {
    version: 1,
    assetID: note.assetId,
    amount: note.amount,
    blindingFactor: note.blindingFactor,
    ownerPublicKey: note.ownerPublicKey,
    commitmentDecimal: commitmentDecDeposit,
    commitmentHex: commitment,
  };
  const nullifier = computeNullifier(commitment, note.ownerPublicKey);
  const nullifierHex = `0x${nullifier.toString(16).padStart(64, "0")}`;

  const wbnb = canonicalWbnb(chainId);
  // Quote API may use WBNB for routing math; on-chain join-split for assetID 0 must use native BNB (0x0) in swapParams.
  const tokenIn = E2E_MODE === "bnb" ? wbnb : TOKEN;
  const tokenOut = OUTPUT_TOKEN;
  const amountWei = note.amount;
  const chainSlug = chainId === 97 ? "bsc-testnet" : "bsc";
  const qRough = await requestJson("POST", `${API_URL}/quote`, {
    tokenIn,
    tokenOut,
    amountIn: amountWei,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    slippageBps: SLIPPAGE_BPS,
    chainSlug,
  });
  if (qRough.status !== 200) throw new Error(`quote failed ${qRough.status} ${qRough.raw}`);
  const rough = qRough.json;

  const gasCapBn = BigInt(E2E_MAX_SWAP_GAS_REFUND_WEI);
  const fallbackGasBn = BigInt(E2E_SWAP_GAS_REFUND_FALLBACK_WEI);
  let gasRefundBn = BigInt(String(rough.suggestedGasRefundWei || "0"));
  if (gasRefundBn === 0n) gasRefundBn = fallbackGasBn;
  if (gasRefundBn > gasCapBn) gasRefundBn = gasCapBn;
  const gasRefund = gasRefundBn.toString();

  const joinSplitProtocolBn = BigInt(E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI);
  if (joinSplitProtocolBn < 0n) throw new Error("E2E_JOIN_SPLIT_PROTOCOL_FEE_WEI must be >= 0");

  const reserveBn = BigInt(E2E_RESERVE_CHANGE_AFTER_SWAP_WEI);
  const noteBn = BigInt(amountWei);
  const swapAmountBn = noteBn - joinSplitProtocolBn - gasRefundBn - reserveBn;
  if (swapAmountBn <= 0n) {
    throw new Error(
      `[e2e] swapAmount would be <= 0 (note=${noteBn} joinSplitProtocol=${joinSplitProtocolBn} gasRefund=${gasRefundBn} reserve=${reserveBn}). Lower reserve/gas or increase E2E_DEPOSIT_WEI (within Module4 cap).`
    );
  }

  const qSwap = await requestJson("POST", `${API_URL}/quote`, {
    tokenIn,
    tokenOut,
    amountIn: swapAmountBn.toString(),
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    slippageBps: SLIPPAGE_BPS,
    chainSlug,
  });
  if (qSwap.status !== 200) throw new Error(`swap-size quote failed ${qSwap.status} ${qSwap.raw}`);
  const quote = qSwap.json;

  const quoteFeeHint = quote.fees?.totalFee != null ? String(quote.fees.totalFee) : "0";
  if (BigInt(quoteFeeHint) > 0n && process.env.E2E_DEBUG_QUOTE_FEES === "1") {
    console.log("[e2e] quote fees.totalFee (informational, not used as join-split protocolFee):", quoteFeeHint);
  }

  const protocolFee = joinSplitProtocolBn.toString();
  const minOut = String(quote.minAmountOut || "0");
  const outAmt = String(quote.amountOut || "0");
  if (BigInt(minOut) <= 0n) throw new Error("quote minAmountOut invalid — check liquidity / QUOTE_MODE");

  const changePreviewBn = noteBn - swapAmountBn - joinSplitProtocolBn - gasRefundBn;
  console.log(
    "[e2e] swap budget",
    JSON.stringify({
      amountWei: String(amountWei),
      protocolFee: String(protocolFee),
      gasRefund: String(gasRefund),
      reserveChangeWei: E2E_RESERVE_CHANGE_AFTER_SWAP_WEI,
      swapAmount: swapAmountBn.toString(),
      expectedChangeWei: changePreviewBn.toString(),
    })
  );
  if (changePreviewBn <= 0n) throw new Error("internal: expected change must be > 0");

  const deadline = Math.floor(Date.now() / 1000) + 900;
  const noteNonce = Date.now();
  const intentReq = {
    userAddress: wallet.address,
    inputAssetID: inputAssetId,
    outputAssetID: outputAssetId(tokenOut),
    amountIn: swapAmountBn.toString(),
    minAmountOut: minOut,
    nonce: String(noteNonce),
    nullifier: nullifierHex,
    deadline,
  };
  const intentRes = await requestJson("POST", `${API_URL}/intent`, intentReq);
  if (intentRes.status !== 200) throw new Error(`intent ${intentRes.status} ${intentRes.raw}`);
  const { intentId, intent, domain, types } = intentRes.json;
  const signPayload = {
    user: intent.userAddress,
    inputAssetID: intent.inputAssetID,
    outputAssetID: intent.outputAssetID,
    amountIn: intent.amountIn,
    minAmountOut: intent.minAmountOut,
    deadline: intent.deadline,
    nonce: intent.nonce,
    nullifier: intent.nullifier,
  };
  const intentSig = await wallet.signTypedData(domain, types || {}, signPayload);

  const swapBlinding = String(BigInt("0x" + crypto.randomBytes(16).toString("hex")));
  const changeBlinding = String(BigInt("0x" + crypto.randomBytes(16).toString("hex")));
  const proofBody = {
    inputNote: {
      assetID: notePayload.assetID,
      amount: notePayload.amount,
      blindingFactor: notePayload.blindingFactor,
      ownerPublicKey: notePayload.ownerPublicKey,
      nullifier: nullifierHex,
      commitment: commitmentDecDeposit,
    },
    outputNoteSwap: {
      assetID: outputAssetId(tokenOut),
      amount: outAmt,
      blindingFactor: swapBlinding,
      commitment: "0",
    },
    outputNoteChange: {
      assetID: notePayload.assetID,
      amount: "0",
      blindingFactor: changeBlinding,
      commitment: "0",
    },
    merkleRoot: merkle.merkleRoot,
    merklePath: merkle.merklePath,
    merklePathIndices: merkle.merklePathIndices,
    swapAmount: swapAmountBn.toString(),
    minOutputAmount: minOut,
    protocolFee,
    gasRefund,
  };
  const gen = await requestJson("POST", `${API_URL}/swap/generate-proof`, proofBody);
  if (gen.status !== 200) throw new Error(`generate-proof ${gen.status} ${gen.raw}`);
  const swapData = {
    proof: gen.json.proof,
    publicInputs: gen.json.publicInputs,
    swapParams: {
      tokenIn: inputAssetId === 0 ? ethers.ZeroAddress : tokenIn,
      tokenOut: String(tokenOut).toLowerCase() === ethers.ZeroAddress.toLowerCase() ? wbnb : tokenOut,
      amountIn: swapAmountBn.toString(),
      minAmountOut: minOut,
      fee: Number(quote.routeParams?.feeTier || 2500),
      sqrtPriceLimitX96: String(quote.routeParams?.sqrtPriceLimitX96 || 0),
      path: quote.routeParams?.path || "0x",
    },
    encryptedPayload: "0x",
  };

  const swapPayload = { intentId, intent, intentSig, swapData };
  const swapOut = encryptedEnvelopeRequired
    ? await requestJson("POST", `${API_URL}/swap/encrypted`, { envelope: await encryptRelayEnvelope(API_URL, swapPayload) })
    : await requestJson("POST", `${API_URL}/swap`, swapPayload);
  if (swapOut.status !== 200) throw new Error(`swap ${swapOut.status} ${swapOut.raw}`);
  console.log("[e2e] swap OK tx", swapOut.json?.txHash || swapOut.json);
  const afterSwapNotes = await fetchUsableNotes(API_URL, wallet.address);
  if ((afterSwapNotes.count || 0) < 1) {
    throw new Error("swap assertion failed: /notes returned no usable note");
  }
  assertNotesPinnedToFrozenConfig(afterSwapNotes, cfg.json);

  const postSwapWaitMs = Number(process.env.E2E_POST_SWAP_WAIT_MS || 3000);
  if (postSwapWaitMs > 0) {
    console.log("[e2e] waiting ms after swap (merkle / RPC sync)", postSwapWaitMs);
    await new Promise((r) => setTimeout(r, postSwapWaitMs));
  }

  if (String(process.env.E2E_SKIP_WITHDRAW || "").toLowerCase() === "true") {
    console.log("\n[e2e] E2E_SKIP_WITHDRAW=true — stopping after successful swap.");
    process.exit(0);
  }

  const piSwap = gen.json.publicInputs;
  const changeCommitHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(String(piSwap.outputCommitmentChange))), 32);
  const changeAmountStr = String(piSwap.changeAmount);
  const changeCommitDec = String(BigInt(String(piSwap.outputCommitmentChange)));
  const changeNoteForWithdraw = {
    version: 1,
    assetID: Number(piSwap.outputAssetIDChange),
    amount: changeAmountStr,
    blindingFactor: changeBlinding,
    ownerPublicKey: notePayload.ownerPublicKey,
    commitmentDecimal: changeCommitDec,
    commitmentHex: changeCommitHex,
  };
  const merkleChange = await pollMerkle(changeNoteForWithdraw.commitmentHex);
  const nullifierChange = computeNullifier(changeCommitHex, notePayload.ownerPublicKey);
  const nullifierChangeHex = `0x${nullifierChange.toString(16).padStart(64, "0")}`;

  const withdrawPayout = String(process.env.E2E_WITHDRAW_PAYOUT_WEI || "2500000000000000");
  const protocolFeeW = String(process.env.E2E_PROTOCOL_FEE_WEI || "800000000000000");
  const gasRefundW = String(process.env.E2E_GAS_REFUND_WEI || "400000000000000");
  const changeWei = BigInt(changeAmountStr) - BigInt(withdrawPayout) - BigInt(protocolFeeW) - BigInt(gasRefundW);
  if (changeWei <= 0n) {
    throw new Error(
      "withdraw conservation from swap change note failed: increase E2E_RESERVE_CHANGE_AFTER_SWAP_WEI / deposit, or lower E2E_WITHDRAW_PAYOUT_WEI and withdraw fees."
    );
  }

  const changeBlindingW = String(BigInt("0x" + crypto.randomBytes(16).toString("hex")));
  const wProofBody = {
    inputNote: {
      assetID: changeNoteForWithdraw.assetID,
      amount: changeNoteForWithdraw.amount,
      blindingFactor: changeNoteForWithdraw.blindingFactor,
      ownerPublicKey: changeNoteForWithdraw.ownerPublicKey,
      nullifier: nullifierChangeHex,
      commitment: changeCommitDec,
    },
    outputNoteChange: {
      assetID: changeNoteForWithdraw.assetID,
      amount: changeWei.toString(),
      blindingFactor: changeBlindingW,
      commitment: "0",
    },
    merkleRoot: merkleChange.merkleRoot,
    merklePath: merkleChange.merklePath,
    merklePathIndices: merkleChange.merklePathIndices,
    protocolFee: protocolFeeW,
    gasRefund: gasRefundW,
    withdrawAmount: withdrawPayout,
  };
  const wgen = await requestJson("POST", `${API_URL}/withdraw/generate-proof`, wProofBody);
  if (wgen.status !== 200) throw new Error(`withdraw generate-proof ${wgen.status} ${wgen.raw}`);

  const withdrawData = {
    proof: wgen.json.proof,
    publicInputs: wgen.json.publicInputs,
    recipient: wallet.address,
    ownerAddress: wallet.address.toLowerCase(),
    noteHints: {
      change: {
        assetId: notePayload.assetID,
        amount: changeWei.toString(),
        blindingFactor: changeBlindingW,
        ownerPublicKey: notePayload.ownerPublicKey,
      },
    },
    encryptedPayload: "0x",
  };
  const withdrawPayload = { withdrawData };
  const wdOut = encryptedEnvelopeRequired
    ? await requestJson("POST", `${API_URL}/withdraw/encrypted`, { envelope: await encryptRelayEnvelope(API_URL, withdrawPayload) })
    : await requestJson("POST", `${API_URL}/withdraw`, withdrawPayload);
  if (wdOut.status !== 200) throw new Error(`withdraw ${wdOut.status} ${wdOut.raw}`);
  console.log("[e2e] withdraw OK tx", wdOut.json?.txHash || wdOut.json);
  const afterWithdrawNotes = await fetchUsableNotes(API_URL, wallet.address);
  assertNotesPinnedToFrozenConfig(afterWithdrawNotes, cfg.json);

  const secondWd = encryptedEnvelopeRequired
    ? await requestJson("POST", `${API_URL}/withdraw/encrypted`, { envelope: await encryptRelayEnvelope(API_URL, withdrawPayload) })
    : await requestJson("POST", `${API_URL}/withdraw`, withdrawPayload);
  if (secondWd.status === 200) {
    throw new Error("second withdraw negative test failed: second withdraw unexpectedly succeeded");
  }
  const secondErr = String(secondWd.json?.error || secondWd.text || "");
  if (!/spent|nullifier|already/i.test(secondErr)) {
    throw new Error(`second withdraw negative test failed: unexpected error ${secondErr}`);
  }
  console.log("[e2e] second withdraw negative test OK");

  console.log("\n[e2e] MVP flow completed (deposit → swap → withdraw + second-withdraw negative).");
}

main().catch((e) => {
  console.error("[e2e] FAILED:", e.message || e);
  process.exit(1);
});
