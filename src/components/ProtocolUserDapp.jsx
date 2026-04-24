import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { loadVault, saveVault } from "../lib/noteVault";
import { relayerFetchJson, setRuntimeRelayerBases } from "../lib/relayerHttp";
import { canUseClientProver, generateSwapProofClient } from "../lib/clientProver";
import { encryptForRelayer } from "../lib/relayEnvelope";
import { CLIENT_PROVER_WASM_URL, CLIENT_PROVER_ZKEY_URL } from "../config";
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

async function fetchJson(url, opts) {
  const headers = { "content-type": "application/json", ...(opts?.headers || {}) };
  const fetchOpts = { ...opts, headers };
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

const WBNB_BSC_TESTNET = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
const WBNB_BSC_MAINNET = "0xbb4CdB9Cbd36B01bD1cBaEBF2De08d9173bc095c";
const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
const FALLBACK_GAS_REFUND_WEI = ethers.parseEther("0.002").toString();
const SLIPPAGE_PRESETS_BPS = [50, 100, 250, 500];
const PC = {
  bg: "#14141c",
  card: "#18181f",
  border: "rgba(255,255,255,0.12)",
  teal: "#00e5c7",
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

const DEFAULT_TOKEN_LIST = [
  { symbol: "tBNB", address: ethers.ZeroAddress },
  { symbol: "BUSD", address: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
  { symbol: "USDT", address: "0x7EF95A0Fe8A5F4f9C1824fBf6656e2f95fA6Bf13" },
];

const TESTNET_MOCK_TOKENS = [
  { symbol: "tBUSD (mock)", address: "0x5A8309a15DB141777Fc39e7AB1E16D09939D8B27" },
  { symbol: "tUSDT (mock)", address: "0xafA7006bD42F70509BD3102C6f22232b79240201" },
  { symbol: "tUSDC (mock)", address: "0x5808F19EEc7328De5B9d5a6cFdaE45a726B77800" },
  { symbol: "tCAKE (mock)", address: "0xC6FC0c39C9e998182c90D0F4be41c4561Dd21967" },
];

const TOKEN_OPTIONS = [
  { label: "tBNB (native placeholder)", value: ethers.ZeroAddress },
  { label: "BUSD (test)", value: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7" },
  { label: "USDT (test)", value: "0x7EF95A0Fe8A5F4f9C1824fBf6656e2f95fA6Bf13" },
  { label: "Custom address", value: "__custom__" },
];
const SHADOW_SWEEP_GAS_BUFFER_WEI = ethers.parseEther("0.001");

function getAssetIdForToken(tokenAddress) {
  const normalized = String(tokenAddress || "").toLowerCase();
  if (normalized === ethers.ZeroAddress.toLowerCase()) return 0;
  if (normalized === "0x78867bbeeef44f2326bf8ddd1941a4439382ef2a7") return 1;
  if (normalized === "0x7ef95a0fe8a5f4f9c1824fbf6656e2f95fa6bf13") return 2;
  return 1;
}

function spendableNoteEntries(vaultData, inputToken) {
  const aid = getAssetIdForToken(inputToken);
  const notes = vaultData?.notes || [];
  const out = [];
  notes.forEach((n, vaultIdx) => {
    const raw = n.payload ?? n;
    if (raw?.version === 1 && Number(raw.assetID) === aid) out.push({ vaultIdx, note: raw });
  });
  return out;
}

function canonicalWbnb(chainId) {
  return Number(chainId) === 56 ? WBNB_BSC_MAINNET : WBNB_BSC_TESTNET;
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

function buildDefaultSwapData(intentForm, chainId) {
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
      inputAssetID: getAssetIdForToken(intentForm.inputToken),
      outputAssetIDSwap: getAssetIdForToken(intentForm.outputToken),
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
  const [apiBase, setApiBase] = useState(() => localStorage.getItem("phantom_api") || "http://localhost:5050");
  const base = useMemo(() => (apiBase || "").replace(/\/$/, "").trim(), [apiBase]);
  const [cfg, setCfg] = useState(null);
  const [health, setHealth] = useState(null);
  const [cfgErr, setCfgErr] = useState(null);

  const [wallet, setWallet] = useState({ address: null, provider: null, signer: null });
  const [walletChainId, setWalletChainId] = useState(null);
  const [connectError, setConnectError] = useState(null);

  const [vault, setVault] = useState({ unlocked: false, key: null, data: { notes: [], updatedAt: null } });
  const [, setVaultError] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [tab, setTab] = useState("swap");
  const [lastResult, setLastResult] = useState(null);
  const [actionError, setActionError] = useState(null);
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
  const [swapExpectedLabel, setSwapExpectedLabel] = useState("");
  const [swapMinLabel, setSwapMinLabel] = useState("");
  const [swapSlippageBps, setSwapSlippageBps] = useState(DEFAULT_SWAP_SLIPPAGE_BPS);
  const [swapLastQuote, setSwapLastQuote] = useState(null);
  const [swapProofBusy, setSwapProofBusy] = useState(false);
  const [swapSubmitBusy, setSwapSubmitBusy] = useState(false);
  const [withdrawProofBusy, setWithdrawProofBusy] = useState(false);
  const [clientProverReady, setClientProverReady] = useState(false);
  const [spendPick, setSpendPick] = useState(0);

  const spendable = useMemo(
    () => spendableNoteEntries(vault.data, intentForm.inputToken),
    [vault.data, intentForm.inputToken]
  );
  useEffect(() => {
    setSpendPick(0);
  }, [intentForm.inputToken]);

  const [withdrawForm, setWithdrawForm] = useState({
    token: "0x78867BbEeF44f2326bF8DDd1941a4439382EF2A7",
    amount: "",
    recipient: "",
    protocolFee: "0",
    gasRefund: ethers.parseEther("0.002").toString(),
    withdrawDataJson: "",
  });
  const withdrawSpendable = useMemo(
    () => spendableNoteEntries(vault.data, withdrawForm.token),
    [vault.data, withdrawForm.token]
  );
  const withdrawMaxPayoutWei = useMemo(() => {
    if (!withdrawSpendable.length) return null;
    try {
      const inputWei = BigInt(withdrawSpendable[0].note.amount);
      const feeWei = BigInt(String(withdrawForm.protocolFee || "0"));
      const gasWei = BigInt(String(withdrawForm.gasRefund || "0"));
      const max = inputWei - feeWei - gasWei - 1n;
      return max > 0n ? max : 0n;
    } catch {
      return null;
    }
  }, [withdrawSpendable, withdrawForm.protocolFee, withdrawForm.gasRefund]);
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
    baseToken: "tBNB",
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

  function loadTestnetMockTokens() {
    setTokenList((prev) => {
      const byAddr = new Map(prev.map((t) => [String(t.address).toLowerCase(), t]));
      for (const t of TESTNET_MOCK_TOKENS) {
        byAddr.set(String(t.address).toLowerCase(), t);
      }
      return Array.from(byAddr.values());
    });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(String(text || ""));
    } catch {
      /* ignore */
    }
  }

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
    setDepositForm((prev) => ({ ...prev, assetID: getAssetIdForToken(prev.token) }));
  }, [depositForm.token]);

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
    const assetID = getAssetIdForToken(depositForm.token);
    const ownerPk = addressToOwnerPublicKey(wallet.address);
    const c = noteCommitment(assetID, amountWei.toString(), depositBlinding, ownerPk);
    const hex = commitmentToBytes32(c);
    setDepositForm((prev) => (prev.commitment === hex ? prev : { ...prev, commitment: hex }));
  }, [wallet?.address, depositForm.token, depositForm.amount, depositBlinding]);

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
    let debounceTimer = null;
    let refreshTimer = null;
    async function run() {
      if (swapProofBusy || swapSubmitBusy) {
        setSwapQuoteLoading(false);
        return;
      }
      setSwapQuoteErr(null);
      const customJson = String(intentForm.swapDataJson || "").trim();
      let amt = String(intentForm.inputAmount || "").trim();
      if (cfg?.mode === "live" && !customJson && spendable.length > 0) {
        const i = Math.min(spendPick, spendable.length - 1);
        try {
          amt = ethers.formatUnits(spendable[i].note.amount, 18);
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
      const chainSlug = Number(cfg.chainId) === 97 ? "bsc-testnet" : "bsc";
      const isBackgroundRefresh = !!swapLastQuote;
      if (!isBackgroundRefresh) setSwapQuoteLoading(true);
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
        setSwapLastQuote(q);
        setIntentForm((p) => ({
          ...p,
          minOutputAmount: String(q.minAmountOut || "0"),
          protocolFee: String(q.fees?.totalFee ?? "0"),
          gasRefund: refund,
        }));
        setSwapExpectedLabel(`${ethers.formatUnits(q.amountOut || "0", 18)}`);
        setSwapMinLabel(`${ethers.formatUnits(q.minAmountOut || "0", 18)}`);
      } catch (e) {
        if (!cancelled && !swapLastQuote) setSwapQuoteErr(stringifyErr(e?.message ?? e));
      } finally {
        if (!cancelled && !isBackgroundRefresh) setSwapQuoteLoading(false);
      }
    }
    debounceTimer = setTimeout(async () => {
      await run();
      if (!cancelled) {
        // Keep quote fresh, but avoid noisy continuous polling.
        refreshTimer = setInterval(() => {
          if (!cancelled) run();
        }, 6000);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      clearInterval(refreshTimer);
    };
  }, [base, cfg?.chainId, cfg?.mode, intentForm.inputToken, intentForm.outputToken, intentForm.inputAmount, intentForm.swapDataJson, swapSlippageBps, spendable, spendPick, swapProofBusy, swapSubmitBusy, swapLastQuote]);

  async function connect() {
    setConnectError(null);
    setActionError(null);
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
    setWallet({ address: null, provider: null, signer: null });
    setWalletChainId(null);
    setVault({ unlocked: false, key: null, data: { notes: [], updatedAt: null } });
  }

  async function unlockVault() {
    setVaultError(null);
    if (!wallet.signer) {
      setVaultError("Connect wallet first.");
      return;
    }
    try {
      const msg = `Unlock Phantom Note Vault\n\nDomain: ${window.location.host}\nTime: ${new Date().toISOString()}`;
      const signature = await wallet.signer.signMessage(msg);
      const loaded = await loadVault({ signature });
      setVault({ unlocked: true, key: loaded.key, data: loaded.data });
    } catch (e) {
      setVaultError(e.message || String(e));
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
          chainName: "BSC Testnet",
          nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
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
    setLastResult(null);
    try {
      if (!wallet.signer) throw new Error("Connect wallet first.");
      if (!cfg?.chainId || !cfg?.addresses?.shieldedPool) throw new Error("Backend config not loaded.");
      await fetchJson(`${base}/health`);
      const activeChain = await ensureCorrectChain();
      if (activeChain && Number(activeChain) !== Number(cfg.chainId)) {
        throw new Error(`Wallet is on chain ${activeChain}, but backend expects ${cfg.chainId}.`);
      }

      const amountWei = ethers.parseUnits(String(depositForm.amount || "0"), 18);
      const assetID = Number(getAssetIdForToken(depositForm.token));
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
        const totalFunding = amountWei + feeWei + SHADOW_SWEEP_GAS_BUFFER_WEI;
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
        setLastResult({
          via: "shadow-flow",
          shadowAddress: shadow.shadowAddress,
          fundingTxHash: fundTx.hash,
          fundingWei: totalFunding.toString(),
          gasBufferWei: SHADOW_SWEEP_GAS_BUFFER_WEI.toString(),
          feeWei: feeWei.toString(),
          serverNote,
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
        setLastResult({ via: "relayer-submit", ...out });
      }

      if (vault.unlocked && vault.key && wallet.address) {
        const ownerPk = addressToOwnerPublicKey(wallet.address);
        const c = noteCommitment(assetID, amountWei.toString(), depositBlinding, ownerPk);
        const notePayload = {
          version: 1,
          assetID,
          amount: amountWei.toString(),
          blindingFactor: depositBlinding,
          ownerPublicKey: ownerPk,
          commitmentDecimal: c.toString(),
          commitmentHex: depositForm.commitment,
        };
        const next = {
          notes: [{ t: Date.now(), payload: notePayload }, ...(vault.data?.notes || [])].slice(0, 200),
          updatedAt: Date.now(),
        };
        await saveVault({ key: vault.key, data: next });
        setVault((v) => ({ ...v, data: next }));
      }
      setDepositBlinding(randomFieldElementString());
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    }
  }

  async function submitSwap() {
    setActionError(null);
    setLastResult(null);
    setSwapSubmitBusy(true);
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
      const customRaw = String(intentForm.swapDataJson || "").trim();
      if (customRaw) {
        try {
          const custom = JSON.parse(customRaw);
          if (custom && typeof custom === "object") {
            swapData = mergeSwapData(buildDefaultSwapData(intentForm, cfg.chainId), custom);
          } else {
            throw new Error("Invalid swap JSON");
          }
        } catch (e) {
          throw new Error(e.message === "Invalid swap JSON" ? e.message : "Invalid swap JSON in Advanced.");
        }
      } else {
        const pick = Math.min(spendPick, Math.max(0, spendable.length - 1));
        const entry = spendable[pick];
        if (!entry?.note) {
          throw new Error(
            "No spendable note for this input token. Unlock the vault, deposit (commitment is now circuit-derived), then swap—or paste full swap JSON under Advanced."
          );
        }
        const note = entry.note;
        const outAmt = String(swapLastQuote?.amountOut || "0");
        if (!outAmt || BigInt(outAmt) <= 0n) {
          throw new Error("Refresh the quote so expected output amount is available before proving.");
        }
        const feeBn = BigInt(String(intentForm.protocolFee || "0"));
        const gasBn = BigInt(String(intentForm.gasRefund || "0"));
        const inputAmountBn = BigInt(note.amount);
        const swapAmountBn = inputAmountBn - feeBn - gasBn;
        if (swapAmountBn <= 0n) {
          throw new Error("Note balance must be greater than protocol fee plus gas refund.");
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
            assetID: getAssetIdForToken(intentForm.outputToken),
            amount: outAmt,
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
          minOutputAmount: String(intentForm.minOutputAmount || "0"),
          protocolFee: String(intentForm.protocolFee || "0"),
          gasRefund: String(intentForm.gasRefund || "0"),
        };
        setSwapProofBusy(true);
        let gen;
        try {
          if (clientProverReady) {
            gen = await generateSwapProofClient(proofBody, {
              wasmUrl: CLIENT_PROVER_WASM_URL,
              zkeyUrl: CLIENT_PROVER_ZKEY_URL,
            });
          } else {
            gen = await fetchJson(`${base}/swap/generate-proof`, {
              method: "POST",
              body: JSON.stringify(proofBody),
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
            minAmountOut: String(intentForm.minOutputAmount || "0"),
            fee: Number(swapLastQuote?.routeParams?.feeTier || 2500),
            sqrtPriceLimitX96: String(swapLastQuote?.routeParams?.sqrtPriceLimitX96 || 0),
            path: swapLastQuote?.routeParams?.path || "0x",
          },
          noteHints: {
            swap: {
              assetId: getAssetIdForToken(intentForm.outputToken),
              amount: outAmt,
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
      const minOutForAuth = String(
        swapData.publicInputs.minOutputAmountSwap ??
          swapData.swapParams?.minAmountOut ??
          intentForm.minOutputAmount ??
          "0"
      );
      const keyInfo = await fetchJson(`${base}/relayer/encryption-key`);
      const envelope = await encryptForRelayer(
        {
          swapData,
          zkAuthorization: {
            nullifier: nullifierHex,
            deadline,
            nonce: String(noteNonce),
            minAmountOut: minOutForAuth,
          },
        },
        keyInfo?.publicKeyPem
      );
      const out = await fetchJson(`${base}/swap/encrypted`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      });
      setLastResult(out);
    } catch (e) {
      setActionError(stringifyErr(e?.message ?? e));
    } finally {
      setSwapSubmitBusy(false);
    }
  }

  async function submitWithdraw() {
    setActionError(null);
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
        const spend = spendableNoteEntries(vault.data, withdrawForm.token);
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
  }

  function placeInternalOrder() {
    const amountNum = Number(orderForm.amount);
    const priceNum = Number(orderForm.price);
    if (!Number.isFinite(amountNum) || amountNum <= 0 || !Number.isFinite(priceNum) || priceNum <= 0) {
      setActionError("Enter a valid order amount and price.");
      return;
    }
    setActionError(null);
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
  }

  const showSwapPanel = tab === "swap" || (tab === "all" && uiVariant !== "trade");
  const depthLevels = useMemo(() => ([
    { price: "312.4000", size: "5.2000", side: "sell" },
    { price: "311.9500", size: "3.7000", side: "sell" },
    { price: "311.6000", size: "2.1000", side: "sell" },
    { price: "311.1000", size: "4.9000", side: "buy" },
    { price: "310.8500", size: "6.3000", side: "buy" },
    { price: "310.4000", size: "1.9000", side: "buy" },
  ]), []);

  return (
    <div
      style={{
        maxWidth: uiVariant === "trade" ? "100%" : 760,
        margin: "0 auto",
        borderRadius: uiVariant === "trade" ? 24 : 18,
        border: uiVariant === "trade" ? `1px solid ${PC.border}` : "1px solid rgba(255,255,255,0.14)",
        background: uiVariant === "trade" ? PC.bg : "#11141b",
        padding: uiVariant === "trade" ? 16 : 20,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <div style={{ fontSize: uiVariant === "trade" ? 26 : 28, fontWeight: 700, color: uiVariant === "trade" ? PC.teal : "#fff", lineHeight: 1.15, fontFamily: "var(--font-display, Georgia, serif)" }}>
            {uiVariant === "trade" ? "InternalMatching" : "Phantom Swap"}
          </div>
          <div style={{ fontSize: 13, color: uiVariant === "trade" ? PC.muted : "rgba(255,255,255,0.65)", marginTop: 6, lineHeight: 1.45, maxWidth: 420 }}>
            {uiVariant === "trade"
              ? "Place private limit orders, choose your sell price, and match against incoming counter-orders."
              : "Deposit, swap, and withdraw through the relayer. Advanced users can edit proofs and API URL."}
          </div>
          <div style={{ fontSize: 12, marginTop: 6, color: clientProverReady ? "#18b980" : "rgba(255,255,255,0.58)" }}>
            {clientProverReady ? "Client proving enabled." : "Client proving unavailable (using relayer proving fallback)."}
          </div>
          {uiVariant === "trade" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {["Order placement", "Private matching", "Relayer settlement"].map((label) => (
                <span
                  key={label}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: PC.teal,
                    border: `1px solid rgba(0, 229, 199, 0.35)`,
                    borderRadius: 999,
                    padding: "4px 10px",
                    background: "rgba(0, 229, 199, 0.06)",
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
                background: "linear-gradient(135deg, #00e5c7 0%, #00b89c 100%)",
                color: "#0a0a0a",
                padding: "10px 16px",
                fontSize: 13,
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
                boxShadow: "0 4px 20px rgba(0, 229, 199, 0.25)",
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

      {uiVariant !== "trade" && Number(cfg?.chainId) === 97 && (
        <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.26)", padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 240 }}>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 700 }}>Testnet quick setup</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.65)" }}>
              Loads the mock tokens that have Pancake liquidity so quotes work immediately.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={loadTestnetMockTokens}
              style={{ borderRadius: 10, background: "#6d4aff", color: "#fff", padding: "8px 12px", fontSize: 12, fontWeight: 800, border: "none", cursor: "pointer" }}
              type="button"
            >
              Load mock tokens
            </button>
            <button
              onClick={() => copyToClipboard("0x5A8309a15DB141777Fc39e7AB1E16D09939D8B27")}
              style={{ borderRadius: 10, background: "rgba(255,255,255,0.08)", color: "#fff", padding: "8px 12px", fontSize: 12, fontWeight: 700, border: "1px solid rgba(255,255,255,0.14)", cursor: "pointer" }}
              type="button"
            >
              Copy tBUSD
            </button>
            <button
              onClick={() => copyToClipboard("0xC6FC0c39C9e998182c90D0F4be41c4561Dd21967")}
              style={{ borderRadius: 10, background: "rgba(255,255,255,0.08)", color: "#fff", padding: "8px 12px", fontSize: 12, fontWeight: 700, border: "1px solid rgba(255,255,255,0.14)", cursor: "pointer" }}
              type="button"
            >
              Copy tCAKE
            </button>
          </div>
        </div>
      )}

      {cfgErr && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(cfgErr)}</div>}
      {connectError && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(connectError)}</div>}
      {actionError && <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(248,113,113,0.5)", background: "rgba(185,28,28,0.18)", padding: 10, fontSize: 13, color: "#fecaca" }}>{stringifyErr(actionError)}</div>}

      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          borderRadius: uiVariant === "trade" ? 16 : 12,
          border: `1px solid ${uiVariant === "trade" ? PC.border : "rgba(255,255,255,0.12)"}`,
          background: uiVariant === "trade" ? PC.card : "rgba(0,0,0,0.26)",
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
              border: `1px solid ${row.ok ? "rgba(0, 229, 199, 0.25)" : "rgba(248, 113, 113, 0.35)"}`,
            }}
          >
            <span style={{ color: PC.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.06em" }}>{row.k}</span>
            <span style={{ color: "#fff", fontWeight: 700, fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>{row.v}</span>
          </div>
        ))}
      </div>

      {uiVariant === "trade" && (
        <div style={{ marginTop: 14, borderRadius: 20, border: `1px solid ${PC.border}`, background: PC.card, padding: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 12 }}>
            <div style={{ borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
              <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Order placement</div>
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
                <input value={orderForm.amount} onChange={(e) => setOrderForm((prev) => ({ ...prev, amount: e.target.value }))} placeholder="Amount to sell" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
                <input value={orderForm.price} onChange={(e) => setOrderForm((prev) => ({ ...prev, price: e.target.value }))} placeholder="Limit price" style={{ borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }} />
              </div>
              <button type="button" onClick={placeInternalOrder} style={{ marginTop: 10, width: "100%", borderRadius: 12, border: "none", background: `linear-gradient(90deg, ${PC.teal}, #7645d9)`, color: "#191326", padding: "12px 14px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>
                Place order
              </button>
            </div>
            <div style={{ borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
              <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Orderbook (x, y, z levels)</div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 11, color: PC.muted }}>
                  <span>Price</span><span>Size</span><span>Side</span>
                </div>
                {depthLevels.map((row, idx) => (
                  <div key={`${row.price}-${idx}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", fontSize: 12, color: "#fff" }}>
                    <span>{row.price}</span>
                    <span>{row.size}</span>
                    <span style={{ color: row.side === "sell" ? "#f87171" : "#4ade80", textTransform: "uppercase" }}>{row.side}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, borderRadius: 14, border: `1px solid ${PC.border}`, background: PC.bg, padding: 12 }}>
            <div style={{ fontSize: 12, color: PC.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Placed orders</div>
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 0.8fr", fontSize: 11, color: PC.muted }}>
                <span>Pair</span><span>Amount</span><span>Price</span><span>Total</span><span>Status</span>
              </div>
              {localOrders.length === 0 ? (
                <div style={{ fontSize: 12, color: PC.muted }}>No orders placed yet.</div>
              ) : localOrders.map((order) => (
                <div key={order.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 0.8fr", fontSize: 12, color: "#fff" }}>
                  <span>{order.pair}</span>
                  <span>{order.amount}</span>
                  <span>{order.price}</span>
                  <span>{order.total}</span>
                  <span style={{ color: PC.teal }}>{order.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {(uiVariant === "trade" ? ["swap", "withdraw"] : ["swap", "deposit", "withdraw", "all"]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => { setTab(k); setActionError(null); setLastResult(null); }}
            style={{
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 700,
              border: "1px solid rgba(255,255,255,0.14)",
              background: tab === k ? "#6d4aff" : "rgba(255,255,255,0.08)",
              color: "#fff",
              cursor: "pointer"
            }}
          >
            {k === "deposit" ? "Deposit" : k === "swap" ? "Swap" : k === "withdraw" ? "Withdraw" : "All"}
          </button>
        ))}
        {uiVariant !== "trade" && (
          <Link to="/trade" style={{ fontSize: 13, fontWeight: 700, color: PC.teal, textDecoration: "none", marginLeft: 4 }}>
            InternalMatching →
          </Link>
        )}
      </div>

      {uiVariant !== "trade" && (tab === "deposit" || tab === "all") && (
        <div style={{ marginTop: 14, borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.26)", padding: 14 }}>
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
            Unlock the note vault before deposit to save this note automatically for swaps.
          </div>
          <button onClick={submitDeposit} disabled={!canTransact} style={{ marginTop: 12, borderRadius: 10, background: canTransact ? "#18b980" : "#3a4d45", color: "#fff", padding: "10px 14px", fontSize: 14, fontWeight: 700, border: "none", cursor: canTransact ? "pointer" : "not-allowed" }}>
            Deposit
          </button>
        </div>
      )}

      {showSwapPanel && (
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
                    background: swapSlippageBps === bps ? PC.teal : "transparent",
                    color: swapSlippageBps === bps ? "#191326" : PC.text,
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
                <label style={{ display: "block" }}>
                  <span style={{ display: "block", marginBottom: 6, color: PC.text, fontWeight: 700 }}>Spend note from vault</span>
                  <select
                    value={String(Math.min(spendPick, spendable.length - 1))}
                    onChange={(e) => setSpendPick(Number(e.target.value))}
                    style={{ width: "100%", borderRadius: 10, border: `1px solid ${PC.border}`, background: "#2c2f36", color: "#fff", padding: "10px 12px", fontSize: 13 }}
                  >
                    {spendable.map((s, i) => (
                      <option key={`${s.vaultIdx}-${i}`} value={i}>
                        #{s.vaultIdx} · {ethers.formatEther(s.note.amount)} in
                      </option>
                    ))}
                  </select>
                </label>
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
                color: PC.teal,
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
            <div style={{ marginTop: 10, fontSize: 22, fontWeight: 700, color: swapQuoteLoading ? PC.muted : PC.teal, letterSpacing: "-0.02em" }}>
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
              <span>Protocol + oracle (est.)</span>
              <span style={{ color: PC.text }}>{swapLastQuote?.fees?.totalFee ? `${ethers.formatUnits(swapLastQuote.fees.totalFee, 18).slice(0, 12)} (in)` : "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span>DEX fee policy</span>
              <span style={{ color: PC.text }}>{swapLastQuote?.protocolDexFeeBps != null ? `${Number(swapLastQuote.protocolDexFeeBps) / 100}%` : "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 12 }}>
              <span>Quote source</span>
              <span style={{ color: PC.teal, fontWeight: 700, fontSize: 12, textAlign: "right" }}>
                {swapLastQuote?.quoteSource ? QUOTE_SOURCE_LABEL[swapLastQuote.quoteSource] || swapLastQuote.quoteSource : "—"}
              </span>
            </div>
            {Array.isArray(swapLastQuote?.quotePath) && swapLastQuote.quotePath.length > 0 && (
              <div style={{ marginBottom: 8, fontSize: 11, color: PC.muted, lineHeight: 1.4 }}>
                Path:{" "}
                <span style={{ color: PC.text, fontFamily: "var(--font-mono, monospace)", wordBreak: "break-all" }}>
                  {swapLastQuote.quotePath.join(" → ")}
                </span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span>Route</span>
              <span style={{ color: PC.text, fontSize: 11, maxWidth: "58%", textAlign: "right" }}>{swapLastQuote?.routeDescription ?? cfg?.features?.quoteMode ?? "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <span>Relayer gas (from your note)</span>
              <span style={{ color: PC.teal, fontWeight: 700, textAlign: "right", maxWidth: "62%" }}>
                {swapQuoteLoading
                  ? "…"
                  : `${ethers.formatEther(intentForm.gasRefund || "0")} BNB equiv.`}
              </span>
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 11, lineHeight: 1.45, color: PC.muted }}>
              The relayer broadcasts the transaction; <strong style={{ color: PC.text }}>gasRefund</strong> in your proof reimburses them from pool rules so they are not expected to spend their own BNB for your swap.
            </p>
            {!!cfg?.features && (
              <div style={{ marginTop: 8, fontSize: 11, color: PC.muted }}>
                Quote: <span style={{ color: PC.text }}>{cfg?.features?.quoteMode ?? "—"}</span>
                {" · "}
                Dry-run: <span style={{ color: PC.text }}>{cfg?.features?.dryRun ? "yes" : "no"}</span>
              </div>
            )}
            {swapQuoteErr && <div style={{ marginTop: 8, fontSize: 12, color: "#ed4b9e" }}>{swapQuoteErr}</div>}
            {cfg?.mode === "live" && !swapGasRefundOk && !swapQuoteLoading && (intentForm.inputAmount || "").trim() && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#ed4b9e" }}>Waiting for gas cover from quote (gasRefund).</div>
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
              style={{ marginTop: 14, borderRadius: 16, background: `linear-gradient(90deg, ${PC.teal}, #7645d9)`, color: "#191326", padding: "16px 18px", fontSize: 16, fontWeight: 800, border: "none", cursor: "pointer", width: "100%" }}
            >
              Connect wallet
            </button>
          ) : (
            <button
              type="button"
              onClick={submitSwap}
              disabled={!canTransact || swapQuoteLoading || swapProofBusy || swapSubmitBusy || !!swapQuoteErr || !swapGasRefundOk}
              style={{
                marginTop: 14,
                borderRadius: 16,
                background: canTransact && !swapQuoteLoading && !swapProofBusy && !swapSubmitBusy && !swapQuoteErr && swapGasRefundOk ? `linear-gradient(90deg, ${PC.teal}, #7645d9)` : "#3a3842",
                color: canTransact && !swapQuoteLoading && !swapProofBusy && !swapSubmitBusy && !swapQuoteErr && swapGasRefundOk ? "#191326" : PC.muted,
                padding: "16px 18px",
                fontSize: 16,
                fontWeight: 800,
                border: "none",
                cursor: canTransact && !swapQuoteLoading && !swapProofBusy && !swapSubmitBusy && !swapQuoteErr && swapGasRefundOk ? "pointer" : "not-allowed",
                width: "100%",
              }}
            >
              {swapProofBusy ? "Generating proof…" : swapSubmitBusy ? "Submitting swap…" : "Submit swap via relayer"}
            </button>
          )}
        </div>
      )}

      {(tab === "withdraw" || (tab === "all" && uiVariant !== "trade")) && (
        <div style={{ marginTop: 14, borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.26)", padding: 14 }}>
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
                disabled={withdrawMaxPayoutWei == null || withdrawMaxPayoutWei <= 0n || !wallet?.signer}
                onClick={() => {
                  if (withdrawMaxPayoutWei == null || withdrawMaxPayoutWei <= 0n) return;
                  setWithdrawForm((f) => ({ ...f, amount: ethers.formatUnits(withdrawMaxPayoutWei, 18) }));
                }}
                style={{
                  borderRadius: 8,
                  background: withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n ? "rgba(24,185,128,0.25)" : "rgba(255,255,255,0.06)",
                  color: "#fff",
                  padding: "6px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  border: "1px solid rgba(255,255,255,0.14)",
                  cursor: withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n ? "pointer" : "not-allowed",
                }}
              >
                Use max payout
              </button>
            </div>
            <input
              value={withdrawForm.amount}
              onChange={(e) => setWithdrawForm({ ...withdrawForm, amount: e.target.value })}
              style={{ marginTop: 4, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 14 }}
            />
            {withdrawSpendable.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.45 }}>
                First spendable note:{" "}
                <span style={{ color: PC.text }}>{ethers.formatEther(withdrawSpendable[0].note.amount)}</span> (18 decimals)
                {" "}· Max payout after fee &amp; gas:{" "}
                <span style={{ color: PC.text }}>
                  {withdrawMaxPayoutWei != null && withdrawMaxPayoutWei > 0n
                    ? ethers.formatUnits(withdrawMaxPayoutWei, 18)
                    : "— (raise note balance or lower gas / fee)"}
                </span>
              </div>
            )}
            {!withdrawSpendable.length && (
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
            style={{ marginTop: 12, borderRadius: 10, background: cfg?.mode === "live" && !withdrawProofBusy ? "#18b980" : "#3a4d45", color: "#fff", padding: "10px 14px", fontSize: 14, fontWeight: 700, border: "none", cursor: cfg?.mode === "live" && !withdrawProofBusy ? "pointer" : "not-allowed" }}
          >
            {withdrawProofBusy ? "Generating proof…" : "Withdraw via relayer"}
          </button>
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
              style={{ borderRadius: 10, background: "#6d4aff", color: "#fff", padding: "10px 14px", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer" }}
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
                  onClick={unlockVault}
                  style={{ borderRadius: 10, background: "rgba(255,255,255,0.08)", color: "#fff", padding: "6px 10px", fontSize: 12, fontWeight: 700, border: "1px solid rgba(255,255,255,0.16)", cursor: "pointer" }}
                  disabled={!wallet.signer}
                >
                  {vault.unlocked ? "Unlocked" : "Unlock"}
                </button>
              </div>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                style={{ marginTop: 4, height: 96, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12 }}
                placeholder="Paste note / proof JSON"
              />
              <button
                onClick={addNoteToVault}
                style={{ marginTop: 8, borderRadius: 10, background: "#18b980", color: "#fff", padding: "8px 10px", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer" }}
                disabled={!vault.unlocked}
              >
                Save
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Swap JSON</div>
          <textarea value={intentForm.swapDataJson} onChange={(e) => setIntentForm({ ...intentForm, swapDataJson: e.target.value })} style={{ marginTop: 4, height: 112, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12, fontFamily: "var(--font-mono)" }} placeholder='{"proof":{...},"publicInputs":{...},"swapParams":{...}}' />
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.65)" }}>Withdraw JSON</div>
          <textarea value={withdrawForm.withdrawDataJson} onChange={(e) => setWithdrawForm({ withdrawDataJson: e.target.value })} style={{ marginTop: 4, height: 96, width: "100%", borderRadius: 10, border: "1px solid rgba(255,255,255,0.16)", background: "#151a23", color: "#fff", padding: "10px 12px", fontSize: 12, fontFamily: "var(--font-mono)" }} placeholder='{"proof":{...},"publicInputs":{...},"recipient":"0x..."}' />
        </div>
      )}

      {lastResult && (
        <div
          style={{
            marginTop: 14,
            borderRadius: 16,
            border: lastResult?.txHash || lastResult?.fundingTxHash ? "1px solid rgba(0, 229, 199, 0.35)" : "1px solid rgba(255,255,255,0.12)",
            background: lastResult?.txHash || lastResult?.fundingTxHash ? "rgba(0, 229, 199, 0.06)" : "rgba(0,0,0,0.26)",
            padding: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: lastResult?.txHash || lastResult?.fundingTxHash ? PC.teal : "rgba(255,255,255,0.65)" }}>
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
          <pre style={{ marginTop: 8, overflow: "auto", fontSize: 12, color: "rgba(255,255,255,0.9)" }}>{JSON.stringify(lastResult, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

