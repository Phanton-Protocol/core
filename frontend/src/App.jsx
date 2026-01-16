import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { getQuote, createIntent, submitSwap, getReceipt, submitDeposit, submitWithdraw } from "./api";
import Receipt from "./components/Receipt.jsx";
import chains from "./data/chains.json";
import tokens from "./data/tokens.json";

export default function App() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [tokenIn, setTokenIn] = useState("");
  const [tokenOut, setTokenOut] = useState("");
  const [tokenInCustom, setTokenInCustom] = useState("");
  const [tokenOutCustom, setTokenOutCustom] = useState("");
  const [tokenInDecimals, setTokenInDecimals] = useState("18");
  const [tokenOutDecimals, setTokenOutDecimals] = useState("18");
  const [tokenOutSymbol, setTokenOutSymbol] = useState("CUSTOM");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState(null);
  const [intent, setIntent] = useState(null);
  const [intentSig, setIntentSig] = useState("");
  const [swapData, setSwapData] = useState("");
  const [builderMeta, setBuilderMeta] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("deposit");
  const [history, setHistory] = useState([]);
  const [proverInput, setProverInput] = useState("");
  const [proverResult, setProverResult] = useState("");
  const [selectedChain, setSelectedChain] = useState(chains[0]);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositAsset, setDepositAsset] = useState("");
  const [depositAssetCustom, setDepositAssetCustom] = useState("");
  const [depositDecimals, setDepositDecimals] = useState("18");
  const [depositSymbol, setDepositSymbol] = useState("CUSTOM");
  const [depositDone, setDepositDone] = useState(false);
  const [depositLedger, setDepositLedger] = useState([]);
  const [notesUnlocked, setNotesUnlocked] = useState(false);
  const [noteKey, setNoteKey] = useState(null);
  const [lastFetchedIn, setLastFetchedIn] = useState("");
  const [lastFetchedOut, setLastFetchedOut] = useState("");
  const [lastFetchedDeposit, setLastFetchedDeposit] = useState("");
  const [lastFetchedWithdraw, setLastFetchedWithdraw] = useState("");
  const [withdrawToken, setWithdrawToken] = useState("");
  const [withdrawTokenCustom, setWithdrawTokenCustom] = useState("");
  const [withdrawTokenDecimals, setWithdrawTokenDecimals] = useState("18");
  const [withdrawTokenSymbol, setWithdrawTokenSymbol] = useState("CUSTOM");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [withdrawPayload, setWithdrawPayload] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [swapPercent, setSwapPercent] = useState(0);
  const [withdrawPercent, setWithdrawPercent] = useState(0);
  const [stakingAddress, setStakingAddress] = useState(import.meta.env.VITE_RELAYER_STAKING_ADDRESS || "");
  const [protocolTokenAddress, setProtocolTokenAddress] = useState(import.meta.env.VITE_PROTOCOL_TOKEN_ADDRESS || "");
  const [stakeAmount, setStakeAmount] = useState("");
  const [stakingRewards, setStakingRewards] = useState([]);
  const [stakedBalance, setStakedBalance] = useState("0");
  const [poseidon, setPoseidon] = useState(null);
  const [selectedNote, setSelectedNote] = useState("");
  const [poseidonError, setPoseidonError] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState({});

  async function connect() {
    setError("");
    if (!window.ethereum) {
      setError("Wallet not found");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const addr = await signer.getAddress();
    const network = await provider.getNetwork();
    setAccount(addr);
    setChainId(network.chainId.toString());
    setNotesUnlocked(false);
    setNoteKey(null);
    setDepositLedger([]);
  }

  function resolveTokenAddress(token, custom) {
    if (token === "custom") return custom.trim();
    return token;
  }

  const chainTokens = useMemo(
    () => tokens.filter((t) => String(t.chainId) === String(selectedChain.id)),
    [selectedChain]
  );

  function resolveToken(token, custom, decimals, symbol) {
    if (token === "custom") return { address: custom.trim(), decimals: Number(decimals || 18), symbol: symbol || "CUSTOM", assetId: 0 };
    const found = chainTokens.find((t) => t.address === token);
    return found || { address: "", decimals: 18, symbol: "TOKEN", assetId: 0 };
  }

  function formatAmount(value, decimals) {
    try {
      return ethers.formatUnits(value, decimals);
    } catch {
      return value;
    }
  }

  async function fetchTokenMeta(address) {
    if (!window.ethereum) return null;
    if (!ethers.isAddress(address)) return null;
    const provider = new ethers.BrowserProvider(window.ethereum);
    const erc20 = new ethers.Contract(address, [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ], provider);
    try {
      const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
      return { symbol, decimals: String(decimals) };
    } catch {
      return null;
    }
  }

  async function fetchMerklePath(commitment) {
    const res = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:5050"}/merkle/${commitment}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function autoFillMeta(address, setSymbol, setDecimals, setLastFetched) {
    const meta = await fetchTokenMeta(address);
    if (!meta) return;
    setSymbol(meta.symbol);
    setDecimals(meta.decimals);
    setLastFetched(address);
  }

  async function unlockNotes() {
    setError("");
    if (!window.ethereum) {
      setError("Wallet not found");
      return;
    }
    if (!account) {
      setError("Connect wallet first");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const sig = await signer.signMessage("ShadowDeFi Note Key v1");
    const keyBytes = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(sig)));
    const key = await window.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    setNoteKey(key);
    setNotesUnlocked(true);
    const entries = await loadDepositsEncrypted(account, key);
    setDepositLedger(entries);
  }

  async function ensurePoseidon() {
    if (poseidon) return poseidon;
    try {
      // Use mock Poseidon for UI testing (replace with real circomlibjs for production)
      const mod = await import("./mockPoseidon.js");
      const p = await mod.default();
      setPoseidon(p);
      setPoseidonError("");
      return p;
    } catch (err) {
      console.error("Poseidon init error:", err);
      const errMsg = err?.message || err?.toString() || "Poseidon init failed";
      setPoseidonError(errMsg);
      setError(errMsg);
      return null;
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/config.json");
        if (!res.ok) return;
        const data = await res.json();
        setRuntimeConfig(data || {});
        if (data?.relayerStakingAddress && !stakingAddress) setStakingAddress(data.relayerStakingAddress);
        if (data?.protocolTokenAddress && !protocolTokenAddress) setProtocolTokenAddress(data.protocolTokenAddress);
      } catch {
        // ignore
      }
    })();
  }, []);

  async function loadStaking() {
    setError("");
    if (!stakingAddress) {
      setError("Missing staking address");
      return;
    }
    if (!account) {
      setError("Connect wallet first");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const stakingAbi = [
      "function getRewardTokens() view returns (address[])",
      "function pendingReward(address user,address feeToken) view returns (uint256)",
      "function stakedBalance(address user) view returns (uint256)",
      "function claim(address feeToken) external"
    ];
    const staking = new ethers.Contract(stakingAddress, stakingAbi, provider);
    const rewards = await staking.getRewardTokens();
    const pending = await Promise.all(rewards.map(async (token) => {
      const amount = await staking.pendingReward(account, token);
      let symbol = "BNB";
      let decimals = 18;
      if (token !== ethers.ZeroAddress) {
        const meta = await fetchTokenMeta(token);
        symbol = meta?.symbol || "TOKEN";
        decimals = Number(meta?.decimals || 18);
      }
      return { token, amount: amount.toString(), symbol, decimals };
    }));
    const staked = await staking.stakedBalance(account);
    setStakedBalance(staked.toString());
    setStakingRewards(pending);
  }

  async function claimReward(token) {
    setError("");
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const stakingAbi = ["function claim(address feeToken) external"];
    const staking = new ethers.Contract(stakingAddress, stakingAbi, signer);
    await staking.claim(token);
    await loadStaking();
  }

  async function stakeTokens() {
    setError("");
    if (!protocolTokenAddress || !stakingAddress) {
      setError("Missing staking/token address");
      return;
    }
    if (!stakeAmount) {
      setError("Stake amount required");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const token = new ethers.Contract(protocolTokenAddress, [
      "function approve(address spender,uint256 amount) external returns (bool)",
      "function decimals() view returns (uint8)"
    ], signer);
    const staking = new ethers.Contract(stakingAddress, [
      "function stake(uint256 amount) external"
    ], signer);
    const decimals = await token.decimals();
    const amount = ethers.parseUnits(stakeAmount, decimals);
    await token.approve(stakingAddress, amount);
    await staking.stake(amount);
    setStakeAmount("");
    await loadStaking();
  }

  async function unstakeTokens() {
    setError("");
    if (!stakingAddress || !stakeAmount) {
      setError("Missing staking address or amount");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const staking = new ethers.Contract(stakingAddress, [
      "function unstake(uint256 amount) external",
    ], signer);
    const amount = ethers.parseUnits(stakeAmount, 18);
    await staking.unstake(amount);
    setStakeAmount("");
    await loadStaking();
  }

  async function fetchQuote() {
    setError("");
    const inToken = resolveToken(tokenIn, tokenInCustom, tokenInDecimals, "");
    const outToken = resolveToken(tokenOut, tokenOutCustom, tokenOutDecimals, tokenOutSymbol);
    if (!inToken.address || !outToken.address) {
      setError("Token address required");
      return;
    }
    const data = await getQuote({
      tokenIn: inToken.address,
      tokenOut: outToken.address,
      amountIn,
      tokenInDecimals: inToken.decimals,
      tokenOutDecimals: outToken.decimals,
      slippageBps: Number(slippageBps),
      chainSlug: selectedChain.slug
    });
    setQuote(data);
  }

  async function createSwapIntent() {
    setError("");
    if (!quote) throw new Error("Get quote first");
    const payload = {
      userAddress: account,
      nullifier: ethers.ZeroHash,
      minOutputAmount: quote.minAmountOut,
      protocolFee: "0",
      gasRefund: "0",
      deadline: Math.floor(Date.now() / 1000) + 300
    };
    const data = await createIntent(payload);
    setIntent(data);
  }

  async function signIntent() {
    setError("");
    if (!intent) return;
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const sig = await signer.signTypedData(intent.domain, intent.types, intent.intent);
    setIntentSig(sig);
  }

  async function submit() {
    setError("");
    if (!depositDone) {
      setError("Deposit required before swapping");
      return;
    }
    if (!intent || !intentSig) throw new Error("Intent not signed");
    const parsedSwap = JSON.parse(swapData);
    const res = await submitSwap({
      intentId: intent.intentId,
      intent: intent.intent,
      intentSig,
      swapData: parsedSwap
    });
    const full = await getReceipt(intent.intentId);
    setReceipt({ api: res, receipt: full });
  }

  async function loadHistory() {
    if (!account) return;
    const res = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:5050"}/history/${account}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setHistory(data);
  }

  async function generateProof() {
    setError("");
    const res = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:5050"}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: proverInput
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setProverResult(JSON.stringify(data, null, 2));
  }

  async function deposit() {
    setError("");
    try {
      if (!account) {
        setError("Connect wallet first");
        return;
      }
      if (!window.ethereum) {
        setError("Wallet not found");
        return;
      }
      if (!notesUnlocked || !noteKey) {
        setError("Unlock notes to encrypt local storage");
        return;
      }
      const poolAddress = import.meta.env.VITE_SHIELDED_POOL_ADDRESS || runtimeConfig.shieldedPoolAddress;
      if (!poolAddress) {
        setError("Missing VITE_SHIELDED_POOL_ADDRESS");
        return;
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const asset = resolveToken(depositAsset, depositAssetCustom, depositDecimals, depositSymbol || "TOKEN");
      if (!asset.address) {
        setError("Deposit token required");
        return;
      }
      if (!depositAmount) {
        setError("Deposit amount required");
        return;
      }
      const amount = ethers.parseUnits(depositAmount, asset.decimals);
      const poseidonFn = await ensurePoseidon();
      if (!poseidonFn) {
        setError(poseidonError || "Poseidon not ready");
        return;
      }
      const ownerKey = BigInt(ethers.keccak256(ethers.toUtf8Bytes(account))) % poseidonFn.F.p;
      const blinding = BigInt(ethers.hexlify(ethers.randomBytes(31))) % poseidonFn.F.p;
      const assetId = asset.assetId || 0;
      const commitmentBig = poseidonFn([BigInt(assetId), BigInt(amount), blinding, ownerKey]);
      const commitment = `0x${commitmentBig.toString(16).padStart(64, "0")}`;
      const poolAbi = [
        "function deposit(address token,uint256 amount,bytes32 commitment,uint256 assetID) external payable"
      ];
      const pool = new ethers.Contract(poolAddress, poolAbi, signer);
      let receipt;
      
      // BNB deposits are DIRECT (user pays), ERC20 deposits are RELAYED (shadow address)
      if (asset.address === ethers.ZeroAddress) {
        // BNB: Direct deposit (user → pool)
        const tx = await pool.deposit(ethers.ZeroAddress, amount, commitment, 0, { value: amount });
        receipt = await tx.wait();
      } else {
        const erc20 = new ethers.Contract(asset.address, [
          "function approve(address spender,uint256 amount) external returns (bool)"
        ], signer);
        await erc20.approve(poolAddress, amount);
        const assetId = asset.assetId || 1;
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const domain = {
          name: "ShadowDeFiRelayer",
          version: "1",
          chainId: Number(chainId || selectedChain.id),
          verifyingContract: poolAddress
        };
        const types = {
          Deposit: [
            { name: "depositor", type: "address" },
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "commitment", type: "bytes32" },
            { name: "assetID", type: "uint256" },
            { name: "deadline", type: "uint256" }
          ]
        };
        const depositIntent = {
          depositor: account,
          token: asset.address,
          amount: amount.toString(),
          commitment,
          assetID: assetId,
          deadline
        };
        const signature = await signer.signTypedData(domain, types, depositIntent);
        const tx = await submitDeposit({ ...depositIntent, signature });
        receipt = tx;
      }
      const entry = {
        token: asset.address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        amount: amount.toString(),
        commitment,
        assetId,
        blinding: blinding.toString(),
        ownerKey: ownerKey.toString(),
        txHash: receipt?.hash || receipt?.txHash,
        ts: Date.now()
      };
      const nextLedger = [...depositLedger, entry];
      await saveDepositsEncrypted(account, nextLedger, noteKey);
      setDepositLedger(nextLedger);
      setDepositDone(true);
      setTab("swap");
    } catch (e) {
      setError(e?.message || "Deposit failed");
    }
  }

  function buildWithdrawPayload() {
    try {
      if (!proverResult) throw new Error("Generate proof first");
      if (!withdrawRecipient) throw new Error("Recipient required");
      const proofPayload = JSON.parse(proverResult);
      const publicSignals = proofPayload.publicSignals || [];
      const publicInputs = {
        nullifier: publicSignals[0] || ethers.ZeroHash,
        inputCommitment: publicSignals[1] || ethers.ZeroHash,
        outputCommitmentSwap: publicSignals[2] || ethers.ZeroHash,
        outputCommitmentChange: publicSignals[3] || ethers.ZeroHash,
        merkleRoot: publicSignals[4] || ethers.ZeroHash,
        outputAmountSwap: publicSignals[5] || "0",
        minOutputAmountSwap: publicSignals[6] || "0",
        protocolFee: publicSignals[7] || "0",
        gasRefund: publicSignals[8] || "0",
        merklePath: publicSignals.slice(9, 19).map((v) => v || "0"),
        merklePathIndices: publicSignals.slice(19, 29).map((v) => v || "0"),
        inputAssetID: 0,
        outputAssetIDSwap: 0,
        outputAssetIDChange: 0,
        inputAmount: "0",
        swapAmount: "0",
        changeAmount: "0"
      };
      const payload = {
        proof: proofPayload.proof,
        publicInputs,
        relayer: ethers.ZeroAddress,
        recipient: withdrawRecipient,
        encryptedPayload: "0x"
      };
      setWithdrawPayload(JSON.stringify(payload, null, 2));
      if (notesUnlocked && noteKey) {
        const nextLedger = depositLedger.filter((n) => n.commitment !== publicInputs.inputCommitment);
        saveDepositsEncrypted(account, nextLedger, noteKey);
        setDepositLedger(nextLedger);
      }
    } catch (e) {
      setError(e.message || "Failed to build withdraw payload");
    }
  }

  async function submitWithdrawPayload() {
    setError("");
    try {
      const parsed = JSON.parse(withdrawPayload);
      const res = await submitWithdraw({ withdrawData: parsed });
      setReceipt({ api: res, receipt: null });
    } catch (e) {
      setError(e.message || "Withdraw submit failed");
    }
  }

  function buildSwapData() {
    try {
      const proofPayload = JSON.parse(proverResult);
      const meta = JSON.parse(builderMeta || "{}");
      const input = proverInput ? JSON.parse(proverInput) : null;
      const publicSignals = proofPayload.publicSignals || [];

      const publicInputs = {
        nullifier: publicSignals[0] || ethers.ZeroHash,
        inputCommitment: publicSignals[1] || ethers.ZeroHash,
        outputCommitmentSwap: publicSignals[2] || ethers.ZeroHash,
        outputCommitmentChange: publicSignals[3] || ethers.ZeroHash,
        merkleRoot: publicSignals[4] || ethers.ZeroHash,
        outputAmountSwap: publicSignals[5] || "0",
        minOutputAmountSwap: publicSignals[6] || "0",
        protocolFee: publicSignals[7] || "0",
        gasRefund: publicSignals[8] || "0",
        merklePath: publicSignals.slice(9, 19).map((v) => v || "0"),
        merklePathIndices: publicSignals.slice(19, 29).map((v) => v || "0"),
        inputAssetID: meta.inputAssetID || input?.inputAssetID || 0,
        outputAssetIDSwap: meta.outputAssetIDSwap || input?.outputAssetIDSwap || 0,
        outputAssetIDChange: meta.outputAssetIDChange || input?.outputAssetIDChange || 0,
        inputAmount: meta.inputAmount || input?.inputAmount || "0",
        swapAmount: meta.swapAmount || input?.swapAmount || "0",
        changeAmount: meta.changeAmount || input?.changeAmount || "0"
      };

      const tokenInResolved = resolveToken(tokenIn, tokenInCustom, tokenInDecimals, "");
      const tokenOutResolved = resolveToken(tokenOut, tokenOutCustom, tokenOutDecimals, tokenOutSymbol);
      const autoSwapParams = {
        tokenIn: tokenInResolved.address,
        tokenOut: tokenOutResolved.address,
        amountIn: publicInputs.swapAmount,
        minAmountOut: publicInputs.minOutputAmountSwap,
        fee: 0,
        sqrtPriceLimitX96: 0,
        path: "0x"
      };

      const payload = {
        proof: proofPayload.proof,
        publicInputs,
        swapParams: meta.swapParams || autoSwapParams,
        relayer: meta.relayer || ethers.ZeroAddress,
        encryptedPayload: meta.encryptedPayload || "0x"
      };

      setSwapData(JSON.stringify(payload, null, 2));
      if (notesUnlocked && noteKey) {
        const nextLedger = depositLedger.filter((n) => n.commitment !== publicInputs.inputCommitment);
        if (publicInputs.outputCommitmentSwap && meta.outputAmountSwap && meta.outputAssetIDSwap) {
          nextLedger.push({
            token: meta.outputTokenSwap || tokenOutResolved.address || ethers.ZeroAddress,
            symbol: meta.outputSymbolSwap || tokenOutResolved.symbol || "TOKEN",
            decimals: meta.outputDecimalsSwap || tokenOutResolved.decimals || 18,
            amount: String(meta.outputAmountSwap || publicInputs.outputAmountSwap),
            commitment: publicInputs.outputCommitmentSwap,
            ts: Date.now(),
            kind: "swap"
          });
        }
        if (publicInputs.outputCommitmentChange && meta.changeAmount && meta.outputAssetIDChange) {
          nextLedger.push({
            token: meta.outputTokenChange || tokenInResolved.address || ethers.ZeroAddress,
            symbol: meta.outputSymbolChange || tokenInResolved.symbol || "TOKEN",
            decimals: meta.outputDecimalsChange || tokenInResolved.decimals || 18,
            amount: String(meta.changeAmount || publicInputs.changeAmount),
            commitment: publicInputs.outputCommitmentChange,
            ts: Date.now(),
            kind: "change"
          });
        }
        saveDepositsEncrypted(account, nextLedger, noteKey);
        setDepositLedger(nextLedger);
      }
    } catch (e) {
      setError(e.message || "Failed to build swapData");
    }
  }

  async function buildProverInputFromNote() {
    setError("");
    if (!selectedNote) {
      setError("Select a note");
      return;
    }
    const note = depositLedger.find((n) => n.commitment === selectedNote);
    if (!note) {
      setError("Note not found");
      return;
    }
    if (!quote) {
      setError("Get quote first");
      return;
    }
    const poseidonFn = await ensurePoseidon();
    if (!poseidonFn) {
      setError(poseidonError || "Poseidon not ready");
      return;
    }
    const merkle = await fetchMerklePath(note.commitment);
    const outputAssetIdSwap = resolveToken(tokenOut, tokenOutCustom, tokenOutDecimals, tokenOutSymbol).assetId || 0;
    const outputAmountSwap = quote.amountOut;
    const minOutputAmountSwap = quote.minAmountOut;
    const swapAmount = ethers.parseUnits(amountIn, resolveToken(tokenIn, tokenInCustom, tokenInDecimals, "").decimals).toString();
    const protocolFee = quote.fees?.totalFee || "0";
    const gasRefund = "0";
    const inputAmount = note.amount;
    const changeAmount = (BigInt(inputAmount) - BigInt(swapAmount) - BigInt(protocolFee) - BigInt(gasRefund)).toString();
    const ownerKey = BigInt(note.ownerKey);
    const swapBlinding = BigInt(ethers.hexlify(ethers.randomBytes(31))) % poseidonFn.F.p;
    const changeBlinding = BigInt(ethers.hexlify(ethers.randomBytes(31))) % poseidonFn.F.p;
    const outputCommitmentSwap = poseidonFn([BigInt(outputAssetIdSwap), BigInt(outputAmountSwap), swapBlinding, ownerKey]);
    const outputCommitmentChange = poseidonFn([BigInt(note.assetId), BigInt(changeAmount), changeBlinding, ownerKey]);
    const inputCommitment = BigInt(note.commitment);
    const nullifier = poseidonFn([inputCommitment, ownerKey]);

    const input = {
      inputAssetID: String(note.assetId),
      inputAmount: String(inputAmount),
      inputBlindingFactor: String(note.blinding),
      ownerPublicKey: String(ownerKey),
      outputAssetIDSwap: String(outputAssetIdSwap),
      outputAmountSwap: String(outputAmountSwap),
      swapBlindingFactor: String(swapBlinding),
      outputAssetIDChange: String(note.assetId),
      changeAmount: String(changeAmount),
      changeBlindingFactor: String(changeBlinding),
      swapAmount: String(swapAmount),
      nullifier: String(nullifier),
      inputCommitment: String(inputCommitment),
      outputCommitmentSwap: String(outputCommitmentSwap),
      outputCommitmentChange: String(outputCommitmentChange),
      merkleRoot: String(BigInt(merkle.merkleRoot)),
      outputAmountSwapPublic: String(outputAmountSwap),
      minOutputAmountSwap: String(minOutputAmountSwap),
      protocolFee: String(protocolFee),
      gasRefund: String(gasRefund),
      merklePath: merkle.merklePath.map((v) => String(BigInt(v))),
      merklePathIndices: merkle.merklePathIndices
    };
    setProverInput(JSON.stringify(input, null, 2));
  }

  useEffect(() => {
    if (tokenIn === "custom" && ethers.isAddress(tokenInCustom) && tokenInCustom !== lastFetchedIn) {
      autoFillMeta(tokenInCustom, () => {}, setTokenInDecimals, setLastFetchedIn);
    }
  }, [tokenIn, tokenInCustom, lastFetchedIn]);

  useEffect(() => {
    if (tokenOut === "custom" && ethers.isAddress(tokenOutCustom) && tokenOutCustom !== lastFetchedOut) {
      autoFillMeta(tokenOutCustom, setTokenOutSymbol, setTokenOutDecimals, setLastFetchedOut);
    }
  }, [tokenOut, tokenOutCustom, lastFetchedOut]);

  useEffect(() => {
    if (depositAsset === "custom" && ethers.isAddress(depositAssetCustom) && depositAssetCustom !== lastFetchedDeposit) {
      autoFillMeta(depositAssetCustom, setDepositSymbol, setDepositDecimals, setLastFetchedDeposit);
    }
  }, [depositAsset, depositAssetCustom, lastFetchedDeposit]);

  useEffect(() => {
    if (withdrawToken === "custom" && ethers.isAddress(withdrawTokenCustom) && withdrawTokenCustom !== lastFetchedWithdraw) {
      autoFillMeta(withdrawTokenCustom, setWithdrawTokenSymbol, setWithdrawTokenDecimals, setLastFetchedWithdraw);
    }
  }, [withdrawToken, withdrawTokenCustom, lastFetchedWithdraw]);

  function toBase64(bytes) {
    let binary = "";
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }

  function fromBase64(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function saveDepositsEncrypted(addr, entries, key) {
    if (!addr) return;
    try {
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(JSON.stringify(entries));
      const cipher = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
      const payload = { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
      localStorage.setItem(`shadow:notes:${addr}`, JSON.stringify(payload));
    } catch {
      // no-op
    }
  }

  async function loadDepositsEncrypted(addr, key) {
    if (!addr) return [];
    try {
      const raw = localStorage.getItem(`shadow:notes:${addr}`);
      if (raw) {
        const payload = JSON.parse(raw);
        const iv = fromBase64(payload.iv);
        const data = fromBase64(payload.data);
        const plain = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        return JSON.parse(new TextDecoder().decode(plain));
      }
      const legacy = localStorage.getItem(`shadow:deposits:${addr}`);
      if (legacy) {
        const parsed = JSON.parse(legacy);
        await saveDepositsEncrypted(addr, parsed, key);
        localStorage.removeItem(`shadow:deposits:${addr}`);
        return parsed;
      }
      return [];
    } catch {
      return [];
    }
  }

  const depositBalances = useMemo(() => {
    const totals = new Map();
    for (const entry of depositLedger) {
      const key = entry.token || ethers.ZeroAddress;
      const prev = totals.get(key) || { amount: 0n, symbol: entry.symbol, decimals: entry.decimals };
      totals.set(key, {
        amount: prev.amount + BigInt(entry.amount),
        symbol: entry.symbol || prev.symbol,
        decimals: entry.decimals ?? prev.decimals
      });
    }
    return Array.from(totals.entries()).map(([token, info]) => ({ token, ...info }));
  }, [depositLedger]);

  const shadowId = useMemo(() => {
    if (!account) return "";
    return `${ethers.keccak256(ethers.toUtf8Bytes(account)).slice(0, 10)}...`;
  }, [account]);

  function getBalanceFor(tokenAddress) {
    const addr = tokenAddress || ethers.ZeroAddress;
    const entry = depositBalances.find((b) => b.token === addr);
    return entry || { amount: 0n, symbol: "TOKEN", decimals: 18 };
  }

  function amountFromPercent(balance, decimals, percent) {
    const pct = BigInt(Math.max(0, Math.min(100, Number(percent))));
    const amount = (balance * pct) / 100n;
    return ethers.formatUnits(amount, decimals);
  }

  const swapTokenIn = useMemo(() => resolveToken(tokenIn, tokenInCustom, tokenInDecimals, ""), [tokenIn, tokenInCustom, tokenInDecimals, chainTokens]);
  const swapTokenOut = useMemo(() => resolveToken(tokenOut, tokenOutCustom, tokenOutDecimals, tokenOutSymbol), [tokenOut, tokenOutCustom, tokenOutDecimals, tokenOutSymbol, chainTokens]);

  return (
    <div className="container">
      <h2>Shadow-DeFi</h2>

      <div className="card">
        <div className="row">
          <button onClick={connect}>Connect Wallet</button>
          <div className="mono">{account}</div>
          <div className="mono">Chain: {chainId}</div>
          <select value={selectedChain.id} onChange={(e) => {
            const next = chains.find((c) => String(c.id) === e.target.value);
            setSelectedChain(next);
          }}>
            {chains.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => setTab("deposit")}>Deposit</button>
        <button onClick={() => setTab("swap")}>Swap</button>
        <button onClick={() => setTab("withdraw")}>Withdraw</button>
        <button className="secondary" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide Advanced" : "Show Advanced"}
        </button>
        <button className="secondary" onClick={() => { setTab("history"); loadHistory(); }}>History</button>
        <button className="secondary" onClick={() => setTab("staking")}>Staking</button>
        <button className="secondary" onClick={() => setTab("settings")}>Settings</button>
        <button className="secondary" onClick={() => setTab("prover")}>Prover</button>
      </div>

      {tab === "deposit" && (
        <div className="flow-card">
          <div className="flow-card-header">
            <h3>Deposit</h3>
            <div className="flow-badge">Private</div>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button onClick={unlockNotes}>Unlock Notes</button>
            <div className="mono">{notesUnlocked ? "✓ Notes unlocked" : "Notes locked"}</div>
          </div>
          {shadowId && (
            <div style={{ opacity: 0.7, marginBottom: 12, fontSize: 13 }}>
              Shadow address: <span className="mono">{shadowId}</span>
            </div>
          )}
          <div className="flow-panel">
            <div className="flow-panel-label">Token</div>
          <select value={depositAsset} onChange={(e) => setDepositAsset(e.target.value)}>
            <option value="">Select token</option>
            {chainTokens.map((t) => (
              <option key={t.address} value={t.address}>{t.symbol} {t.name ? `- ${t.name}` : ""}</option>
            ))}
            <option value="custom">Custom Token...</option>
          </select>
            {depositAsset === "custom" && (
              <input placeholder="Token Address" value={depositAssetCustom} onChange={(e) => setDepositAssetCustom(e.target.value)} style={{ marginTop: 8 }} />
            )}
            {depositAsset === "custom" && showAdvanced && (
              <div className="row" style={{ marginTop: 8 }}>
                <input placeholder="Symbol" value={depositSymbol} onChange={(e) => setDepositSymbol(e.target.value)} />
                <input placeholder="Decimals" value={depositDecimals} onChange={(e) => setDepositDecimals(e.target.value)} />
              </div>
            )}
          </div>
          <div className="flow-panel" style={{ marginTop: 12 }}>
            <div className="flow-panel-label">Amount</div>
            <input placeholder="0.0" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
          </div>
          <button className="flow-btn" onClick={deposit} style={{ marginTop: 16 }}>Deposit</button>
          <div style={{ opacity: 0.6, marginTop: 12, fontSize: 13 }}>
            <b>BNB:</b> Direct from your wallet (fee deducted). <b>ERC20:</b> Relayed via shadow address (approve first).
          </div>
          {depositBalances.length > 0 && (
            <div style={{ marginTop: 16, padding: 12, background: "rgba(37,99,235,0.1)", borderRadius: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Shielded Balance</div>
              {depositBalances.map((b) => (
                <div key={b.token} className="mono" style={{ fontSize: 14 }}>
                  {formatAmount(b.amount, b.decimals)} {b.symbol}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "withdraw" && (
        <div className="flow-card">
          <div className="flow-card-header">
            <h3>Withdraw</h3>
            <div className="flow-badge">Private</div>
          </div>
          <div style={{ opacity: 0.7, marginBottom: 12, fontSize: 13 }}>
            Withdraw from your shielded balance. Requires a proof built in the Prover tab.
          </div>
          <div className="flow-panel">
            <div className="flow-panel-label">Token</div>
            <select value={withdrawToken} onChange={(e) => setWithdrawToken(e.target.value)}>
              <option value="">Select token</option>
              {chainTokens.map((t) => (
                <option key={t.address} value={t.address}>{t.symbol} {t.name ? `- ${t.name}` : ""}</option>
              ))}
              <option value="custom">Custom Token...</option>
            </select>
            {withdrawToken === "custom" && (
              <>
                <input placeholder="Token Address" value={withdrawTokenCustom} onChange={(e) => setWithdrawTokenCustom(e.target.value)} style={{ marginTop: 8 }} />
                {showAdvanced && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <input placeholder="Symbol" value={withdrawTokenSymbol} onChange={(e) => setWithdrawTokenSymbol(e.target.value)} />
                    <input placeholder="Decimals" value={withdrawTokenDecimals} onChange={(e) => setWithdrawTokenDecimals(e.target.value)} />
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flow-panel" style={{ marginTop: 12 }}>
            <div className="flow-panel-label">Amount</div>
            <input placeholder="0.0" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
              Balance: {formatAmount(getBalanceFor(resolveToken(withdrawToken, withdrawTokenCustom, withdrawTokenDecimals, "").address).amount,
              getBalanceFor(resolveToken(withdrawToken, withdrawTokenCustom, withdrawTokenDecimals, "").address).decimals)}{" "}
              {getBalanceFor(resolveToken(withdrawToken, withdrawTokenCustom, withdrawTokenDecimals, "").address).symbol}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <input
              type="range"
              min="0"
              max="100"
              value={withdrawPercent}
              onChange={(e) => {
                const pct = Number(e.target.value);
                setWithdrawPercent(pct);
                const bal = getBalanceFor(resolveToken(withdrawToken, withdrawTokenCustom, withdrawTokenDecimals, "").address);
                setWithdrawAmount(amountFromPercent(bal.amount, bal.decimals, pct));
              }}
            />
            <div className="mono">{withdrawPercent}%</div>
          </div>
          <div className="flow-panel" style={{ marginTop: 12 }}>
            <div className="flow-panel-label">Recipient</div>
            <input placeholder="0x..." value={withdrawRecipient} onChange={(e) => setWithdrawRecipient(e.target.value)} />
          </div>
          <button className="flow-btn" onClick={buildWithdrawPayload} style={{ marginTop: 16 }}>Build Withdraw Payload</button>
          {withdrawPayload && (
            <>
              <textarea rows="6" value={withdrawPayload} onChange={(e) => setWithdrawPayload(e.target.value)} style={{ marginTop: 12 }} />
              <button className="flow-btn" onClick={submitWithdrawPayload} style={{ marginTop: 12 }}>Submit Withdraw</button>
            </>
          )}
        </div>
      )}

      {tab === "swap" && (
      <div className="flow-card">
        <div className="flow-card-header">
          <h3>Swap</h3>
          <div className="flow-badge">Private via PancakeSwap</div>
        </div>
        <div className="flow-panel">
          <div className="flow-panel-label">From</div>
          <select value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>
            <option value="">Select token</option>
            {chainTokens.map((t) => (
              <option key={t.address} value={t.address}>{t.symbol} {t.name ? `- ${t.name}` : ""}</option>
            ))}
            <option value="custom">Custom Token...</option>
          </select>
          {tokenIn === "custom" && (
            <>
              <input placeholder="Token In Address" value={tokenInCustom} onChange={(e) => setTokenInCustom(e.target.value)} style={{ marginTop: 8 }} />
              {showAdvanced && (
                <input placeholder="Token In Decimals (e.g. 18)" value={tokenInDecimals} onChange={(e) => setTokenInDecimals(e.target.value)} style={{ marginTop: 8 }} />
              )}
            </>
          )}
          <input placeholder="0.0" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} style={{ marginTop: 8 }} />
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
            Balance: {formatAmount(getBalanceFor(swapTokenIn.address).amount, getBalanceFor(swapTokenIn.address).decimals)}{" "}
            {getBalanceFor(swapTokenIn.address).symbol}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            type="range"
            min="0"
            max="100"
            value={swapPercent}
            onChange={(e) => {
              const pct = Number(e.target.value);
              setSwapPercent(pct);
              const bal = getBalanceFor(swapTokenIn.address);
              setAmountIn(amountFromPercent(bal.amount, bal.decimals, pct));
            }}
          />
          <div className="mono">{swapPercent}%</div>
        </div>
        <div className="flow-arrow">↓</div>
        <div className="flow-panel">
          <div className="flow-panel-label">To</div>
          <select value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>
            <option value="">Select token</option>
            {chainTokens.map((t) => (
              <option key={t.address} value={t.address}>{t.symbol} {t.name ? `- ${t.name}` : ""}</option>
            ))}
            <option value="custom">Custom Token...</option>
          </select>
          {tokenOut === "custom" && (
            <>
              <input placeholder="Token Out Address" value={tokenOutCustom} onChange={(e) => setTokenOutCustom(e.target.value)} style={{ marginTop: 8 }} />
              {showAdvanced && (
                <div className="row" style={{ marginTop: 8 }}>
                  <input placeholder="Token Out Symbol (e.g. USDT)" value={tokenOutSymbol} onChange={(e) => setTokenOutSymbol(e.target.value)} />
                  <input placeholder="Token Out Decimals (e.g. 18)" value={tokenOutDecimals} onChange={(e) => setTokenOutDecimals(e.target.value)} />
                </div>
              )}
            </>
          )}
          {quote && (
            <div style={{ marginTop: 8, fontSize: 20, fontWeight: 600 }}>
              ≈ {formatAmount(quote.amountOut, swapTokenOut.decimals)} {swapTokenOut.symbol}
            </div>
          )}
        </div>
        {quote && (
          <div style={{ marginTop: 12, padding: 12, background: "rgba(37,99,235,0.05)", borderRadius: 8, fontSize: 13, opacity: 0.9 }}>
            <div>Min received: {formatAmount(quote.minAmountOut, swapTokenOut.decimals)} {swapTokenOut.symbol}</div>
            {quote.fees && (
              <div style={{ marginTop: 4 }}>
                Fees: {formatAmount(quote.fees.oracleFee, swapTokenIn.decimals)} {swapTokenIn.symbol} (oracle) +{" "}
                {formatAmount(quote.fees.swapFee, swapTokenIn.decimals)} {swapTokenIn.symbol} (swap) ={" "}
                {formatAmount(quote.fees.totalFee, swapTokenIn.decimals)} {swapTokenIn.symbol}
              </div>
            )}
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="flow-btn" onClick={fetchQuote}>Get Quote</button>
          {showAdvanced && (
            <>
              <button className="secondary" onClick={createSwapIntent}>Create Intent</button>
              <button className="secondary" onClick={signIntent}>Sign Intent</button>
            </>
          )}
        </div>
        {showAdvanced && (
          <>
            <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>Swap Payload (JoinSplitSwapData JSON)</div>
            <textarea rows="10" value={swapData} onChange={(e) => setSwapData(e.target.value)} style={{ marginTop: 8 }} />
            <button className="flow-btn" onClick={submit} style={{ marginTop: 12 }}>Submit Swap</button>
          </>
        )}
      </div>
      )}

      {tab === "history" && (
        <div className="card">
          <div className="label">History</div>
          <pre className="mono">{JSON.stringify(history, null, 2)}</pre>
        </div>
      )}

      {tab === "staking" && (
        <div className="card">
          <div className="label">Staking & Rewards</div>
          <div className="row">
            <input placeholder="RelayerStaking Address" value={stakingAddress} onChange={(e) => setStakingAddress(e.target.value)} />
            <input placeholder="ProtocolToken Address" value={protocolTokenAddress} onChange={(e) => setProtocolTokenAddress(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="Amount" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} />
            <button onClick={stakeTokens}>Stake</button>
            <button className="secondary" onClick={unstakeTokens}>Unstake</button>
            <button className="secondary" onClick={loadStaking}>Refresh</button>
          </div>
          <div className="mono" style={{ marginTop: 8 }}>
            Staked: {formatAmount(stakedBalance, 18)}
          </div>
          {stakingRewards.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {stakingRewards.map((r) => (
                <div key={r.token} className="row" style={{ marginTop: 6 }}>
                  <div className="mono">Pending: {formatAmount(r.amount, r.decimals)} {r.symbol}</div>
                  <button onClick={() => claimReward(r.token)}>Claim</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div className="card">
          <div className="label">Settings</div>
          <div className="mono">API: {import.meta.env.VITE_API_URL || "http://localhost:5050"}</div>
          <div className="mono">Chain: {selectedChain.name}</div>
        </div>
      )}

      {tab === "prover" && (
        <div className="card">
          <div className="label">Proof Generation</div>
          <textarea rows="10" placeholder="Circuit input JSON" value={proverInput} onChange={(e) => setProverInput(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={generateProof}>Generate Proof</button>
            <button className="secondary" onClick={buildProverInputFromNote}>Build Input From Note</button>
            <label className="secondary" style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #1f2a44", cursor: "pointer" }}>
              Upload JSON
              <input
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  setProverInput(text);
                }}
              />
            </label>
          </div>
          {depositLedger.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              <select value={selectedNote} onChange={(e) => setSelectedNote(e.target.value)}>
                <option value="">Select Note</option>
                {depositLedger.map((n) => (
                  <option key={n.commitment} value={n.commitment}>
                    {n.symbol} {formatAmount(n.amount, n.decimals)} ({n.commitment.slice(0, 10)}...)
                  </option>
                ))}
              </select>
            </div>
          )}
          {proverResult && <pre className="mono">{proverResult}</pre>}
          <div className="label" style={{ marginTop: 12 }}>SwapData Builder Meta</div>
          <textarea rows="8" placeholder='{"inputAmount":"...","swapAmount":"...","changeAmount":"...","inputAssetID":0,"outputAssetIDSwap":1,"outputAssetIDChange":0,"swapParams":{},"outputTokenSwap":"0x...","outputSymbolSwap":"tUSDT","outputDecimalsSwap":18,"outputTokenChange":"0x...","outputSymbolChange":"tBNB","outputDecimalsChange":18}' value={builderMeta} onChange={(e) => setBuilderMeta(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={buildSwapData}>Build swapData</button>
          </div>
        </div>
      )}

      {error && <div className="card" style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.3)" }}>{error}</div>}

      <Receipt receipt={receipt} />
    </div>
  );
}
