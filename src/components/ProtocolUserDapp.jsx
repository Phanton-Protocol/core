import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { loadVault, saveVault } from "../lib/noteVault";
import { relayerFetchJson, setRuntimeRelayerBases } from "../lib/relayerHttp";
import { canUseClientProver, generateSwapProofClient } from "../lib/clientProver";
import { encryptForRelayer } from "../lib/relayEnvelope";
import { API_URLS, CLIENT_PROVER_WASM_URL, CLIENT_PROVER_ZKEY_URL } from "../config";
import { nullifierToBytes32Hex, SHADOW_SWEEP_GAS_BUFFER_WEI_DEFAULT } from "../lib/relayerDefaults.js";
import {
  addressToOwnerPublicKey,
  commitmentToBytes32,
  noteCommitment,
  noteNullifier,
  randomFieldElementString,
} from "../lib/noteCrypto.js";

function shorten(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function stringifyErr(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object") {
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  }
  return String(x);
}

/** Build a v1 vault note payload from swap hints + on-chain commitment (decimal string or bytes32 hex). */
function buildVaultNoteFromSwapHint({ assetId, amountStr, blindingFactor, ownerPublicKey, commitmentStr }) {
  const raw = String(commitmentStr || "").trim();
  if (!raw) throw new Error("Missing commitment for vault note");
  let cDec;
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    cDec = ethers.toBigInt(raw).toString();
  } else {
    cDec = raw;
  }
  const commitmentHex = commitmentToBytes32(cDec);
  const recomputed = noteCommitment(assetId, amountStr, blindingFactor, ownerPublicKey).toString();
  if (recomputed !== cDec) {
    throw new Error("Vault note commitment mismatch — swap hints do not match on-chain commitment");
  }
  return {
    version: 1,
    assetID: assetId,
    amount: String(amountStr),
    blindingFactor: String(blindingFactor),
    ownerPublicKey: String(ownerPublicKey),
    commitmentDecimal: cDec,
    commitmentHex,
  };
}

function isNonZeroCommitmentStr(c) {
  const s = String(c ?? "").trim();
  if (!s) return false;
  if (/^0x[0-9a-fA-F]{64}$/i.test(s)) {
    try {
      return ethers.toBigInt(s) !== 0n;
    } catch {
      return false;
    }
  }
  try {
    return BigInt(s) !== 0n;
  } catch {
    return false;
  }
}

/** Prefer API `out.commitments`, else fall back to proof public inputs (decimal or bytes32). */
function resolveSwapOutputCommitments(out, publicInputs) {
  const fromApiSwap = out?.commitments?.swap;
  const fromApiChange = out?.commitments?.change;
  const piSwap = publicInputs?.outputCommitmentSwap;
  const piChange = publicInputs?.outputCommitmentChange;
  const swap = isNonZeroCommitmentStr(fromApiSwap) ? fromApiSwap : piSwap;
  const change = isNonZeroCommitmentStr(fromApiChange) ? fromApiChange : piChange;
  return { swap, change };
}

/** Normalize circuit public-input commitment (decimal string or 0x hex) to vault `commitmentHex` form. */
function publicInputCommitmentToVaultHex(c) {
  const raw = String(c ?? "").trim();
  if (!raw) return "";
  try {
    if (/^0x[0-9a-fA-F]{64}$/i.test(raw)) {
      return String(ethers.zeroPadValue(raw, 32)).toLowerCase();
    }
    return String(commitmentToBytes32(raw)).toLowerCase();
  } catch {
    return "";
  }
}

/** Convert relayer `/notes` canonical `note.v1` into the local vault payload shape used by Swap/Withdraw. */
function relayerCanonicalNoteToVaultPayload(note) {
  if (!note || typeof note !== "object") return null;
  if (Number(note.version) === 1 && note.commitmentHex && note.commitmentDecimal) {
    return note;
  }
  const schema = String(note.schema || "");
  const commitmentHexRaw = String(note.commitment || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitmentHexRaw)) return null;
  if (schema && schema !== "note.v1") return null;

  const assetIDRaw = note.assetID ?? note.assetId;
  if (assetIDRaw == null) return null;
  const assetID = Number(assetIDRaw);
  if (!Number.isFinite(assetID)) return null;

  const amount = String(note.amount ?? "");
  const blindingFactor = String(note.blindingFactor ?? "");
  const ownerPublicKey = String(note.ownerPublicKey ?? "");
  if (!amount || !blindingFactor || !ownerPublicKey) return null;

  const commitmentHex = commitmentToBytes32(ethers.toBigInt(commitmentHexRaw).toString());
  const commitmentDecimal = ethers.toBigInt(commitmentHexRaw).toString();
  const recomputed = noteCommitment(assetID, amount, blindingFactor, ownerPublicKey).toString();
  if (recomputed !== commitmentDecimal) return null;

  return {
    version: 1,
    assetID,
    amount,
    blindingFactor,
    ownerPublicKey,
    commitmentDecimal,
    commitmentHex,
  };
}

async function fetchJson(url, opts) {
  const ownerAddress = opts?.ownerAddress;
  const { ownerAddress: _dropOwner, ...restOpts } = opts || {};
  const headers = {
    "content-type": "application/json",
    ...(restOpts?.headers || {}),
    ...(ownerAddress ? { "x-owner-address": String(ownerAddress).trim().toLowerCase() } : {}),
  };
  const fetchOpts = { ...restOpts, headers };
  let path = String(url || "");
  try {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    }
  } catch {
    path = String(url || "");
  }
  try {
    const { data } = await relayerFetchJson(path, fetchOpts, {
      overrideBasesRaw: localStorage.getItem("phantom_api") || "",
    });
    return data;
  } catch (err) {
    const msg = err?.message || String(err);
    throw new Error(`Relayer request failed (${url}): ${msg}. Check relayer endpoints and health.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const WBNB_BSC_TESTNET = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
const WBNB_BSC_MAINNET = "0xbb4CdB9Cbd36B01bD1cBaEBF2De08d9173bc095c";
const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
const FALLBACK_GAS_REFUND_WEI = ethers.parseEther("0.002").toString();
/** ShieldedPool requires changeAmount != 0 (PoolErr 19): note = swap + change + protocolFee + gasRefund */
const MIN_SWAP_CHANGE_WEI = 1n;
const SLIPPAGE_PRESETS_BPS = [50, 100, 250, 500];
/** Pending deposit note when auto-save failed (vault locked or save error). Cleared after successful vault write. */
const PENDING_VAULT_NOTE_KEY = "phantom_pending_vault_note";
const PC = {
  bg: "#14141c",
  card: "#18181f",
  border: "rgba(255,255,255,0.12)",
  teal: "#9ea4aa",
  text: "#ffffff",
  muted: "rgba(255,255,255,0.68)",
};

const QUOTE_SOURCE_LABEL = {
  pancake_v3_quoter_v2: "PancakeSwap V3 QuoterV2 (official)",
  swap_adaptor: "Swap adaptor (on-chain)",
  pancake_v2_router: "PancakeSwap V2 router (on-chain)",
  dex_oracle: "Oracle / price estimate",
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

/** Must match `ethers.getAddress` / pool config (EIP-55). Wrong checksum breaks quotes in the relayer. */
const USDT_BSC_TESTNET = "0x7eF95A0FE8A5f4f9C1824fbF6656e2f95fa6Bf13";

const DEFAULT_TOKEN_LIST = [
  { symbol: "BNB", address: ethers.ZeroAddress },
  { symbol: "BUSD", address: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
  { symbol: "USDT", address: USDT_BSC_TESTNET },
];
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const TOKEN_OPTIONS = [
  { label: "BNB (native)", value: ethers.ZeroAddress },
  { label: "BUSD", value: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
  { label: "USDT", value: USDT_BSC_TESTNET },
  { label: "Custom address", value: "__custom__" },
];

/** Resolve asset ID from relayer `/config` `assets` (on-chain registry via deploy config). Never guess (no silent BUSD). */
function getAssetIdForToken(tokenAddress, relayerConfig) {
  const normalized = String(tokenAddress || "").toLowerCase();
  if (normalized === ethers.ZeroAddress.toLowerCase()) return 0;
  const assets = Array.isArray(relayerConfig?.assets) ? relayerConfig.assets : [];
  if (assets.length === 0) {
    throw new Error(
      "Relayer /config has no assets[] — cannot map token to asset ID. Ensure the relayer loads chain config."
    );
  }
  const hit = assets.find((a) => a?.address && String(a.address).toLowerCase() === normalized);
  if (hit != null && hit.assetId != null && !Number.isNaN(Number(hit.assetId))) {
    return Number(hit.assetId);
  }
  throw new Error(
    `Unknown token for asset ID (not listed in relayer /config assets): ${tokenAddress}. Use a configured asset or add this token to the pool config.`
  );
}

function spendableNoteEntries(vaultData, inputToken, relayerConfig) {
  if (!relayerConfig?.assets?.length) return [];
  let aid;
  try {
    aid = getAssetIdForToken(inputToken, relayerConfig);
  } catch {
    return [];
  }
  const notes = vaultData?.notes || [];
  const out = [];
  notes.forEach((n, vaultIdx) => {
    const raw = n.payload ?? n;
    const verOk = Number(raw?.version) === 1;
    if (verOk && Number(raw.assetID) === aid) out.push({ vaultIdx, note: raw });
  });
  return out;
}

function canonicalWbnb(chainId) {
  return Number(chainId) === 56 ? WBNB_BSC_MAINNET : WBNB_BSC_TESTNET;
}

function formatTokenAmount(value, maxFrac = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function mergeSwapData(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const out = { ...base, ...overlay };
  if (overlay.proof && typeof overlay.proof === "object") {
    out.proof = { ...base.proof, ...overlay.proof };
  }
  if (overlay.publicInputs && typeof overlay.publicInputs === "object") {
    out.publicInputs = { ...base.publicInputs, ...overlay.publicInputs };
  }
  if (overlay.swapParams && typeof overlay.swapParams === "object") {
    out.swapParams = { ...base.swapParams, ...overlay.swapParams };
  }
  return out;
}

function buildDefaultSwapData(intentForm, chainId, relayerConfig) {
  const zb = ethers.ZeroHash;
  const wbnb = canonicalWbnb(chainId);
  const tokenIn =
    String(intentForm.inputToken || ethers.ZeroAddress).toLowerCase() === ethers.ZeroAddress.toLowerCase()
      ? wbnb
      : intentForm.inputToken;
  const tokenOut =
    String(intentForm.outputToken || ethers.ZeroAddress).toLowerCase() === ethers.ZeroAddress.toLowerCase()
      ? wbnb
      : intentForm.outputToken;
  let amountInWei = "0";
  try {
    amountInWei = ethers.parseUnits(String(intentForm.inputAmount || "0"), 18).toString();
  } catch {
    amountInWei = "0";
  }
  const minOut = String(intentForm.minOutputAmount || "0");
  const merklePath = Array(10).fill("0");
  const merklePathIndices = Array(10).fill("0");
  return {
    proof: {
      a: [zb, zb],
      b: [
        [zb, zb],
        [zb, zb],
      ],
      c: [zb, zb],
    },
    publicInputs: {
      nullifier: zb,
      inputCommitment: zb,
      outputCommitmentSwap: zb,
      outputCommitmentChange: zb,
      merkleRoot: zb,
      inputAssetID: getAssetIdForToken(intentForm.inputToken, relayerConfig),
      outputAssetIDSwap: getAssetIdForToken(intentForm.outputToken, relayerConfig),
      outputAssetIDChange: 0,
      inputAmount: amountInWei,
      swapAmount: amountInWei,
      changeAmount: "0",
      outputAmountSwap: minOut,
      minOutputAmountSwap: minOut,
      gasRefund: String(intentForm.gasRefund || "0"),
      protocolFee: String(intentForm.protocolFee || "0"),
      merklePath,
      merklePathIndices,
    },
    swapParams: {
      tokenIn,
      tokenOut,
      amountIn: amountInWei,
      minAmountOut: minOut,
      fee: 2500,
      sqrtPriceLimitX96: 0,
      path: "0x",
    },
    encryptedPayload: "0x",
  };
}

function getExplorerTxBase(chainId) {
  if (Number(chainId) === 97) return "https://testnet.bscscan.com/tx/";
  if (Number(chainId) === 56) return "https://bscscan.com/tx/";
  return "";
}

export default function ProtocolUserDapp({ uiVariant = "default" }) {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem("phantom_api") || API_URLS.join(", "));
  const base = useMemo(() => (apiBase || "").replace(/\/$/, "").trim(), [apiBase]);
  const [cfg, setCfg] = useState(null);
  const [health, setHealth] = useState(null);
  const [cfgErr, setCfgErr] = useState(null);

  const [wallet, setWallet] = useState({ address: null, provider: null, signer: null });
  const [walletChainId, setWalletChainId] = useState(null);
  const [connectError, setConnectError] = useState(null);

  const [vault, setVault] = useState({ unlocked: false, key: null, data: { notes: [], updatedAt: null } });
  const vaultRef = useRef(vault);
  useEffect(() => {
    vaultRef.current = vault;
  }, [vault]);
  /** When true, do not overwrite withdraw "Amount" from computed max (user typed a custom payout). */
  const withdrawAmountUserEditedRef = useRef(false);
  const [vaultError, setVaultError] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [tab, setTab] = useState(uiVariant === "trade" ? "deposit" : "swap");
  const [internalMatchMode, setInternalMatchMode] = useState("create");
  const [lastResult, setLastResult] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [depositBlinding, setDepositBlinding] = useState(() => randomFieldElementString());
  const [depositForm, setDepositForm] = useState({
    token: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7",
    amount: "",
    assetID: 0,
    commitment: ethers.ZeroHash,
    deadlineSec: 900,
  });

  const [intentForm, setIntentForm] = useState({
    inputToken: ethers.ZeroAddress,
    outputToken: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7",
    inputAmount: "",
    minOutputAmount: "",
    protocolFee: "0",
    gasRefund: "0",
    deadlineSec: 900,
    nonce: "0",
    swapDataJson: "",
  });
  const [swapQuoteLoading, setSwapQuoteLoading] = useState(false);
  const [swapQuoteErr, setSwapQuoteErr] = useState(null);
  const [swapClampHint, setSwapClampHint] = useState("");
  const [swapExpectedLabel, setSwapExpectedLabel] = useState("");
  const [swapMinLabel, setSwapMinLabel] = useState("");
  const [swapSlippageBps, setSwapSlippageBps] = useState(DEFAULT_SWAP_SLIPPAGE_BPS);
  const [swapLastQuote, setSwapLastQuote] = useState(null);
  const [swapProofBusy, setSwapProofBusy] = useState(false);
  const [swapFlowBusy, setSwapFlowBusy] = useState(false);
  const [swapFlowStage, setSwapFlowStage] = useState("");
  const [swapSpinnerTick, setSwapSpinnerTick] = useState(0);
  const [withdrawProofBusy, setWithdrawProofBusy] = useState(false);
  const [clientProverReady, setClientProverReady] = useState(false);

  const spendable = useMemo(
    () => spendableNoteEntries(vault.data, intentForm.inputToken, cfg),
    [vault.data, intentForm.inputToken, cfg]
  );
  const autoSpendEntry = useMemo(() => {
    if (!spendable.length) return null;
    let desired = 0n;
    let fee = 0n;
    let gas = 0n;
    try {
      desired = ethers.parseUnits(String(intentForm.inputAmount || "0"), 18);
    } catch {
      desired = 0n;
    }
    try {
      fee = BigInt(String(intentForm.protocolFee || "0"));
    } catch {
      fee = 0n;
    }
    try {
      gas = BigInt(String(intentForm.gasRefund || "0"));
    } catch {
      gas = 0n;
    }
    const eligible = spendable
      .map((entry) => {
        let noteWei = 0n;
        try {
          noteWei = BigInt(String(entry?.note?.amount || "0"));
        } catch {
          noteWei = 0n;
        }
        const maxSwap = noteWei - fee - gas - MIN_SWAP_CHANGE_WEI;
        return { entry, noteWei, maxSwap };
      })
      .filter((row) => row.maxSwap > 0n);
    if (!eligible.length) return spendable[0];
    const enough = eligible
      .filter((row) => desired <= 0n || row.maxSwap >= desired)
      .sort((a, b) => (a.noteWei < b.noteWei ? -1 : 1));
    if (enough.length) return enough[0].entry;
    const largest = eligible.sort((a, b) => (a.maxSwap > b.maxSwap ? -1 : 1))[0];
    return largest?.entry || spendable[0];
  }, [spendable, intentForm.inputAmount, intentForm.protocolFee, intentForm.gasRefund]);

  const [withdrawForm, setWithdrawForm] = useState({
    token: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7",
    amount: "",
    recipient: "",
    protocolFee: "0",
    gasRefund: ethers.parseEther("0.002").toString(),
    withdrawDataJson: "",
  });
  const withdrawSpendable = useMemo(
    () => spendableNoteEntries(vault.data, withdrawForm.token, cfg),
    [vault.data, withdrawForm.token, cfg]
  );
  const withdrawAdvancedJson = useMemo(
    () => String(withdrawForm.withdrawDataJson || "").trim(),
    [withdrawForm.withdrawDataJson]
  );
  /** Largest payout `amountWei` such that change = note − payout − fee − gas > 0 (same 1-wei floor as swap). */
  const withdrawMaxPayoutWei = useMemo(() => {
    if (!withdrawSpendable.length) return null;
    try {
      const note = withdrawSpendable[0].note;
      const inputWei = BigInt(note.amount);
      let protocolFee = 0n;
      let gasRefund = 0n;
      try {
        protocolFee = BigInt(String(withdrawForm.protocolFee || "0"));
      } catch {
        protocolFee = 0n;
      }
      try {
        gasRefund = BigInt(String(withdrawForm.gasRefund || "0"));
      } catch {
        gasRefund = 0n;
      }
      const max = inputWei - protocolFee - gasRefund - MIN_SWAP_CHANGE_WEI;
      return max > 0n ? max : 0n;
    } catch {
      return null;
    }
  }, [withdrawSpendable, withdrawForm.protocolFee, withdrawForm.gasRefund]);

  useEffect(() => {
    if (withdrawAdvancedJson) return;
    if (withdrawMaxPayoutWei == null || withdrawMaxPayoutWei <= 0n) return;
    if (withdrawAmountUserEditedRef.current) return;
    const nextAmt = ethers.formatUnits(withdrawMaxPayoutWei, 18);
    setWithdrawForm((f) => (f.amount === nextAmt ? f : { ...f, amount: nextAmt }));
  }, [withdrawMaxPayoutWei, withdrawAdvancedJson]);

  const [depositTokenChoice, setDepositTokenChoice] = useState(ethers.ZeroAddress);
  const [swapInputTokenChoice, setSwapInputTokenChoice] = useState(ethers.ZeroAddress);
  const [swapOutputTokenChoice, setSwapOutputTokenChoice] = useState("0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7");
  const [withdrawTokenChoice, setWithdrawTokenChoice] = useState("0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7");
  const [tokenList, setTokenList] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("phantom_tokens") || "[]");
      return [...DEFAULT_TOKEN_LIST, ...stored.filter((t) => t?.symbol && t?.address)];
    } catch {
      return DEFAULT_TOKEN_LIST;
    }
  });
  const [importTokenSymbol, setImportTokenSymbol] = useState("");
  const [importTokenAddress, setImportTokenAddress] = useState("");
  const [orderForm, setOrderForm] = useState({
    side: "sell",
    baseToken: "BNB",
    quoteToken: "BUSD",
    amount: "",
    price: "",
  });
  const [localOrders, setLocalOrders] = useState([]);

  useEffect(() => {
    localStorage.setItem("phantom_api", apiBase);
    setRuntimeRelayerBases(apiBase);
  }, [apiBase]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const ok = await canUseClientProver({
        wasmUrl: CLIENT_PROVER_WASM_URL,
        zkeyUrl: CLIENT_PROVER_ZKEY_URL,
      });
      if (mounted) setClientProverReady(ok);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const custom = tokenList.filter((t) => !DEFAULT_TOKEN_LIST.some((d) => d.address.toLowerCase() === t.address.toLowerCase()));
    localStorage.setItem("phantom_tokens", JSON.stringify(custom));
  }, [tokenList]);

  useEffect(() => {
    setDepositTokenChoice(depositForm.token);
  }, [depositForm.token]);

  useEffect(() => {
    setSwapInputTokenChoice(intentForm.inputToken);
  }, [intentForm.inputToken]);

  useEffect(() => {
    setSwapOutputTokenChoice(intentForm.outputToken);
  }, [intentForm.outputToken]);

  useEffect(() => {
    setWithdrawTokenChoice(withdrawForm.token);
  }, [withdrawForm.token]);

  useEffect(() => {
    if (!cfg?.assets?.length) return;
    try {
      const id = getAssetIdForToken(depositForm.token, cfg);
      setDepositForm((prev) => (prev.assetID === id ? prev : { ...prev, assetID: id }));
    } catch {
      /* unknown token vs /config assets — submitDeposit will error with a clear message */
    }
  }, [depositForm.token, cfg]);

  useEffect(() => {
    if (!wallet?.address) return;
    let amountWei;
    try {
      const amt = String(depositForm.amount || "").trim();
      if (!amt) return;
      amountWei = ethers.parseUnits(amt, 18);
    } catch {
      return;
    }
    if (amountWei <= 0n) return;
    if (!cfg?.assets?.length) return;
    const assetID = getAssetIdForToken(depositForm.token, cfg);
    const ownerPk = addressToOwnerPublicKey(wallet.address);
    const c = noteCommitment(assetID, amountWei.toString(), depositBlinding, ownerPk);
    const hex = commitmentToBytes32(c);
    setDepositForm((prev) => (prev.commitment === hex ? prev : { ...prev, commitment: hex }));
  }, [wallet?.address, depositForm.token, depositForm.amount, depositBlinding, cfg]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setCfgErr(null);
      try {
        if (!base) return;
        const [c, h] = await Promise.all([
          fetchJson(`${base}/config`),
          fetchJson(`${base}/health`),
        ]);
        if (!cancelled) {
          setCfg(c);
          setHealth(h);
        }
      } catch (e) {
        if (!cancelled) setCfgErr(stringifyErr(e?.message ?? e));
      }
    }
    run();
    const t = setInterval(run, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function run() {
      setSwapQuoteErr(null);
      setSwapExpectedLabel("");
      setSwapMinLabel("");
      const customJson = String(intentForm.swapDataJson || "").trim();
      let amt = String(intentForm.inputAmount || "").trim();
      if (cfg?.mode === "live" && !customJson && autoSpendEntry?.note) {
        try {
          const noteWei = BigInt(autoSpendEntry.note.amount);
          if (!amt || Number(amt) <= 0) {
            amt = ethers.formatUnits(noteWei, 18);
          } else {
            const want = ethers.parseUnits(amt, 18);
            if (want > noteWei) {
              amt = ethers.formatUnits(noteWei, 18);
            }
          }
        } catch {
          /* keep */
        }
      }
      if (!base || !cfg?.chainId) return;
      if (!amt || Number(amt) <= 0) {
        setSwapLastQuote(null);
        setIntentForm((p) => ({ ...p, minOutputAmount: "", protocolFee: "0", gasRefund: "0" }));
        return;
      }
      const wbnbQ = canonicalWbnb(cfg.chainId);
      const tokenIn = intentForm.inputToken && intentForm.inputToken.toLowerCase() !== ethers.ZeroAddress.toLowerCase()
        ? intentForm.inputToken
        : wbnbQ;
      const tokenOut = intentForm.outputToken && intentForm.outputToken.toLowerCase() !== ethers.ZeroAddress.toLowerCase()
        ? intentForm.outputToken
        : wbnbQ;
      if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
        setSwapLastQuote(null);
        setSwapQuoteErr(null);
        setSwapExpectedLabel("");
        setSwapMinLabel("");
        return;
      }
      const chainSlug = Number(cfg.chainId) === 97 ? "bsc-testnet" : "bsc";
      setSwapQuoteLoading(true);
      try {
        const amountWei = ethers.parseUnits(amt, 18).toString();
        const q = await fetchJson(`${base}/quote`, {
          method: "POST",
          body: JSON.stringify({
            tokenIn,
            tokenOut,
            amountIn: amountWei,
            tokenInDecimals: 18,
            tokenOutDecimals: 18,
            slippageBps: swapSlippageBps,
            chainSlug,
          }),
        });
        if (cancelled) return;
        let refund = String(q.suggestedGasRefundWei || "0");
        try {
          if (cfg?.mode === "live" && (!refund || BigInt(refund) === 0n)) {
            refund = FALLBACK_GAS_REFUND_WEI;
          }
        } catch {
          refund = cfg?.mode === "live" ? FALLBACK_GAS_REFUND_WEI : "0";
        }
        let protocolFeeStr = String(q.fees?.totalFee ?? "0");
        if (cfg?.mode === "live" && autoSpendEntry?.note && cfg?.assets?.length) {
          try {
            const noteWei = autoSpendEntry.note.amount;
            const aid = getAssetIdForToken(intentForm.inputToken, cfg);
            const feeRes = await fetchJson(`${base}/portfolio/swap-fee?inputAssetId=${aid}&amount=${noteWei}`);
            protocolFeeStr = String(feeRes.totalProtocolFee ?? protocolFeeStr);
          } catch {
            /* quote fees often 0; proof path still resolves fee on-chain */
          }
        }
        if (cfg?.mode === "live" && autoSpendEntry?.note) {
          try {
            const noteWei = BigInt(autoSpendEntry.note.amount);
            const feeBn = BigInt(protocolFeeStr);
            const gasBn = BigInt(refund);
            const maxSwapWei = noteWei - feeBn - gasBn - MIN_SWAP_CHANGE_WEI;
            if (maxSwapWei <= 0n) {
              setSwapLastQuote(null);
              setSwapQuoteErr(
                "This note is too small after protocol fee and gas refund — the pool always keeps a leftover change note. Deposit more or lower Gas refund (Advanced)."
              );
              return;
            }
            let wantWei;
            try {
              wantWei = ethers.parseUnits(amt, 18);
            } catch {
              wantWei = 0n;
            }
            if (wantWei > maxSwapWei) {
              setSwapClampHint(
                "Swap amount was limited so part of the note stays as change (required by the pool)."
              );
              setIntentForm((p) => ({
                ...p,
                inputAmount: ethers.formatUnits(maxSwapWei, 18),
                minOutputAmount: "",
                protocolFee: protocolFeeStr,
                gasRefund: refund,
              }));
              return;
            }
          } catch {
            /* ignore clamp if BigInt/parse fails */
          }
        }
        setSwapClampHint("");
        setSwapLastQuote(q);
        setIntentForm((p) => ({
          ...p,
          minOutputAmount: String(q.minAmountOut || "0"),
          protocolFee: protocolFeeStr,
          gasRefund: refund,
        }));
        setSwapExpectedLabel(`${ethers.formatUnits(q.amountOut || "0", 18)}`);
        setSwapMinLabel(`${ethers.formatUnits(q.minAmountOut || "0", 18)}`);
      } catch (e) {
        if (!cancelled) setSwapQuoteErr(stringifyErr(e?.message ?? e));
      } finally {
        if (!cancelled) setSwapQuoteLoading(false);
      }
    }
    timer = setTimeout(run, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, cfg?.chainId, cfg?.mode, cfg?.assets?.length, intentForm.inputToken, intentForm.outputToken, intentForm.inputAmount, intentForm.swapDataJson, swapSlippageBps, autoSpendEntry]);

  async function connect() {
    setConnectError(null);
    setActionError(null);
    setActionSuccess(null);
    setVaultError(null);
    try {
      if (!window.ethereum) throw new Error("No injected wallet found (MetaMask).");
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const activeChainHex = await provider.send("eth_chainId", []);
      setWalletChainId(Number.parseInt(activeChainHex, 16));
      setWallet({ provider, signer, address });
    } catch (e) {
      setConnectError(e.message || String(e));
    }
  }

  function disconnect() {
    setConnectError(null);
    setActionError(null);
    setActionSuccess(null);
    setVaultError(null);
    setWallet({ address: null, provider: null, signer: null });
    setWalletChainId(null);
    setVault({ unlocked: false, key: null, data: { notes: [], updatedAt: null } });
  }

  async function flushPendingVaultNoteAfterLoad(loaded) {
    try {
      const raw = sessionStorage.getItem(PENDING_VAULT_NOTE_KEY);
      if (!raw) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
        return null;
      }
      const sn = parsed.payload;
      if (!sn || typeof sn !== "object" || !sn.commitmentHex) {
        sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
        return null;
      }
      const hex = String(sn.commitmentHex).toLowerCase();
      const dup = (loaded.data?.notes || []).some((entry) => {
        const p = entry?.payload;
        if (!p || typeof p !== "object") return false;
        const ph = String(p.commitmentHex || "").toLowerCase();
        if (hex && ph && ph === hex) return true;
        return String(p.blindingFactor) === String(sn.blindingFactor) && String(p.amount) === String(sn.amount);
      });
      if (dup) {
        sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
        return null;
      }
      const next = {
        notes: [{ t: Date.now(), payload: sn }, ...(loaded.data?.notes || [])].slice(0, 200),
        updatedAt: Date.now(),
      };
      await saveVault({ key: loaded.key, data: next });
      sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
      return { key: loaded.key, data: next };
    } catch (e) {
      console.warn("[vault] flush pending note failed", e);
      return null;
    }
  }

  async function mergeRelayerBackedNotesIntoVault({ key, data, ownerAddress }) {
    if (!key || !data || !ownerAddress || !base) return { key, data, imported: 0 };
    let list = [];
    try {
      const res = await fetchJson(`${base}/notes?limit=200`, { ownerAddress });
      list = Array.isArray(res?.notes) ? res.notes : [];
    } catch {
      return { key, data, imported: 0 };
    }
    let notes = Array.isArray(data?.notes) ? [...data.notes] : [];
    const haveHex = new Set(
      notes
        .map((e) => String(e?.payload?.commitmentHex || "").toLowerCase())
        .filter(Boolean)
    );
    let imported = 0;
    for (const row of list) {
      const payload = relayerCanonicalNoteToVaultPayload(row?.note);
      if (!payload) continue;
      const hx = String(payload.commitmentHex || "").toLowerCase();
      if (!hx || haveHex.has(hx)) continue;
      notes.unshift({ t: Date.now(), payload });
      haveHex.add(hx);
      imported += 1;
    }
    if (!imported) return { key, data, imported: 0 };
    notes = notes.slice(0, 200);
    const nextData = { ...data, notes, updatedAt: new Date().toISOString() };
    await saveVault({ key, data: nextData });
    return { key, data: nextData, imported };
  }

  async function unlockVault() {
    setVaultError(null);
    if (!wallet.signer) {
      setVaultError("Connect wallet first.");
      return null;
    }
    try {
      // Must be stable for the same wallet + site + chain: key is SHA256(signature). A changing
      // timestamp made every signature different, so decrypt always failed after the first save.
      let chainLine = "";
      try {
        const hex = await wallet.provider.send("eth_chainId", []);
        chainLine = `\nChain ID: ${Number.parseInt(hex, 16)}`;
      } catch {
        /* ignore */
      }
      const msg = `Unlock Phantom Note Vault\n\nDomain: ${window.location.host}${chainLine}`;
      const signature = await wallet.signer.signMessage(msg);
      const loaded = await loadVault({ signature });
      const flushed = await flushPendingVaultNoteAfterLoad(loaded);
      const merged = flushed ?? { key: loaded.key, data: loaded.data };
      const remote = await mergeRelayerBackedNotesIntoVault({
        key: merged.key,
        data: merged.data,
        ownerAddress: wallet.address,
      });
      const finalMerged = remote.imported > 0 ? { key: remote.key, data: remote.data } : merged;
      setVault({ unlocked: true, key: finalMerged.key, data: finalMerged.data });
      if (flushed) {
        setActionSuccess("Restored a pending deposit note into your vault.");
      } else if (remote.imported > 0) {
        setActionSuccess(
          `Imported ${remote.imported} note(s) from the relayer backup (deposits / swap outputs). You can withdraw if the asset matches.`
        );
      }
      return finalMerged;
    } catch (e) {
      setVaultError(e.message || String(e));
      return null;
    }
  }

  async function addNoteToVault() {
    setVaultError(null);
    try {
      if (!vault.unlocked || !vault.key) throw new Error("Vault is locked.");
      const trimmed = noteDraft.trim();
      if (!trimmed) throw new Error("Paste a note / payload JSON first.");
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { parsed = { raw: trimmed }; }
      const next = {
        notes: [{ t: Date.now(), payload: parsed }, ...(vault.data?.notes || [])].slice(0, 200),
        updatedAt: Date.now(),
      };
      await saveVault({ key: vault.key, data: next });
      setVault({ ...vault, data: next });
      setNoteDraft("");
    } catch (e) {
      setVaultError(e.message || String(e));
    }
  }

  const canTransact = (cfg?.mode === "live") && !!wallet?.signer;
  const swapNeedsWallet = cfg?.mode === "live" && !wallet?.signer;
  const canWrite = !!wallet?.signer && !!cfg?.chainId;
  const swapGasRefundOk =
    cfg?.mode !== "live" ||
    (() => {
      try {
        return BigInt(String(intentForm.gasRefund || "0")) > 0n;
      } catch {
        return false;
      }
    })();

  function flipSwapTokens() {
    const inT = intentForm.inputToken;
    const outT = intentForm.outputToken;
    setIntentForm((p) => ({ ...p, inputToken: outT, outputToken: inT }));
    if (outT === "__custom__") setSwapInputTokenChoice("__custom__");
    else setSwapInputTokenChoice(outT);
    if (inT === "__custom__") setSwapOutputTokenChoice("__custom__");
    else setSwapOutputTokenChoice(inT);
  }

  async function ensureCorrectChain() {
    if (!wallet.provider || !cfg?.chainId) return null;
    const expectedHex = `0x${Number(cfg.chainId).toString(16)}`;
    const activeHex = await wallet.provider.send("eth_chainId", []);
    let activeChainNum = Number.parseInt(activeHex, 16);
    setWalletChainId(activeChainNum);
    if (activeHex.toLowerCase() === expectedHex.toLowerCase()) return activeChainNum;
    try {
      await wallet.provider.send("wallet_switchEthereumChain", [{ chainId: expectedHex }]);
      const nextActiveHex = await wallet.provider.send("eth_chainId", []);
      activeChainNum = Number.parseInt(nextActiveHex, 16);
      setWalletChainId(activeChainNum);
      return activeChainNum;
    } catch (switchErr) {
      const code = switchErr?.code ?? switchErr?.error?.code;
      if (code === 4902 && Number(cfg.chainId) === 97) {
        await wallet.provider.send("wallet_addEthereumChain", [{
          chainId: "0x61",
          chainName: "BNB Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
          blockExplorerUrls: ["https://testnet.bscscan.com"],
        }]);
        const addedActiveHex = await wallet.provider.send("eth_chainId", []);
        activeChainNum = Number.parseInt(addedActiveHex, 16);
        setWalletChainId(activeChainNum);
        return activeChainNum;
      } else {
        throw new Error(`Wrong network in wallet. Switch to chain ${cfg.chainId} and try again.`);
      }
    }
  }

  async function submitDeposit() {
    setActionError(null);
    setActionSuccess(null);
    setLastResult(null);
    try {
      if (!wallet.signer) throw new Error("Connect wallet first.");
      if (!cfg?.chainId || !cfg?.addresses?.shieldedPool) throw new Error("Backend config not loaded.");
      await fetchJson(`${base}/health`);
      const activeChain = await ensureCorrectChain();
      if (activeChain && Number(activeChain) !== Number(cfg.chainId)) {
        throw new Error(`Wallet is on chain ${activeChain}, but backend expects ${cfg.chainId}.`);
      }

      let depositTxHash = null;
      const amountWei = ethers.parseUnits(String(depositForm.amount || "0"), 18);
      const assetID = Number(getAssetIdForToken(depositForm.token, cfg));
      const ownerPk = addressToOwnerPublicKey(wallet.address);
      const c = noteCommitment(assetID, amountWei.toString(), depositBlinding, ownerPk);
      const suggestedVaultNote = {
        version: 1,
        assetID,
        amount: amountWei.toString(),
        blindingFactor: depositBlinding,
        ownerPublicKey: ownerPk,
        commitmentDecimal: c.toString(),
        commitmentHex: depositForm.commitment,
      };
      const deadline = Math.floor(Date.now() / 1000) + Number(depositForm.deadlineSec || 900);
      const domain = {
        name: "ShadowDeFiRelayer",
        version: "1",
        chainId: Number(cfg.chainId),
        verifyingContract: cfg.addresses.shieldedPool,
      };
      const message = {
        depositor: wallet.address,
        token: depositForm.token,
        amount: amountWei.toString(),
        commitment: depositForm.commitment,
        assetID,
        deadline,
      };
      const signature = await wallet.signer.signTypedData(domain, DEPOSIT_TYPES, message);

      if (String(depositForm.token).toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
        const shadow = await fetchJson(`${base}/shadow-address`, {
          method: "POST",
          body: JSON.stringify({ ...message, signature }),
        });
        const feeWei = BigInt(shadow?.feeWei || "0");
        const shadowSweepBufferWei = BigInt(
          cfg?.module4RelayerDeposit?.shadowSweepGasBufferWei ?? String(SHADOW_SWEEP_GAS_BUFFER_WEI_DEFAULT)
        );
        const totalFunding = amountWei + feeWei + shadowSweepBufferWei;
        const fundTx = await wallet.signer.sendTransaction({
          to: shadow.shadowAddress,
          value: totalFunding,
        });
        await fundTx.wait();
        let sweep = null;
        let sweepErr = null;
        for (let i = 0; i < 6; i += 1) {
          try {
            sweep = await fetchJson(`${base}/shadow-sweep`, {
              method: "POST",
              body: JSON.stringify({
                shadowAddress: shadow.shadowAddress,
                commitment: depositForm.commitment,
              }),
            });
            sweepErr = null;
            break;
          } catch (e) {
            sweepErr = e;
            await sleep(2500);
          }
        }
        if (!sweep) {
          throw new Error(
            `Shadow funded at ${shadow.shadowAddress} but sweep has not completed yet. Retry sweep from backend. Last error: ${sweepErr?.message || String(sweepErr)}`
          );
        }
        let serverNote = null;
        if (sweep?.txHash && wallet.address) {
          try {
            serverNote = await fetchJson(`${base}/notes/from-deposit`, {
              method: "POST",
              body: JSON.stringify({
                txHash: sweep.txHash,
                ownerAddress: wallet.address,
                note: {
                  assetID,
                  amount: amountWei.toString(),
                  blindingFactor: depositBlinding,
                  ownerPublicKey: addressToOwnerPublicKey(wallet.address),
                },
              }),
            });
          } catch (noteErr) {
            console.warn("[shadow-flow] notes/from-deposit failed (local vault still has note)", noteErr);
          }
        }
        depositTxHash = sweep?.txHash || null;
        setLastResult({
          via: "shadow-flow",
          shadowAddress: shadow.shadowAddress,
          fundingTxHash: fundTx.hash,
          fundingWei: totalFunding.toString(),
          gasBufferWei: shadowSweepBufferWei.toString(),
          feeWei: feeWei.toString(),
          serverNote,
          suggestedVaultNote,
          vaultSaved: false,
          ...sweep,
        });
      } else {
        const keyInfo = await fetchJson(`${base}/relayer/encryption-key`);
        const envelope = await encryptForRelayer(
          { ...message, signature },
          keyInfo?.publicKeyPem
        );
        const out = await fetchJson(`${base}/deposit/encrypted`, {
          method: "POST",
          body: JSON.stringify({ envelope }),
        });
        depositTxHash = out?.txHash || null;
        setLastResult({ via: "relayer-submit", suggestedVaultNote, vaultSaved: false, ...out });
      }

      const v = vaultRef.current;
      let savedOk = false;
      if (v.unlocked && v.key && wallet.address) {
        try {
          const notePayload = suggestedVaultNote;
          const next = {
            notes: [{ t: Date.now(), payload: notePayload }, ...(v.data?.notes || [])].slice(0, 200),
            updatedAt: Date.now(),
          };
          await saveVault({ key: v.key, data: next });
          setVault((prev) => ({ ...prev, unlocked: true, key: v.key, data: next }));
          savedOk = true;
          try {
            sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
          } catch {
            /* ignore */
          }
        } catch (saveErr) {
          console.warn("[deposit] vault save failed", saveErr);
        }
      }
      if (!savedOk) {
        try {
          sessionStorage.setItem(
            PENDING_VAULT_NOTE_KEY,
            JSON.stringify({ payload: suggestedVaultNote, txHash: depositTxHash, ts: Date.now() })
          );
        } catch {
          /* ignore */
        }
      }
      setLastResult((prev) => (prev && prev.suggestedVaultNote ? { ...prev, vaultSaved: savedOk } : prev));
      setDepositBlinding(randomFieldElementString());
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    }
  }

  async function submitSwap() {
    setActionError(null);
    setActionSuccess(null);
    setLastResult(null);
    setSwapFlowBusy(true);
    setSwapFlowStage("Preparing swap...");
    try {
      if (!wallet.signer) throw new Error("Connect wallet first.");
      if (!cfg?.chainId || !cfg?.addresses?.shieldedPool) throw new Error("Backend config not loaded.");
      if (cfg.mode !== "live") throw new Error(`Backend is ${cfg.mode}. Configure missing env vars first.`);
      await fetchJson(`${base}/health`);
      const activeChain = await ensureCorrectChain();
      if (activeChain && Number(activeChain) !== Number(cfg.chainId)) {
        throw new Error(`Wallet is on chain ${activeChain}, but backend expects ${cfg.chainId}.`);
      }

      const deadline = Math.floor(Date.now() / 1000) + Number(intentForm.deadlineSec || 900);
      const noteNonce = Number(intentForm.nonce || Date.now());

      let minOutBI = 0n;
      try {
        minOutBI = BigInt(String(intentForm.minOutputAmount || "0"));
      } catch {
        minOutBI = 0n;
      }
      if (minOutBI === 0n) {
        throw new Error("Wait for price quote or enter a valid amount.");
      }
      if (cfg.mode === "live") {
        try {
          if (BigInt(String(intentForm.gasRefund || "0")) <= 0n) {
            throw new Error(
              "gasRefund must be greater than zero in live mode. It is deducted from your shielded note so the relayer is reimbursed for network gas—they do not pay gas from their own BNB. Refresh the quote."
            );
          }
        } catch (e) {
          if (e.message && e.message.includes("gasRefund")) throw e;
          throw new Error("Invalid gasRefund. Refresh the quote.");
        }
      }

      let swapData;
      /** Set only in the auto-generated swap path (vault spend note). Advanced JSON has no `note` binding. */
      let swapInputVaultNote = null;
      const customRaw = String(intentForm.swapDataJson || "").trim();
      if (customRaw) {
        try {
          const custom = JSON.parse(customRaw);
          if (custom && typeof custom === "object") {
            swapData = mergeSwapData(buildDefaultSwapData(intentForm, cfg.chainId, cfg), custom);
          } else {
            throw new Error("Invalid swap JSON");
          }
        } catch (e) {
          throw new Error(e.message === "Invalid swap JSON" ? e.message : "Invalid swap JSON in Advanced.");
        }
      } else {
        const entry = autoSpendEntry || spendable[0];
        if (!entry?.note) {
          throw new Error(
            "No spendable note for this input token. Unlock the vault, deposit (commitment is now circuit-derived), then swap—or paste full swap JSON under Advanced."
          );
        }
        const note = entry.note;
        swapInputVaultNote = note;
        let outAmtStr = String(swapLastQuote?.amountOut || "0");
        if (!outAmtStr || BigInt(outAmtStr) <= 0n) {
          throw new Error("Refresh the quote so expected output amount is available before proving.");
        }
        const feeBn = BigInt(String(intentForm.protocolFee || "0"));
        const gasBn = BigInt(String(intentForm.gasRefund || "0"));
        const inputAmountBn = BigInt(note.amount);
        let swapAmountBn;
        try {
          swapAmountBn = ethers.parseUnits(String(intentForm.inputAmount || "0"), 18);
        } catch {
          throw new Error("Enter a valid swap amount.");
        }
        if (swapAmountBn <= 0n) {
          throw new Error("Swap amount must be greater than zero.");
        }
        const maxSwapWei = inputAmountBn - feeBn - gasBn - MIN_SWAP_CHANGE_WEI;
        if (maxSwapWei <= 0n) {
          throw new Error(
            "This note is too small after protocol fee and gas refund — the pool always keeps a leftover change note. Deposit more or lower Gas refund (Advanced)."
          );
        }
        if (swapAmountBn > maxSwapWei) {
          const oldSwap = swapAmountBn;
          swapAmountBn = maxSwapWei;
          const outBn = BigInt(outAmtStr);
          outAmtStr = ((outBn * maxSwapWei) / oldSwap).toString();
          minOutBI = (minOutBI * maxSwapWei) / oldSwap;
          if (minOutBI === 0n || BigInt(outAmtStr) === 0n) {
            throw new Error("Scaled quote rounded to zero — refresh the quote after lowering swap amount or gas refund.");
          }
        }
        const changeWei = inputAmountBn - swapAmountBn - feeBn - gasBn;
        if (changeWei <= 0n) {
          throw new Error("Could not leave a positive change note — refresh the quote and try again.");
        }
        const merkle = await fetchJson(`${base}/merkle/${encodeURIComponent(note.commitmentHex)}`);
        const wbnb = canonicalWbnb(cfg.chainId);
        const tokenIn =
          String(intentForm.inputToken).toLowerCase() === ethers.ZeroAddress.toLowerCase()
            ? wbnb
            : intentForm.inputToken;
        const tokenOut =
          String(intentForm.outputToken).toLowerCase() === ethers.ZeroAddress.toLowerCase()
            ? wbnb
            : intentForm.outputToken;
        const proofBody = {
          inputNote: {
            assetID: note.assetID,
            amount: note.amount,
            blindingFactor: note.blindingFactor,
            ownerPublicKey: note.ownerPublicKey,
            nullifier: noteNullifier(note.commitmentDecimal, note.ownerPublicKey).toString(),
            commitment: note.commitmentDecimal,
          },
          outputNoteSwap: {
            assetID: getAssetIdForToken(intentForm.outputToken, cfg),
            amount: outAmtStr,
            blindingFactor: randomFieldElementString(),
            commitment: "0",
          },
          outputNoteChange: {
            assetID: note.assetID,
            amount: "0",
            blindingFactor: randomFieldElementString(),
            commitment: "0",
          },
          merkleRoot: merkle.merkleRoot,
          merklePath: merkle.merklePath,
          merklePathIndices: merkle.merklePathIndices,
          swapAmount: swapAmountBn.toString(),
          minOutputAmount: minOutBI.toString(),
          protocolFee: String(intentForm.protocolFee || "0"),
          gasRefund: String(intentForm.gasRefund || "0"),
        };
        setSwapFlowStage("Requesting proof from relayer...");
        setSwapProofBusy(true);
        let gen;
        try {
          try {
            gen = await fetchJson(`${base}/swap/generate-proof`, {
              method: "POST",
              body: JSON.stringify(proofBody),
            });
          } catch (relayerErr) {
            if (!clientProverReady) throw relayerErr;
            console.warn("[swap] relayer proof failed, falling back to client prover:", relayerErr);
            setSwapFlowStage("Relayer busy. Generating proof locally...");
            gen = await generateSwapProofClient(proofBody, {
              wasmUrl: CLIENT_PROVER_WASM_URL,
              zkeyUrl: CLIENT_PROVER_ZKEY_URL,
            });
          }
        } finally {
          setSwapProofBusy(false);
        }
        if (!gen?.proof || !gen?.publicInputs) {
          throw new Error(gen?.message || gen?.error || "Proof generation returned no proof.");
        }
        swapData = {
          proof: gen.proof,
          publicInputs: gen.publicInputs,
          swapParams: {
            tokenIn,
            tokenOut,
            amountIn: swapAmountBn.toString(),
            minAmountOut: minOutBI.toString(),
            fee: Number(swapLastQuote?.routeParams?.feeTier || 2500),
            sqrtPriceLimitX96: String(swapLastQuote?.routeParams?.sqrtPriceLimitX96 || 0),
            path: swapLastQuote?.routeParams?.path || "0x",
          },
          noteHints: {
            swap: {
              assetId: getAssetIdForToken(intentForm.outputToken, cfg),
              amount: outAmtStr,
              blindingFactor: proofBody.outputNoteSwap.blindingFactor,
              ownerPublicKey: note.ownerPublicKey,
            },
            change: {
              assetId: note.assetID,
              amount: String(proofBody.outputNoteChange.amount),
              blindingFactor: proofBody.outputNoteChange.blindingFactor,
              ownerPublicKey: note.ownerPublicKey,
            },
          },
          encryptedPayload: "0x",
        };
      }

      if (!swapData?.publicInputs?.nullifier) {
        throw new Error(
          "swapData.publicInputs.nullifier is required — build the proof first or include it in Advanced JSON."
        );
      }
      const nullifierHex = nullifierToBytes32Hex(swapData.publicInputs.nullifier);

      const intentReq = {
        userAddress: wallet.address,
        inputAssetID: Number(swapData.publicInputs.inputAssetID),
        outputAssetID: Number(swapData.publicInputs.outputAssetIDSwap),
        amountIn: String(swapData.publicInputs.swapAmount ?? "0"),
        minAmountOut: String(swapData.publicInputs.minOutputAmountSwap ?? intentForm.minOutputAmount ?? "0"),
        nonce: String(noteNonce),
        nullifier: nullifierHex,
        deadline,
      };
      setSwapFlowStage("Submitting signed intent...");

      const intentRes = await fetchJson(`${base}/intent`, {
        method: "POST",
        body: JSON.stringify(intentReq),
      });

      const { intentId, intent, domain, types } = intentRes;
      const typed = types || INTENT_TYPES;
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
      const intentSig = await wallet.signer.signTypedData(domain, typed, signPayload);

      const keyInfo = await fetchJson(`${base}/relayer/encryption-key`);
      const envelope = await encryptForRelayer(
        { intentId, intent, intentSig, swapData },
        keyInfo?.publicKeyPem
      );
      setSwapFlowStage("Broadcasting swap transaction...");
      const out = await fetchJson(`${base}/swap/encrypted`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      });
      /** Persist new output notes locally so Withdraw/Swap can spend them (on-chain commitments already exist). */
      setSwapFlowStage("Finalizing vault notes...");
      try {
        const hints = swapData?.noteHints;
        const pi = swapData?.publicInputs;
        const { swap: swapC, change: changeC } = resolveSwapOutputCommitments(out, pi);
        if (hints?.swap && hints?.change && pi && isNonZeroCommitmentStr(swapC) && isNonZeroCommitmentStr(changeC)) {
          const swapNotePayload = buildVaultNoteFromSwapHint({
            assetId: Number(hints.swap.assetId),
            amountStr: String(pi.outputAmountSwap ?? hints.swap.amount),
            blindingFactor: hints.swap.blindingFactor,
            ownerPublicKey: hints.swap.ownerPublicKey,
            commitmentStr: String(swapC),
          });
          const changeNotePayload = buildVaultNoteFromSwapHint({
            assetId: Number(hints.change.assetId),
            amountStr: String(pi.changeAmount ?? hints.change.amount),
            blindingFactor: hints.change.blindingFactor,
            ownerPublicKey: hints.change.ownerPublicKey,
            commitmentStr: String(changeC),
          });

          let merged = { key: vaultRef.current.key, data: vaultRef.current.data };
          if (!vaultRef.current.unlocked || !vaultRef.current.key) {
            const u = await unlockVault();
            if (!u?.key) {
              setActionSuccess(
                "Swap succeeded on-chain, but the note vault is locked — unlock Advanced → Note vault, then refresh and use “Add deposit note…” flow if needed. Swap outputs: BUSD + change."
              );
              setLastResult(out);
              return;
            }
            merged = u;
          } else {
            const flushed = await flushPendingVaultNoteAfterLoad({ key: vaultRef.current.key, data: vaultRef.current.data });
            if (flushed) merged = flushed;
          }

          const spentHex = String(
            swapInputVaultNote?.commitmentHex ||
              publicInputCommitmentToVaultHex(pi?.inputCommitment) ||
              ""
          ).toLowerCase();
          let notes = Array.isArray(merged.data?.notes) ? [...merged.data.notes] : [];
          if (spentHex) {
            notes = notes.filter((entry) => {
              const p = entry?.payload;
              const ph = String(p?.commitmentHex || "").toLowerCase();
              return !ph || ph !== spentHex;
            });
          }
          const pushUnique = (payload) => {
            const hx = String(payload.commitmentHex || "").toLowerCase();
            if (!hx) return;
            if (notes.some((e) => String(e?.payload?.commitmentHex || "").toLowerCase() === hx)) return;
            notes.unshift({ t: Date.now(), payload });
          };
          pushUnique(swapNotePayload);
          pushUnique(changeNotePayload);
          const nextData = { ...merged.data, notes: notes.slice(0, 200), updatedAt: new Date().toISOString() };
          await saveVault({ key: merged.key, data: nextData });
          setVault({ unlocked: true, key: merged.key, data: nextData });
          setActionSuccess("Saved swap output notes to your vault (output token + change). You can withdraw now.");
        }
      } catch (vaultSwapErr) {
        console.warn("[swap] vault note save failed", vaultSwapErr);
        setActionSuccess(null);
        setActionError(
          `Swap succeeded on-chain, but saving output notes to the local vault failed: ${stringifyErr(
            vaultSwapErr?.message ?? vaultSwapErr
          )}. Unlock the vault and retry, or import notes manually from the JSON.`
        );
      }
      setLastResult(out);
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    } finally {
      setSwapFlowBusy(false);
      setSwapFlowStage("");
    }
  }

  async function submitWithdraw() {
    setActionError(null);
    setActionSuccess(null);
    setLastResult(null);
    try {
      if (!wallet.signer) throw new Error("Connect wallet first.");
      if (!cfg?.addresses?.shieldedPool) throw new Error("Backend config not loaded.");
      if (cfg.mode !== "live") throw new Error(`Backend is ${cfg.mode}. Configure missing env vars first.`);
      await fetchJson(`${base}/health`);
      const activeChain = canWrite ? await ensureCorrectChain() : null;
      if (activeChain && Number(activeChain) !== Number(cfg.chainId)) {
        throw new Error(`Wallet is on chain ${activeChain}, but backend expects ${cfg.chainId}.`);
      }

      let withdrawData;
      const customRaw = String(withdrawForm.withdrawDataJson || "").trim();
      if (customRaw) {
        let parsed;
        try {
          parsed = JSON.parse(customRaw);
        } catch {
          throw new Error("Invalid withdraw JSON in Advanced.");
        }
        withdrawData = parsed.withdrawData || parsed;
        if (!withdrawData?.proof || !withdrawData?.publicInputs || (!withdrawData?.recipient && !withdrawData?.finalRecipient)) {
          throw new Error("Withdraw JSON must include proof, publicInputs, and recipient or finalRecipient.");
        }
      } else {
        const spend = spendableNoteEntries(vault.data, withdrawForm.token, cfg);
        if (!spend.length) {
          throw new Error("No spendable note for this token. Unlock the vault, deposit first, or paste full withdraw JSON under Advanced.");
        }
        const note = spend[0].note;
        const amt = String(withdrawForm.amount || "").trim();
        if (!amt) throw new Error("Enter withdraw amount (payout to recipient, same decimals as note).");
        const amountWei = ethers.parseUnits(amt, 18);
        const protocolFee = BigInt(String(withdrawForm.protocolFee || "0"));
        const gasRefund = BigInt(String(withdrawForm.gasRefund || "0"));
        const inputWei = BigInt(note.amount);
        const changeWei = inputWei - amountWei - protocolFee - gasRefund;
        if (changeWei <= 0n) {
          throw new Error("After withdraw + protocol fee + gas refund, change must stay positive in the pool (see ShieldedPool conservation).");
        }
        const merkle = await fetchJson(`${base}/merkle/${encodeURIComponent(note.commitmentHex)}`);
        const proofBody = {
          inputNote: {
            assetID: note.assetID,
            amount: note.amount,
            blindingFactor: note.blindingFactor,
            ownerPublicKey: note.ownerPublicKey,
            nullifier: noteNullifier(note.commitmentDecimal, note.ownerPublicKey).toString(),
            commitment: note.commitmentDecimal,
          },
          outputNoteChange: {
            assetID: note.assetID,
            amount: changeWei.toString(),
            blindingFactor: randomFieldElementString(),
            commitment: "0",
          },
          merkleRoot: merkle.merkleRoot,
          merklePath: merkle.merklePath,
          merklePathIndices: merkle.merklePathIndices,
          protocolFee: protocolFee.toString(),
          gasRefund: gasRefund.toString(),
          withdrawAmount: amountWei.toString(),
        };
        setWithdrawProofBusy(true);
        let gen;
        try {
          gen = await fetchJson(`${base}/withdraw/generate-proof`, {
            method: "POST",
            body: JSON.stringify(proofBody),
          });
        } finally {
          setWithdrawProofBusy(false);
        }
        if (!gen?.proof || !gen?.publicInputs) {
          throw new Error(gen?.message || gen?.error || "Withdraw proof generation returned no proof.");
        }
        const recipient = (withdrawForm.recipient || "").trim() || wallet.address;
        withdrawData = {
          proof: gen.proof,
          publicInputs: gen.publicInputs,
          recipient,
          finalRecipient: recipient,
          ownerAddress: wallet.address.toLowerCase(),
          noteHints: {
            change: {
              assetId: note.assetID,
              amount: changeWei.toString(),
              blindingFactor: proofBody.outputNoteChange.blindingFactor,
              ownerPublicKey: note.ownerPublicKey,
            },
          },
          encryptedPayload: "0x",
        };
      }

      const keyInfo = await fetchJson(`${base}/relayer/encryption-key`);
      const envelope = await encryptForRelayer({ withdrawData }, keyInfo?.publicKeyPem);
      const out = await fetchJson(`${base}/withdraw/encrypted`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      });
      setLastResult(out);
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    }
  }

  async function importSuggestedVaultNoteFromLastDeposit() {
    setActionError(null);
    setActionSuccess(null);
    try {
      const sn = lastResult?.suggestedVaultNote;
      if (!sn) throw new Error("No suggestedVaultNote on last result — deposit again after pulling latest UI.");
      if (!wallet.signer) throw new Error("Connect wallet first.");

      let merged = { key: vault.key, data: vault.data };
      if (!vault.unlocked || !vault.key) {
        const u = await unlockVault();
        if (!u?.key) {
          setActionError(
            "Could not unlock the note vault. Approve the signature in MetaMask, or read the yellow note-vault message above. If your browser had an old broken vault, unlock once after this update — storage resets automatically."
          );
          return;
        }
        merged = u;
      } else {
        const flushed = await flushPendingVaultNoteAfterLoad({ key: vault.key, data: vault.data });
        if (flushed) {
          merged = flushed;
          setVault({ unlocked: true, key: merged.key, data: merged.data });
          setActionSuccess("Restored a pending deposit note into your vault.");
        }
      }

      const hex = String(sn.commitmentHex || "").toLowerCase();
      const dup = (merged.data?.notes || []).some((entry) => {
        const p = entry?.payload;
        if (!p || typeof p !== "object") return false;
        const ph = String(p.commitmentHex || "").toLowerCase();
        if (hex && ph && ph === hex) return true;
        return String(p.blindingFactor) === String(sn.blindingFactor) && String(p.amount) === String(sn.amount);
      });
      if (dup) {
        setActionSuccess("This note is already in your vault.");
        return;
      }
      const next = {
        notes: [{ t: Date.now(), payload: sn }, ...(merged.data?.notes || [])].slice(0, 200),
        updatedAt: Date.now(),
      };
      await saveVault({ key: merged.key, data: next });
      setVault((v) => ({ ...v, unlocked: true, key: merged.key, data: next }));
      try {
        sessionStorage.removeItem(PENDING_VAULT_NOTE_KEY);
      } catch {
        /* ignore */
      }
      setActionSuccess("Saved deposit note to your vault. You can use Swap / Withdraw.");
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    }
  }

  function importToken() {
    const symbol = importTokenSymbol.trim().toUpperCase();
    const address = importTokenAddress.trim();
    if (!symbol || !address) {
      setActionError("Enter token symbol and token address.");
      return;
    }
    if (!ethers.isAddress(address)) {
      setActionError("Invalid token address.");
      return;
    }
    setTokenList((prev) => {
      if (prev.some((t) => t.address.toLowerCase() === address.toLowerCase())) return prev;
      return [...prev, { symbol, address }];
    });
    setImportTokenSymbol("");
    setImportTokenAddress("");
    setActionError(null);
    setActionSuccess(null);
  }

  function placeInternalOrder() {
    const amountNum = Number(orderForm.amount);
    const priceNum = Number(orderForm.price);
    if (!Number.isFinite(amountNum) || amountNum <= 0 || !Number.isFinite(priceNum) || priceNum <= 0) {
      setActionError("Enter a valid order amount and price.");
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    const next = {
      id: Date.now(),
      side: orderForm.side,
      pair: `${orderForm.baseToken}/${orderForm.quoteToken}`,
      amount: amountNum.toFixed(4),
      price: priceNum.toFixed(4),
      total: (amountNum * priceNum).toFixed(4),
      status: "OPEN",
    };
    setLocalOrders((prev) => [next, ...prev].slice(0, 12));
    setOrderForm((prev) => ({ ...prev, amount: "", price: "" }));
    setActionSuccess("Internal match intent created. Other users can now join this order.");
  }

  function joinInternalOrder() {
    if (!localOrders.length) {
      setActionError("No active internal match intents found yet. Create one first.");
      return;
    }
    const firstOpen = localOrders.find((order) => order.status === "OPEN");
    if (!firstOpen) {
      setActionError("No OPEN intents are available right now.");
      return;
    }
    setLocalOrders((prev) =>
      prev.map((order) => (order.id === firstOpen.id ? { ...order, status: "MATCHED" } : order))
    );
    setActionError(null);
    setActionSuccess(`Matched internal order ${firstOpen.pair} at ${firstOpen.price}.`);
  }

  function cancelInternalOrder(orderId) {
    setLocalOrders((prev) =>
      prev.map((order) => (order.id === orderId ? { ...order, status: "CANCELLED" } : order))
    );
    setActionError(null);
    setActionSuccess("Internal match intent cancelled.");
  }

  const showSwapPanel = tab === "swap" || (tab === "all" && uiVariant !== "trade");
  const hasOpenInternalOrder = useMemo(
    () => localOrders.some((order) => order.status === "OPEN"),
    [localOrders]
  );
  const tradeNeedsUnlock = uiVariant === "trade" && !vault.unlocked;
  const openInternalOrders = useMemo(
    () => localOrders.filter((order) => order.status === "OPEN"),
    [localOrders]
  );
  const noteBalanceRows = useMemo(() => {
    const notes = Array.isArray(vault.data?.notes) ? vault.data.notes : [];
    const cfgAssets = Array.isArray(cfg?.assets) ? cfg.assets : [];
    const assetToAddress = new Map();
    assetToAddress.set(0, ethers.ZeroAddress);
    cfgAssets.forEach((asset) => {
      const id = Number(asset?.assetId);
      const addr = String(asset?.address || "").trim();
      if (Number.isFinite(id) && addr) assetToAddress.set(id, addr);
    });

    const sums = new Map();
    notes.forEach((entry) => {
      const raw = entry?.payload ?? entry;
      if (Number(raw?.version) !== 1) return;
      const aid = Number(raw?.assetID);
      if (!Number.isFinite(aid)) return;
      let amount = 0n;
      try {
        amount = BigInt(String(raw?.amount || "0"));
      } catch {
        amount = 0n;
      }
      if (amount <= 0n) return;
      const addr = assetToAddress.get(aid);
      const key = addr ? String(addr).toLowerCase() : `asset:${aid}`;
      sums.set(key, (sums.get(key) || 0n) + amount);
    });

    return Array.from(sums.entries())
      .map(([key, totalWei]) => {
        const isSynthetic = key.startsWith("asset:");
        const tokenAddress = isSynthetic ? null : key;
        const tokenHit = tokenAddress
          ? tokenList.find((t) => String(t.address || "").toLowerCase() === tokenAddress)
          : null;
        const symbol = tokenHit?.symbol
          || (tokenAddress === ethers.ZeroAddress.toLowerCase() ? "BNB" : isSynthetic ? key.toUpperCase() : "TOKEN");
        return {
          key,
          tokenAddress,
          symbol,
          amountWei: totalWei,
          amountLabel: formatTokenAmount(ethers.formatUnits(totalWei, 18)),
        };
      })
      .sort((a, b) => (a.symbol > b.symbol ? 1 : -1));
  }, [vault.data, cfg?.assets, tokenList]);
  const [noteBalanceToken, setNoteBalanceToken] = useState("__all_notes__");
  const selectedBalanceRow = useMemo(
    () => noteBalanceRows.find((row) => row.key === noteBalanceToken) || null,
    [noteBalanceRows, noteBalanceToken]
  );
  const noteBalanceTotalLabel = useMemo(() => {
    const totalWei = noteBalanceRows.reduce((acc, row) => acc + BigInt(String(row.amountWei || "0")), 0n);
    return formatTokenAmount(ethers.formatUnits(totalWei, 18));
  }, [noteBalanceRows]);
  const [walletBalanceLabel, setWalletBalanceLabel] = useState("—");
  const [walletBalanceBusy, setWalletBalanceBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (uiVariant !== "trade") return;
      if (!wallet?.provider || !wallet?.address) {
        setWalletBalanceLabel("—");
        return;
      }
      setWalletBalanceBusy(true);
      try {
        const raw = await wallet.provider.getBalance(wallet.address);
        const label = formatTokenAmount(ethers.formatUnits(raw, 18));
        if (!cancelled) setWalletBalanceLabel(label);
      } catch {
        if (!cancelled) setWalletBalanceLabel("—");
      } finally {
        if (!cancelled) setWalletBalanceBusy(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [uiVariant, wallet?.provider, wallet?.address]);
  useEffect(() => {
    if (!swapFlowBusy) return undefined;
    const t = setInterval(() => {
      setSwapSpinnerTick((n) => (n + 1) % 4);
    }, 140);
    return () => clearInterval(t);
  }, [swapFlowBusy]);

  return (
    <div
      style={{
        maxWidth: uiVariant === "trade" ? "100%" : 760,
        margin: "0 auto",
        borderRadius: uiVariant === "trade" ? 24 : 18,
        border: uiVariant === "trade" ? "1px solid rgba(148, 163, 184, 0.12)" : "1px solid rgba(255,255,255,0.14)",
        background: uiVariant === "trade"
          ? "linear-gradient(180deg, rgba(8, 12, 20, 0.98) 0%, rgba(5, 8, 14, 0.99) 100%)"
          : "#11141b",
        padding: uiVariant === "trade" ? 18 : 20,
        boxShadow: uiVariant === "trade" ? "0 14px 34px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255,255,255,0.03)" : "none",
        backdropFilter: uiVariant === "trade" ? "blur(8px)" : "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ fontSize: uiVariant === "trade" ? 26 : 28, fontWeight: 700, color: uiVariant === "trade" ? "#d9fff8" : "#fff", lineHeight: 1.15, fontFamily: "var(--font-display, Georgia, serif)", letterSpacing: "-0.01em" }}>
            {uiVariant === "trade" ? "Trade Console" : "Phantom Console"}
          </div>
          <div style={{ fontSize: 13, color: uiVariant === "trade" ? PC.muted : "rgba(255,255,255,0.65)", marginTop: 6, lineHeight: 1.45, maxWidth: 420 }}>
            {uiVariant === "trade"
              ? "Step 1 unlock notes, then choose deposit, swap, withdraw, or internal matching."
              : "Deposit, swap, and withdraw through the relayer. Advanced users can edit proofs and API settings."}
          </div>
          <div style={{ fontSize: 12, marginTop: 6, color: clientProverReady ? "rgba(226,232,240,0.92)" : "rgba(255,255,255,0.58)" }}>
            {clientProverReady ? "Client proving enabled." : "Client proving unavailable (using relayer proving fallback)."}
          </div>
          {uiVariant === "trade" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {["1. Unlock", "2. Choose action", "3. Review and submit"].map((label) => (
                <span
                  key={label}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "rgba(203,213,225,0.95)",
                    border: `1px solid rgba(148,163,184,0.28)`,
                    borderRadius: 999,
                    padding: "4px 10px",
                    background: "rgba(148,163,184,0.08)",
                  }}
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {!wallet.address ? (
            <button
              type="button"
              onClick={connect}
              style={{
                borderRadius: 12,
                background: "rgba(30,41,59,0.9)",
                color: "#e5e7eb",
                padding: "10px 16px",
                fontSize: 13,
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
                boxShadow: "0 4px 18px rgba(0, 0, 0, 0.25)",
              }}
            >
              Connect wallet
            </button>
          ) : (
            <>
              <div style={{ borderRadius: 12, border: `1px solid ${PC.border}`, background: "rgba(255,255,255,0.06)", color: "#fff", padding: "10px 12px", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono, monospace)" }}>
                {shorten(wallet.address)}
              </div>
              <button
                type="button"
                onClick={disconnect}
                style={{ borderRadius: 12, background: "rgba(255,255,255,0.06)", color: "#fff", padding: "10px 14px", fontSize: 13, fontWeight: 600, border: `1px solid ${PC.border}`, cursor: "pointer" }}
              >
                Disconnect
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ borderRadius: 12, background: "rgba(255,255,255,0.06)", color: "#fff", padding: "10px 14px", fontSize: 13, fontWeight: 600, border: `1px solid ${PC.border}`, cursor: "pointer" }}
          >
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
        </div>
      </div>

      {cfgErr && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(cfgErr)}</div>}
      {connectError && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(connectError)}</div>}
      {actionError && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(actionError)}</div>}
      {actionSuccess && (
        <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(52, 211, 153, 0.45)", background: "rgba(6, 78, 59, 0.35)", padding: 10, fontSize: 13, color: "#a7f3d0" }}>
          {actionSuccess}
        </div>
      )}
      {vaultError && (
        <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(251, 191, 36, 0.45)", background: "rgba(120, 53, 15, 0.35)", padding: 10, fontSize: 13, color: "#fde68a" }}>
          {stringifyErr(vaultError)}
        </div>
      )}

      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          borderRadius: uiVariant === "trade" ? 16 : 12,
          border: `1px solid ${uiVariant === "trade" ? "rgba(148,163,184,0.14)" : "rgba(255,255,255,0.12)"}`,
          background: uiVariant === "trade" ? "rgba(8, 12, 20, 0.82)" : "rgba(0,0,0,0.26)",
          padding: uiVariant === "trade" ? "12px 14px" : 12,
          fontSize: 12,
          alignItems: "center",
        }}
      >
        {[
          { k: "Backend", v: health?.ok ? "Live" : "…", ok: !!health?.ok },
          { k: "Chain", v: cfg?.chainId != null ? String(cfg.chainId) : "—", ok: cfg?.chainId != null },
          {
            k: "Wallet",
            v: !wallet?.address ? "—" : String(walletChainId ?? "—"),
            ok: !wallet?.address || Number(walletChainId) === Number(cfg?.chainId),
          },
        ].map((row) => (
          <div
            key={row.k}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(148,163,184,0.22)",
            }}
          >
            <span style={{ color: PC.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.06em" }}>{row.k}</span>
            <span style={{ color: "#fff", fontWeight: 700, fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>{row.v}</span>
          </div>
        ))}
      </div>

      {uiVariant === "trade" && (
        <div style={{ marginTop: 14, borderRadius: 16, border: tradeNeedsUnlock ? "1px solid rgba(148, 163, 184, 0.24)" : "1px solid rgba(148, 163, 184, 0.14)", background: "rgba(9, 12, 20, 0.78)", padding: 14 }}>
          <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Unlock notes</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, color: "#fff", lineHeight: 1.45 }}>
              {!tradeNeedsUnlock
                ? "Unlocked. You can now choose Deposit, Swap, Withdraw, or Internal Match."
                : "Step 1: unlock notes before trading so Deposit, Swap, Withdraw, and Internal Match become active."}
            </div>
            {!wallet.signer ? (
              <button
                type="button"
                onClick={connect}
                style={{ borderRadius: 10, border: "1px solid rgba(148,163,184,0.25)", background: "rgba(30,41,59,0.9)", color: "#e5e7eb", padding: "9px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
              >
                Connect wallet
              </button>
            ) : (
              <button
                type="button"
                onClick={unlockVault}
                style={{ borderRadius: 10, border: tradeNeedsUnlock ? "1px solid rgba(148,163,184,0.3)" : `1px solid ${PC.border}`, background: tradeNeedsUnlock ? "rgba(51,65,85,0.55)" : "rgba(30,41,59,0.52)", color: "#fff", padding: "9px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
              >
                {!tradeNeedsUnlock ? "Unlocked" : "Unlock notes"}
              </button>
            )}
          </div>
        </div>
      )}

      {uiVariant === "trade" && (
        <div
          style={{
            marginTop: 12,
            borderRadius: 14,
            border: "1px solid rgba(148,163,184,0.18)",
            background: "rgba(10,14,22,0.82)",
            padding: 12,
          }}
        >
          <div style={{ fontSize: 11, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
            Your balances
          </div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div style={{ borderRadius: 10, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(15,23,42,0.55)", padding: "8px 10px" }}>
              <div style={{ fontSize: 11, color: PC.muted }}>Wallet balance</div>
              <div style={{ marginTop: 3, color: "#fff", fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono, monospace)" }}>
                {walletBalanceBusy ? "Loading..." : walletBalanceLabel} BNB
              </div>
            </div>
            <div style={{ borderRadius: 10, border: "1px solid rgba(148,163,184,0.16)", background: "rgba(15,23,42,0.55)", padding: "8px 10px" }}>
              <div style={{ fontSize: 11, color: PC.muted, marginBottom: 6 }}>Note balance</div>
              <select
                value={noteBalanceToken}
                onChange={(e) => setNoteBalanceToken(e.target.value)}
                style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(148,163,184,0.24)", background: "rgba(15,23,42,0.7)", color: "#fff", padding: "7px 10px", fontSize: 12 }}
              >
                <option value="__all_notes__">All notes total: {noteBalanceTotalLabel}</option>
                {noteBalanceRows.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.symbol}: {row.amountLabel}
                  </option>
                ))}
              </select>
              <div style={{ marginTop: 3, color: "#fff", fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono, monospace)" }}>
                {selectedBalanceRow ? `${selectedBalanceRow.amountLabel} ${selectedBalanceRow.symbol}` : `${noteBalanceTotalLabel} TOTAL`}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "8px", borderRadius: 14, border: "1px solid rgba(148,163,184,0.12)", background: "rgba(6, 10, 16, 0.72)" }}>
        {uiVariant === "trade" && (
          <button
            type="button"
            onClick={unlockVault}
            disabled={!wallet.signer}
            style={{
              borderRadius: 10,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 800,
              border: tradeNeedsUnlock ? "1px solid rgba(203,213,225,0.32)" : "1px solid rgba(148,163,184,0.14)",
              background: tradeNeedsUnlock ? "rgba(71,85,105,0.7)" : "rgba(18, 24, 36, 0.62)",
              color: "#fff",
              cursor: wallet.signer ? "pointer" : "not-allowed"
            }}
          >
            {tradeNeedsUnlock ? "Unlock Notes" : "Notes Unlocked"}
          </button>
        )}
        {(uiVariant === "trade" ? ["deposit", "swap", "withdraw", "internal"] : ["swap", "deposit", "withdraw", "all"]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setActionError(null);
              setActionSuccess(null);
              setVaultError(null);
              setLastResult(null);
            }}
            disabled={uiVariant === "trade" && tradeNeedsUnlock}
            style={{
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 700,
              border: tab === k ? "1px solid rgba(203,213,225,0.34)" : "1px solid rgba(148,163,184,0.14)",
              background: tab === k ? "rgba(71,85,105,0.68)" : "rgba(255,255,255,0.03)",
              color: uiVariant === "trade" && tradeNeedsUnlock ? "rgba(255,255,255,0.35)" : "#fff",
              opacity: uiVariant === "trade" && tradeNeedsUnlock ? 0.55 : 1,
              cursor: uiVariant === "trade" && tradeNeedsUnlock ? "not-allowed" : "pointer"
            }}
          >
            {k === "deposit" ? "Deposit" : k === "swap" ? "Swap" : k === "withdraw" ? "Withdraw" : k === "internal" ? "Internal Match" : "All"}
          </button>
        ))}
        {uiVariant !== "trade" && (
          <Link to="/trade" style={{ fontSize: 13, fontWeight: 700, color: PC.teal, textDecoration: "none", marginLeft: 4 }}>
            Internal Match →
          </Link>
        )}
      </div>
      {uiVariant === "trade" && tradeNeedsUnlock && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#fde68a" }}>
          Unlock notes first to continue.
        </div>
      )}

      {(tab === "deposit" || (tab === "all" && uiVariant !== "trade")) && (!tradeNeedsUnlock || uiVariant !== "trade") && (
        <div style={{ marginTop: 14, borderRadius: 16, border: "1px solid rgba(148,163,184,0.12)", background: "rgba(8, 12, 20, 0.84)", padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Deposit</div>
          <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Token</div>
              <select
                value={depositTokenChoice}
                onChange={(e) => {
                  const next = e.target.value;
                  setDepositTokenChoice(next);
                  if (next !== "__custom__") setDepositForm({ ...depositForm, token: next });
                }}
                style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              >
                {tokenList.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
                <option value="__custom__">Custom address</option>
              </select>
              {depositTokenChoice === "__custom__" && (
                <input
                  value={depositForm.token}
                  onChange={(e) => setDepositForm({ ...depositForm, token: e.target.value })}
                  placeholder="0x... custom token address"
                  style={{ marginTop: 6, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
                />
              )}
            </div>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Amount</div>
              <input value={depositForm.amount} onChange={(e) => setDepositForm({ ...depositForm, amount: e.target.value })} style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }} />
            </div>
          </div>
          <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Commitment (MiMC note hash — matches ZK circuit)</div>
            <button
              type="button"
              onClick={() => setDepositBlinding(randomFieldElementString())}
              style={{ borderRadius: 10, background: "rgba(255,255,255,0.08)", color: "#fff", padding: "6px 10px", fontSize: 11, fontWeight: 700, border: "1px solid rgba(255,255,255,0.14)", cursor: "pointer" }}
            >
              New blinding
            </button>
          </div>
          {!wallet?.address ? (
            <div style={{ marginTop: 6, fontSize: 11, color: "rgba(248,180,100,0.95)" }}>Connect wallet to derive commitment.</div>
          ) : null}
          <div style={{ marginTop: 4 }}>
            <input value={depositForm.commitment} readOnly style={{ width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.45 }}>
            Unlock the note vault before deposit so the client can save your note for swap/withdraw. If the vault was locked, use “Add deposit note to vault” in the result panel after deposit.
          </div>
          {!vault?.unlocked ? (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: "1px solid rgba(248,180,100,0.45)", background: "rgba(248,180,100,0.08)", fontSize: 12, color: "#fde68a" }}>
              Vault is locked — swap and withdraw will not see your note until you unlock the vault and deposit again, or import the note from the last deposit result.
            </div>
          ) : null}
            <button onClick={submitDeposit} disabled={!canTransact} style={{ marginTop: 12, borderRadius: 10, background: canTransact ? "rgba(30,41,59,0.9)" : "rgba(51,65,85,0.45)", color: "#fff", padding: "10px 14px", fontSize: 14, fontWeight: 700, border: "1px solid rgba(148,163,184,0.22)", cursor: canTransact ? "pointer" : "not-allowed" }}>
            Deposit
          </button>
        </div>
      )}

      {showSwapPanel && (!tradeNeedsUnlock || uiVariant !== "trade") && (
        <div style={{ marginTop: 14, borderRadius: 20, border: `1px solid ${PC.border}`, background: PC.card, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: PC.text }}>Swap</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: PC.muted }}>Slippage</span>
              {SLIPPAGE_PRESETS_BPS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => setSwapSlippageBps(bps)}
                  style={{
                    borderRadius: 8,
                    padding: "4px 8px",
                    fontSize: 12,
                    fontWeight: 700,
                    border: `1px solid ${PC.border}`,
                    background: swapSlippageBps === bps ? "rgba(71,85,105,0.78)" : "transparent",
                    color: PC.text,
                    cursor: "pointer",
                  }}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
          </div>

          {cfg?.mode === "live" ? (
            <div style={{ marginBottom: 12, padding: 10, borderRadius: 12, border: `1px solid ${PC.border}`, background: PC.bg, fontSize: 12, color: PC.muted }}>
              {String(intentForm.swapDataJson || "").trim() ? (
                <span style={{ color: PC.text }}>Advanced swap JSON is set — automatic proof generation is skipped.</span>
              ) : spendable.length === 0 ? (
                <span>
                  No spendable vault notes for this input asset. Unlock the vault, deposit (note is saved), wait for on-chain commitment, then swap—or paste a full proof payload under Advanced.
                </span>
              ) : (
                <span style={{ color: PC.text }}>
                  Auto note spend enabled. Using best available note{autoSpendEntry?.note?.amount ? ` (${ethers.formatEther(autoSpendEntry.note.amount)}).` : "."}
                </span>
              )}
            </div>
          ) : null}

          <div style={{ borderRadius: 16, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Sell</div>
            <select
              value={swapInputTokenChoice}
              onChange={(e) => {
                const next = e.target.value;
                setSwapInputTokenChoice(next);
                if (next !== "__custom__") setIntentForm({ ...intentForm, inputToken: next });
              }}
              style={{ marginTop: 6, width: "100%", borderRadius: 12, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "12px 10px", fontSize: 15, fontWeight: 600 }}
            >
              {tokenList.map((t) => (
                <option key={`in-${t.address}`} value={t.address}>{t.symbol}</option>
              ))}
              <option value="__custom__">Custom address</option>
            </select>
            {swapInputTokenChoice === "__custom__" && (
              <input
                value={intentForm.inputToken}
                onChange={(e) => setIntentForm({ ...intentForm, inputToken: e.target.value })}
                placeholder="0x... token in"
                style={{ marginTop: 8, width: "100%", borderRadius: 12, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            )}
            <input
              value={intentForm.inputAmount}
              onChange={(e) => setIntentForm({ ...intentForm, inputAmount: e.target.value })}
              placeholder="0.0"
              style={{ marginTop: 10, width: "100%", borderRadius: 12, border: "none", background: "transparent", color: "#fff", fontSize: 22, fontWeight: 700, outline: "none" }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "center", margin: "-14px 0", position: "relative", zIndex: 1 }}>
            <button
              type="button"
              onClick={flipSwapTokens}
              title="Flip tokens"
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                border: `2px solid ${PC.border}`,
                background: PC.card,
                color: "rgba(226,232,240,0.92)",
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
              }}
            >
              ⇅
            </button>
          </div>

          <div style={{ borderRadius: 16, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Buy</div>
            <select
              value={swapOutputTokenChoice}
              onChange={(e) => {
                const next = e.target.value;
                setSwapOutputTokenChoice(next);
                if (next !== "__custom__") setIntentForm({ ...intentForm, outputToken: next });
              }}
              style={{ marginTop: 6, width: "100%", borderRadius: 12, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "12px 10px", fontSize: 15, fontWeight: 600 }}
            >
              {tokenList.map((t) => (
                <option key={`out-${t.address}`} value={t.address}>{t.symbol}</option>
              ))}
              <option value="__custom__">Custom address</option>
            </select>
            {swapOutputTokenChoice === "__custom__" && (
              <input
                value={intentForm.outputToken}
                onChange={(e) => setIntentForm({ ...intentForm, outputToken: e.target.value })}
                placeholder="0x... token out"
                style={{ marginTop: 8, width: "100%", borderRadius: 12, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            )}
            <div style={{ marginTop: 10, fontSize: 22, fontWeight: 700, color: swapQuoteLoading ? PC.muted : "rgba(226,232,240,0.95)", letterSpacing: "-0.02em" }}>
              {swapQuoteLoading ? (
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <span className="dapp-quote-pulse">Fetching quote</span>
                </span>
              ) : (
                swapExpectedLabel || "—"
              )}
            </div>
          </div>

          <div style={{ marginTop: 14, borderRadius: 14, border: `1px solid ${PC.border}`, padding: 12, fontSize: 13, color: PC.muted }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span>Min. received (after {swapSlippageBps / 100}% slippage)</span>
              <span style={{ color: PC.text, fontWeight: 700 }}>{swapQuoteLoading ? "…" : (swapMinLabel || "—")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span>Route</span>
              <span style={{ color: PC.text, fontSize: 12, maxWidth: "58%", textAlign: "right" }}>{swapLastQuote?.routeDescription ?? cfg?.features?.quoteMode ?? "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <span>Relayer gas</span>
              <span style={{ color: "rgba(226,232,240,0.95)", fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                {swapQuoteLoading ? "…" : `${ethers.formatEther(intentForm.gasRefund || "0")} BNB`}
              </span>
            </div>
            {swapQuoteErr && <div style={{ marginTop: 8, fontSize: 12, color: "#ed4b9e" }}>{swapQuoteErr}</div>}
            {swapClampHint && !swapQuoteErr && (
              <div style={{ marginTop: 8, fontSize: 12, color: PC.muted }}>{swapClampHint}</div>
            )}
            {cfg?.mode === "live" && !swapGasRefundOk && !swapQuoteLoading && (intentForm.inputAmount || "").trim() && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#ed4b9e" }}>Waiting for relayer gas quote…</div>
            )}
          </div>

          {swapNeedsWallet && (
            <div style={{ marginTop: 10, fontSize: 13, color: PC.muted }}>
              Connect a wallet to sign the swap intent. The relayer then submits the shielded swap on-chain.
            </div>
          )}
          {cfg?.mode !== "live" && (
            <div style={{ marginTop: 10, fontSize: 13, color: "#ed4b9e" }}>Backend is not in live mode — configure the relayer and refresh.</div>
          )}
          {swapNeedsWallet ? (
            <button
              type="button"
              onClick={connect}
              style={{ marginTop: 14, borderRadius: 16, background: "rgba(30,41,59,0.92)", color: "#f8fafc", padding: "16px 18px", fontSize: 16, fontWeight: 800, border: "1px solid rgba(148,163,184,0.22)", cursor: "pointer", width: "100%" }}
            >
              Connect wallet
            </button>
          ) : (
            <button
              type="button"
              onClick={submitSwap}
              disabled={!canTransact || swapQuoteLoading || swapProofBusy || swapFlowBusy || !!swapQuoteErr || !swapGasRefundOk}
              style={{
                marginTop: 14,
                borderRadius: 16,
                background: canTransact && !swapQuoteLoading && !swapProofBusy && !swapFlowBusy && !swapQuoteErr && swapGasRefundOk ? "rgba(30,41,59,0.92)" : "rgba(51,65,85,0.45)",
                color: canTransact && !swapQuoteLoading && !swapProofBusy && !swapFlowBusy && !swapQuoteErr && swapGasRefundOk ? "#f8fafc" : PC.muted,
                padding: "16px 18px",
                fontSize: 16,
                fontWeight: 800,
                border: "none",
                cursor: canTransact && !swapQuoteLoading && !swapProofBusy && !swapFlowBusy && !swapQuoteErr && swapGasRefundOk ? "pointer" : "not-allowed",
                width: "100%",
              }}
            >
              {swapFlowBusy ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 17, lineHeight: 1, width: 18, display: "inline-block", textAlign: "center" }}>
                    {["◐", "◓", "◑", "◒"][swapSpinnerTick]}
                  </span>
                  {swapFlowStage || "Processing swap..."}
                </span>
              ) : (
                "Submit swap via relayer"
              )}
            </button>
          )}
          {swapFlowBusy && (
            <div style={{ marginTop: 8, fontSize: 12, color: PC.muted, display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>{["◐", "◓", "◑", "◒"][swapSpinnerTick]}</span>
              Please wait while we prepare and submit your swap securely.
            </div>
          )}
        </div>
      )}

      {(tab === "withdraw" || (tab === "all" && uiVariant !== "trade")) && (!tradeNeedsUnlock || uiVariant !== "trade") && (
        <div style={{ marginTop: 14, borderRadius: 16, border: "1px solid rgba(148,163,184,0.12)", background: "rgba(8, 12, 20, 0.84)", padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Withdraw</div>
          <div style={{ marginTop: 8, fontSize: 12, color: PC.muted, lineHeight: 1.45 }}>
            Shielded withdraw: proof + nullifier spend; relayer submits <code style={{ color: "#fff" }}>shieldedWithdraw</code>. Amount is the payout to recipient; change stays in the pool as a new note. Set protocol fee and gas refund so they match your note (on-chain enforces min fee from oracle).
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Token</div>
            <select
              value={withdrawTokenChoice}
              onChange={(e) => {
                const next = e.target.value;
                withdrawAmountUserEditedRef.current = false;
                setWithdrawTokenChoice(next);
                if (next !== "__custom__") setWithdrawForm({ ...withdrawForm, token: next });
              }}
              style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            >
              {tokenList.map((t) => <option key={`w-${t.address}`} value={t.address}>{t.symbol}</option>)}
              <option value="__custom__">Custom address</option>
            </select>
            {withdrawTokenChoice === "__custom__" && (
              <input
                value={withdrawForm.token}
                onChange={(e) => setWithdrawForm({ ...withdrawForm, token: e.target.value })}
                placeholder="0x... custom token"
                style={{ marginTop: 6, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Amount (payout to recipient)</div>
              <button
                type="button"
                disabled={
                  !!withdrawAdvancedJson ||
                  withdrawMaxPayoutWei == null ||
                  withdrawMaxPayoutWei <= 0n ||
                  !wallet?.signer
                }
                onClick={() => {
                  if (withdrawMaxPayoutWei == null || withdrawMaxPayoutWei <= 0n) return;
                  withdrawAmountUserEditedRef.current = false;
                  setWithdrawForm((f) => ({ ...f, amount: ethers.formatUnits(withdrawMaxPayoutWei, 18) }));
                }}
                style={{
                  borderRadius: 8,
                  background: withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n && !withdrawAdvancedJson ? "rgba(24,185,128,0.25)" : "rgba(255,255,255,0.06)",
                  color: "#fff",
                  padding: "6px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  border: "1px solid rgba(255,255,255,0.14)",
                  cursor:
                    withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n && !withdrawAdvancedJson ? "pointer" : "not-allowed",
                }}
              >
                Use max payout
              </button>
            </div>
            <input
              value={withdrawForm.amount}
              onChange={(e) => {
                withdrawAmountUserEditedRef.current = true;
                setWithdrawForm({ ...withdrawForm, amount: e.target.value });
              }}
              style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            />
            {!withdrawAdvancedJson && withdrawSpendable.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.45 }}>
                First spendable note:{" "}
                <span style={{ color: PC.text }}>{ethers.formatEther(withdrawSpendable[0].note.amount)}</span> (18
                decimals) · Max payout after fee &amp; gas (leaves 1 wei change in pool):{" "}
                <span style={{ color: PC.text }}>
                  {withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n
                    ? ethers.formatUnits(withdrawMaxPayoutWei, 18)
                    : "— (raise note balance or lower gas / fee)"}
                </span>
              </div>
            )}
            {!withdrawAdvancedJson && !withdrawSpendable.length && cfg?.assets?.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                No vault note for this token — deposit or swap here first, or paste withdraw JSON under Advanced.
              </div>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Recipient (optional)</div>
            <input
              value={withdrawForm.recipient}
              onChange={(e) => setWithdrawForm({ ...withdrawForm, recipient: e.target.value })}
              placeholder={wallet.address || "0x..."}
              style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            />
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Protocol fee (wei)</div>
              <input
                value={withdrawForm.protocolFee}
                onChange={(e) => setWithdrawForm({ ...withdrawForm, protocolFee: e.target.value })}
                style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Gas refund to relayer (wei)</div>
              <input
                value={withdrawForm.gasRefund}
                onChange={(e) => setWithdrawForm({ ...withdrawForm, gasRefund: e.target.value })}
                style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            </div>
          </div>
          <button
            onClick={submitWithdraw}
            disabled={cfg?.mode !== "live" || withdrawProofBusy || !wallet?.signer}
            style={{ marginTop: 12, borderRadius: 10, background: cfg?.mode === "live" && !withdrawProofBusy ? "rgba(30,41,59,0.92)" : "rgba(51,65,85,0.45)", color: "#fff", padding: "10px 14px", fontSize: 14, fontWeight: 700, border: "1px solid rgba(148,163,184,0.22)", cursor: cfg?.mode === "live" && !withdrawProofBusy ? "pointer" : "not-allowed" }}
          >
            {withdrawProofBusy ? "Generating proof…" : "Withdraw via relayer"}
          </button>
        </div>
      )}

      {uiVariant === "trade" && tab === "internal" && !tradeNeedsUnlock && (
        <div style={{ marginTop: 14, borderRadius: 20, border: `1px solid ${PC.border}`, background: PC.card, padding: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {[
              { id: "create", label: "Create match" },
              { id: "join", label: "Join existing" },
              { id: "manage", label: "Manage my intents" },
            ].map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setInternalMatchMode(mode.id)}
                style={{
                  borderRadius: 10,
                  padding: "8px 12px",
                  border: `1px solid ${PC.border}`,
                  background: internalMatchMode === mode.id ? "rgba(0,229,199,0.18)" : "transparent",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {internalMatchMode === "create" && (
            <div style={{ borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
              <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Create internal match intent</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {["sell", "buy"].map((side) => (
                  <button
                    key={side}
                    type="button"
                    onClick={() => setOrderForm((prev) => ({ ...prev, side }))}
                    style={{
                      borderRadius: 10,
                      padding: "8px 12px",
                      border: `1px solid ${PC.border}`,
                      background: orderForm.side === side ? (side === "sell" ? "rgba(239,68,68,0.18)" : "rgba(34,197,94,0.18)") : "transparent",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {side}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input value={orderForm.baseToken} onChange={(e) => setOrderForm((prev) => ({ ...prev, baseToken: e.target.value.toUpperCase() }))} placeholder="Base token" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
                <input value={orderForm.quoteToken} onChange={(e) => setOrderForm((prev) => ({ ...prev, quoteToken: e.target.value.toUpperCase() }))} placeholder="Quote token" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                <input value={orderForm.amount} onChange={(e) => setOrderForm((prev) => ({ ...prev, amount: e.target.value }))} placeholder="Amount" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
                <input value={orderForm.price} onChange={(e) => setOrderForm((prev) => ({ ...prev, price: e.target.value }))} placeholder="Limit price" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
              </div>
              <button type="button" onClick={placeInternalOrder} style={{ marginTop: 10, width: "100%", borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", background: "rgba(30,41,59,0.92)", color: "#f8fafc", padding: "12px 14px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                Create internal match intent
              </button>
            </div>
          )}

          {internalMatchMode === "join" && (
            <div style={{ borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
              <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Join existing internal match</div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11, color: PC.muted }}>
                  <span>Price</span><span>Size</span><span>Side</span>
                </div>
                {openInternalOrders.length === 0 ? (
                  <div style={{ fontSize: 12, color: PC.muted, padding: "6px 0" }}>
                    No live internal intents yet. Create a match intent first.
                  </div>
                ) : openInternalOrders.map((order) => (
                  <div key={order.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 12, color: "#fff" }}>
                    <span>{order.price}</span>
                    <span>{order.amount}</span>
                    <span style={{ color: order.side === "sell" ? "#fca5a5" : "#bbf7d0", textTransform: "uppercase" }}>{order.side}</span>
                  </div>
                ))}
              </div>
              <button type="button" onClick={joinInternalOrder} style={{ marginTop: 12, width: "100%", borderRadius: 12, border: "1px solid rgba(148,163,184,0.22)", background: hasOpenInternalOrder ? "rgba(30,41,59,0.92)" : "rgba(51,65,85,0.45)", color: hasOpenInternalOrder ? "#f8fafc" : PC.muted, padding: "12px 14px", fontSize: 14, fontWeight: 800, cursor: hasOpenInternalOrder ? "pointer" : "not-allowed" }} disabled={!hasOpenInternalOrder}>
                Match first open intent
              </button>
            </div>
          )}

          {internalMatchMode === "manage" && (
            <div style={{ borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
              <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>My internal intents</div>
              <div style={{ display: "grid", gap: 8 }}>
                {localOrders.length === 0 ? (
                  <div style={{ fontSize: 12, color: PC.muted }}>No internal intents yet. Create one in the first tab.</div>
                ) : localOrders.map((order) => (
                  <div key={order.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "center", fontSize: 12, color: "#fff" }}>
                    <span>{order.pair}</span>
                    <span>{order.amount}</span>
                    <span>{order.price}</span>
                    <span style={{ color: order.status === "OPEN" ? "rgba(226,232,240,0.92)" : PC.muted }}>{order.status}</span>
                    <button
                      type="button"
                      disabled={order.status !== "OPEN"}
                      onClick={() => cancelInternalOrder(order.id)}
                      style={{ borderRadius: 8, border: `1px solid ${PC.border}`, background: order.status === "OPEN" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)", color: "#fff", padding: "6px 8px", fontSize: 11, cursor: order.status === "OPEN" ? "pointer" : "not-allowed" }}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showAdvanced && (
        <div style={{ marginTop: 16, borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.26)", padding: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Advanced</div>
          <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr auto" }}>
            <input
              value={importTokenSymbol}
              onChange={(e) => setImportTokenSymbol(e.target.value)}
              placeholder="Token symbol (e.g. CAKE)"
              style={{ borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            />
            <input
              value={importTokenAddress}
              onChange={(e) => setImportTokenAddress(e.target.value)}
              placeholder="Token address (0x...)"
              style={{ borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            />
            <button
              onClick={importToken}
              style={{ borderRadius: 10, background: "rgba(30,41,59,0.9)", color: "#fff", padding: "10px 14px", fontSize: 13, fontWeight: 700, border: "1px solid rgba(148,163,184,0.22)", cursor: "pointer" }}
            >
              Import token
            </button>
          </div>
          <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Relayer API URL(s)</div>
              <input
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://relayer-1.example, https://relayer-2.example"
                style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
              />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Note vault</div>
                <button
                  type="button"
                  onClick={unlockVault}
                  style={{ borderRadius: 10, background: "rgba(255,255,255,0.08)", color: "#fff", padding: "6px 10px", fontSize: 12, fontWeight: 700, border: "1px solid rgba(255,255,255,0.16)", cursor: wallet.signer ? "pointer" : "not-allowed" }}
                  disabled={!wallet.signer}
                >
                  {vault.unlocked ? "Unlocked" : "Unlock"}
                </button>
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 }}>
                Same message every time (domain + chain) so your signature derives a stable encryption key. If unlock failed before this fix, click Unlock once more after rebuilding.
              </div>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                style={{ marginTop: 4, height: 96, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12 }}
                placeholder="Paste note / proof JSON"
              />
              <button
                onClick={addNoteToVault}
                style={{ marginTop: 8, borderRadius: 10, background: "rgba(30,41,59,0.9)", color: "#fff", padding: "8px 10px", fontSize: 12, fontWeight: 700, border: "1px solid rgba(148,163,184,0.22)", cursor: "pointer" }}
                disabled={!vault.unlocked}
              >
                Save
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Swap JSON</div>
          <textarea value={intentForm.swapDataJson} onChange={(e) => setIntentForm({ ...intentForm, swapDataJson: e.target.value })} style={{ marginTop: 4, height: 112, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12, fontFamily: "var(--font-mono)" }} placeholder='{"proof":{...},"publicInputs":{...},"swapParams":{...}}' />
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Withdraw JSON</div>
          <textarea
            value={withdrawForm.withdrawDataJson}
            onChange={(e) => setWithdrawForm({ ...withdrawForm, withdrawDataJson: e.target.value })}
            style={{ marginTop: 4, height: 96, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12, fontFamily: "var(--font-mono)" }}
            placeholder='{"proof":{...},"publicInputs":{...},"recipient":"0x..."}'
          />
        </div>
      )}

      {lastResult && (
        <div
          style={{
            marginTop: 14,
            borderRadius: 16,
            border: "1px solid rgba(148,163,184,0.18)",
            background: "rgba(8,12,20,0.72)",
            padding: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(203,213,225,0.9)" }}>
            {lastResult?.txHash || lastResult?.fundingTxHash ? "Submitted on-chain" : "Result"}
          </div>
          {(lastResult?.txHash || lastResult?.fundingTxHash) && (
            <div style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)", padding: 10 }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Transaction summary</div>
              {lastResult?.txHash && (
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>Deposit tx</span>
                  <a
                    href={`${getExplorerTxBase(cfg?.chainId)}${lastResult.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: "#7dd3fc", textDecoration: "none", wordBreak: "break-all" }}
                  >
                    {lastResult.txHash}
                  </a>
                </div>
              )}
              {lastResult?.fundingTxHash && (
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>Funding tx</span>
                  <a
                    href={`${getExplorerTxBase(cfg?.chainId)}${lastResult.fundingTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: "#7dd3fc", textDecoration: "none", wordBreak: "break-all" }}
                  >
                    {lastResult.fundingTxHash}
                  </a>
                </div>
              )}
              {lastResult?.blockNumber != null && (
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>Block</span>
                  <span style={{ fontSize: 12, color: "#fff" }}>{String(lastResult.blockNumber)}</span>
                </div>
              )}
            </div>
          )}
          {lastResult?.suggestedVaultNote && (
            <div style={{ marginTop: 10 }}>
              {lastResult?.vaultSaved ? (
                <div style={{ marginBottom: 8, fontSize: 12, color: "rgba(52, 211, 153, 0.95)", lineHeight: 1.5 }}>
                  <strong>Already saved at deposit time</strong> — your vault was unlocked, so this note was written when the deposit finished. If the button below is grey and does nothing, refresh or reconnect locked the vault in memory: open <strong>Advanced → Unlock</strong> and sign again; then Swap/Withdraw can read your notes.
                </div>
              ) : null}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={importSuggestedVaultNoteFromLastDeposit}
                  title={
                    wallet?.signer
                      ? "Saves this deposit note locally. Signs vault unlock in MetaMask if the vault is still locked."
                      : "Connect wallet first"
                  }
                  style={{
                    borderRadius: 10,
                    background: wallet?.signer ? "rgba(30,41,59,0.92)" : "rgba(255,255,255,0.1)",
                    color: "#fff",
                    padding: "8px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    border: "none",
                    cursor: wallet?.signer ? "pointer" : "not-allowed",
                  }}
                  disabled={!wallet?.signer}
                >
                  Add deposit note to vault
                </button>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", maxWidth: 420 }}>
                  Required for Swap / Withdraw tabs to find a spendable note (same blinding as your deposit). If you already saved at deposit time, you only need this after a refresh or another browser.
                </span>
              </div>
            </div>
          )}
          <pre style={{ marginTop: 8, overflow: "auto", fontSize: 12, color: "rgba(255,255,255,0.9)" }}>{JSON.stringify(lastResult, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

