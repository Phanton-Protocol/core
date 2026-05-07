import React, { useState, useEffect, useCallback, useRef } from "react";
import { BrowserProvider, Contract, parseEther, MaxUint256, getAddress, keccak256, solidityPacked, getBytes, AbiCoder } from "ethers";
import { groth16 } from "snarkjs";

const DEFAULT_API_URL = import.meta.env.VITE_API_URL || "";
const RUNBOOK_URL =
  import.meta.env.VITE_RUNBOOK_URL || "https://github.com/Phanton-Protocol/core/blob/main/RUNBOOK.md";
const BSC_TESTNET = { chainId: 97, chainIdHex: "0x61", rpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545", name: "BSC Testnet" };
const BUILD_ID = "module8-ops-dashboard";

function explorerTxUrl(chainId, txHash) {
  if (!txHash || chainId == null) return null;
  const id = Number(chainId);
  if (id === 97) return `https://testnet.bscscan.com/tx/${txHash}`;
  if (id === 56) return `https://bscscan.com/tx/${txHash}`;
  return null;
}

function getInjectedProvider() {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  if (eth.providers?.length) return eth.providers.find((p) => p.isMetaMask) || eth.providers[0];
  return eth;
}

function useFetch(url, intervalMs = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!url) return;
    const fetchIt = () => {
      fetch(url, { mode: "cors" })
        .then(async (r) => {
          const text = await r.text();
          let body;
          try { body = text ? JSON.parse(text) : null; } catch { body = null; }
          if (!r.ok) {
            const msg = body?.error || `HTTP ${r.status}`;
            throw new Error(msg);
          }
          return body;
        })
        .then((d) => { setData(d); setError(null); })
        .catch((e) => { setError(e.message); setData(null); })
        .finally(() => setLoading(false));
    };
    fetchIt();
    if (intervalMs > 0) {
      const id = setInterval(fetchIt, intervalMs);
      return () => clearInterval(id);
    }
  }, [url, intervalMs]);

  return { data, error, loading };
}

function getInitialApiUrl() {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("api");
  if (fromUrl) return fromUrl.trim();
  const saved = localStorage.getItem("relayer_api");
  if (saved) return saved;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "http://localhost:5050";
  }
  return DEFAULT_API_URL || window.location.origin;
}

export default function App() {
  const [wallet, setWallet] = useState({ address: null, provider: null, signer: null });
  const [apiBase, setApiBase] = useState(getInitialApiUrl);
  const base = (apiBase || "").replace(/\/$/, "").trim();

  const { data: health, error: healthError } = useFetch(base ? `${base}/health` : null, 5000);
  const { data: cfg } = useFetch(base ? `${base}/config` : null, 15000);
  const { data: relayer } = useFetch(base ? `${base}/relayer` : null, 10000);
  const { data: staking, error: stakingError } = useFetch(base ? `${base}/relayer/staking-status` : null, 10000);
  const { data: proofStats } = useFetch(base ? `${base}/relayer/proof-stats` : null, 5000);
  const { data: dashboard, error: dashboardError } = useFetch(base ? `${base}/relayer/dashboard` : null, 5000);
  const { data: stakingStats } = useFetch(base ? `${base}/staking/stats` : null, 15000);
  const { data: myStake } = useFetch(
    base && wallet?.address ? `${base}/staking/balance?address=${encodeURIComponent(wallet.address)}` : null,
    10000
  );
  const { data: network } = useFetch(base ? `${base}/relayer/network` : null, 0);

  const [stakeAmount, setStakeAmount] = useState("");
  const [stakeTx, setStakeTx] = useState({ status: null, hash: null, error: null });
  const [approveTx, setApproveTx] = useState({ status: null, hash: null, error: null });
  const [connectError, setConnectError] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [stakingTokenAddr, setStakingTokenAddr] = useState(null);

  useEffect(() => {
    localStorage.setItem("relayer_api", apiBase);
  }, [apiBase]);

  useEffect(() => {
    const stakingAddr = stakingStats?.stakingAddress || staking?.stakingAddress;
    if (!stakingAddr) return;
    const p = getInjectedProvider();
    if (!p) return;
    const prov = new BrowserProvider(p);
    const c = new Contract(stakingAddr, ["function token() view returns (address)"], prov);
    c.token().then((a) => setStakingTokenAddr(a)).catch(() => setStakingTokenAddr(null));
  }, [stakingStats?.stakingAddress, staking?.stakingAddress]);

  const connectWallet = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setConnectError("No wallet found. Install MetaMask, Trust Wallet, or another Web3 wallet.");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    setStakeTx((t) => (t.status === "error" && t.error?.includes("wallet") ? { status: null, hash: null, error: null } : t));
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) {
        setConnectError("No accounts returned. Please unlock your wallet.");
        return;
      }
      const targetChainId = network?.chainId ?? BSC_TESTNET.chainId;
      const chainIdHex = "0x" + Number(targetChainId).toString(16);
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainIdHex }]
        });
      } catch (switchErr) {
        if (switchErr?.code === 4902 || switchErr?.message?.includes("Unrecognized chain")) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: BSC_TESTNET.chainIdHex,
              chainName: BSC_TESTNET.name,
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: [BSC_TESTNET.rpcUrl]
            }]
          });
        } else {
          throw switchErr;
        }
      }
      const prov = new BrowserProvider(provider);
      const signer = await prov.getSigner();
      setWallet({ address: accounts[0], provider: prov, signer });
      setConnectError(null);
    } catch (e) {
      const msg = e?.message || String(e);
      setConnectError(msg.includes("User rejected") ? "Connection cancelled" : msg);
    } finally {
      setConnecting(false);
    }
  }, [network?.chainId]);

  useEffect(() => {
    const p = getInjectedProvider();
    if (!p || !wallet.address) return;
    const onAccounts = (accounts) => {
      if (!accounts?.length) setWallet({ address: null, provider: null, signer: null });
    };
    const onChain = () => window.location.reload();
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet.address]);

  const ensureNetwork = useCallback(async () => {
    const targetChainId = network?.chainId ?? BSC_TESTNET.chainId;
    const chainIdHex = "0x" + Number(targetChainId).toString(16);
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      const currentChain = await provider.request({ method: "eth_chainId" });
      if (currentChain !== chainIdHex) {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
      }
    } catch (e) {
      throw new Error(`Wrong network. Switch to ${BSC_TESTNET.name} (chain ${targetChainId}) in MetaMask.`);
    }
  }, [network?.chainId]);

  const approveTokens = async () => {
    const stakingAddrRaw = stakingStats?.stakingAddress || staking?.stakingAddress;
    const tokenAddrRaw = stakingTokenAddr || stakingStats?.protocolTokenAddress;
    if (!stakingAddrRaw || !tokenAddrRaw) {
      setApproveTx({ status: "error", error: "Staking config not loaded. Check API /staking/stats and /relayer/staking-status." });
      return;
    }
    const stakingAddr = getAddress(stakingAddrRaw);
    const tokenAddr = getAddress(tokenAddrRaw);
    if (!wallet.signer) return;
    setApproveTx({ status: "pending" });
    try {
      await ensureNetwork();
      const tokenAbi = ["function approve(address,uint256) returns (bool)"];
      const token = new Contract(tokenAddr, tokenAbi, wallet.signer);
      const tx = await token.approve(stakingAddr, MaxUint256);
      await tx.wait();
      setApproveTx({ status: "success", hash: tx.hash });
    } catch (e) {
      setApproveTx({ status: "error", error: e.message });
    }
  };

  const stake = async () => {
    const stakingAddrRaw = stakingStats?.stakingAddress || staking?.stakingAddress;
    const tokenAddrRaw = stakingTokenAddr || stakingStats?.protocolTokenAddress;
    if (!stakingAddrRaw || !tokenAddrRaw) {
      setStakeTx({ status: "error", error: "Staking config not loaded. Check API /staking/stats and /relayer/staking-status." });
      return;
    }
    const stakingAddr = getAddress(stakingAddrRaw);
    const tokenAddr = getAddress(tokenAddrRaw);
    if (!wallet.signer || !stakeAmount) return;
    setStakeTx({ status: "pending" });
    try {
      await ensureNetwork();
      const amountWei = parseEther(stakeAmount);
      const tokenAbi = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
      const stakingAbi = ["function stake(uint256) external"];
      const token = new Contract(tokenAddr, tokenAbi, wallet.signer);
      const stakingContract = new Contract(stakingAddr, stakingAbi, wallet.signer);
      const balance = await token.balanceOf(wallet.address);
      if (balance < amountWei) {
        setStakeTx({ status: "error", error: `Insufficient balance. You have ${(Number(balance) / 1e18).toFixed(2)} SHDW. Need ${stakeAmount}. Add SHDW ${tokenAddr} in MetaMask.` });
        return;
      }
      setStakeTx({ status: "pending", step: "approve" });
      const approveTx = await token.approve(stakingAddr, amountWei);
      await approveTx.wait();
      await new Promise((r) => setTimeout(r, 2000));
      const allowanceAbi = ["function allowance(address,address) view returns (uint256)"];
      const tokenCheck = new Contract(tokenAddr, allowanceAbi, wallet.signer);
      const allowance = await tokenCheck.allowance(wallet.address, stakingAddr);
      if (allowance < amountWei) {
        setStakeTx({ status: "error", error: `Approve confirmed but allowance still ${allowance.toString()}. Token ${tokenAddr} may not match staking contract. Try adding this token in MetaMask.` });
        return;
      }
      setStakeTx({ status: "pending", step: "stake" });
      const tx = await stakingContract.stake(amountWei);
      await tx.wait();
      setStakeTx({ status: "success", hash: tx.hash });
      setStakeAmount("");
    } catch (e) {
      setStakeTx({ status: "error", error: e.message });
    }
  };

  const isRelayerWallet = relayer && wallet.address && String(wallet.address).toLowerCase() === String(relayer.relayer).toLowerCase();
  const [tab, setTab] = useState("relayer");

  return (
    <div style={{ padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <header style={{ marginBottom: "2rem", borderBottom: "1px solid #2a2a3a", paddingBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600, color: "#8b5cf6" }}>
              Phantom Relayer Dashboard
            </h1>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "#6b7280" }}>
              Operator dashboard — not for end users <span style={{ color: "#4b5563", fontSize: "0.7rem" }}>({BUILD_ID})</span>
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.5rem" }}>
            {wallet.address ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ fontSize: "0.85rem", color: "#22c55e", fontFamily: "monospace" }}>
                  {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                </span>
                <button
                  onClick={() => { setWallet({ address: null, provider: null, signer: null }); setConnectError(null); }}
                  style={{ padding: "0.25rem 0.5rem", background: "#2a2a3a", border: "none", borderRadius: 4, color: "#9ca3af", fontSize: "0.75rem", cursor: "pointer" }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectWallet}
                disabled={connecting}
                style={{
                  padding: "0.5rem 1rem",
                  background: connecting ? "#4b5563" : "#8b5cf6",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  fontWeight: 600,
                  cursor: connecting ? "wait" : "pointer",
                  fontSize: "0.9rem"
                }}
              >
                {connecting ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
            {connectError && <span style={{ fontSize: "0.8rem", color: "#ef4444", maxWidth: 220, textAlign: "right" }}>{connectError}</span>}
          </div>
        </div>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>API URL</label>
          <input
            type="text"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://your-backend.vercel.app (required)"
            style={{
              flex: 1,
              padding: "0.5rem 0.75rem",
              background: "#1a1a24",
              border: "1px solid #2a2a3a",
              borderRadius: 6,
              color: "#e0e0e8",
              fontFamily: "inherit",
              fontSize: "0.9rem"
            }}
          />
        </div>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            onClick={() => setTab("relayer")}
            style={{
              padding: "0.5rem 1rem",
              background: tab === "relayer" ? "#8b5cf6" : "#2a2a3a",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Relayer
          </button>
          <button
            onClick={() => setTab("validators")}
            style={{
              padding: "0.5rem 1rem",
              background: tab === "validators" ? "#8b5cf6" : "#2a2a3a",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Validators
          </button>
          <button
            onClick={() => setTab("ops")}
            style={{
              padding: "0.5rem 1rem",
              background: tab === "ops" ? "#8b5cf6" : "#2a2a3a",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.9rem"
            }}
          >
            Operations
          </button>
        </div>
        <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "#6b7280" }}>
          Operator docs:{" "}
          <a href={RUNBOOK_URL} target="_blank" rel="noreferrer" style={{ color: "#a78bfa" }}>
            RUNBOOK.md
          </a>
          {" · "}
          End-user privacy summary:{" "}
          <a
            href="https://phantomproto.com/privacy-visibility"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#a78bfa" }}
          >
            Privacy & visibility
          </a>{" "}
          (main site; override host if you self-host).
        </p>
      </header>

      {tab === "validators" ? (
        <ValidatorSetup base={base} relayer={relayer} staking={staking} wallet={wallet} />
      ) : tab === "ops" ? (
        <OperationsTab
          base={base}
          health={health}
          healthError={healthError}
          dashboard={dashboard}
          dashboardError={dashboardError}
          proofStats={proofStats}
          network={network}
        />
      ) : (
      <section style={{ display: "grid", gap: "1.5rem" }}>
        {cfg?.mode === "degraded" && (
          <div style={{ background: "#7f1d1d20", border: "1px solid #ef4444", borderRadius: 10, padding: "0.75rem 1rem" }}>
            <div style={{ fontWeight: 700, color: "#fecaca" }}>Backend is in degraded mode</div>
            <div style={{ color: "#fca5a5", fontSize: "0.9rem", marginTop: "0.25rem" }}>
              Missing env for transactions: {(cfg.missingForTx || []).join(", ") || "unknown"}.
            </div>
          </div>
        )}

        <Card title="Health">
          {!base ? (
            <div style={{ color: "#f59e0b" }}>
              Enter your relayer API URL above (e.g. https://backend-self-nu-51.vercel.app). The relayer must be running and allow CORS.
            </div>
          ) : health ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />
              <span>OK — {health.status || "running"}{health.mode ? ` (${health.mode})` : ""}</span>
            </div>
          ) : (
            <div style={{ color: "#ef4444" }}>
              {healthError || "Cannot reach API."} Check: (1) Relayer URL is correct and uses HTTPS, (2) Relayer is running, (3) Relayer allows CORS from this site.
            </div>
          )}
        </Card>

        <Card title="Relayer">
          {relayer ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.9rem" }}>
              <Row label="Address" value={relayer.relayer} mono />
              <Row label="Dry run" value={relayer.dryRun ? "Yes" : "No"} />
              <Row label="Bypass validators" value={relayer.bypassValidators ? "Yes" : "No"} />
              <Row label="Bypass proofs" value={relayer.bypassProofs ? "Yes" : "No"} />
              {relayer.validatorUrls?.length > 0 && (
                <Row label="Validators" value={relayer.validatorUrls.join(", ")} mono small />
              )}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Staking">
          {staking ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.9rem" }}>
              <Row label="Relayer stake" value={formatWei(staking.staked)} />
              <Row label="Min stake" value={formatWei(staking.minStake)} />
              <Row label="Total staked" value={formatWei(staking.totalStaked)} />
              <Row
                label="Valid"
                value={staking.isRelayerValid ? "Yes" : "No"}
                valueColor={staking.isRelayerValid ? "#22c55e" : "#ef4444"}
              />
              <Row label="Staking contract" value={staking.stakingAddress} mono small />
              <hr style={{ border: "none", borderTop: "1px solid #2a2a3a", margin: "0.5rem 0" }} />
              <div style={{ fontSize: "0.85rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
                <strong style={{ color: "#e0e0e8" }}>How to become a relayer:</strong> The relayer is the wallet in your backend config (RELAYER_PRIVATE_KEY). To stake, connect that same wallet here — import its key into MetaMask, then connect and stake.
              </div>
              {!wallet.address ? (
                <div style={{ fontSize: "0.85rem", color: "#6b7280" }}>Connect wallet above to stake.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {relayer && (
                    <div style={{ fontSize: "0.8rem", color: isRelayerWallet ? "#22c55e" : "#f59e0b" }}>
                      {isRelayerWallet
                        ? "✓ Correct wallet — staking will make this relayer valid"
                        : "⚠ Wrong wallet — connect the relayer wallet (see Relayer address above). Import its key into MetaMask if needed."}
                    </div>
                  )}
                  <div style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "0.25rem" }}>
                    <strong>Stake:</strong> Enter amount → Click <strong>Stake</strong>. If approval is needed, MetaMask will prompt twice (approve, then stake).
                    <br />
                    <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>
                      Token: {(stakingTokenAddr || stakingStats?.protocolTokenAddress || "").slice(0, 10)}… | Staking: {(stakingStats?.stakingAddress || "").slice(0, 10)}…
                    </span>
                  </div>
                  {stakeTx.status === "error" && (stakeTx.error?.includes("insufficient allowance") || stakeTx.error?.includes("allowance")) && (
                    <div style={{ background: "#7f1d1d20", border: "1px solid #ef4444", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: "#fca5a5", marginBottom: "0.5rem" }}>
                      ⚠️ You must <strong>Approve</strong> first. Click the purple Approve button, confirm in MetaMask, wait for ✓ Approved, then Stake.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      onClick={approveTokens}
                      disabled={approveTx.status === "pending"}
                      style={{
                        padding: "0.5rem 1rem",
                        background: approveTx.status === "pending" ? "#4b5563" : approveTx.status === "success" ? "#166534" : "#6366f1",
                        border: "none",
                        borderRadius: 6,
                        color: "#fff",
                        fontWeight: 600,
                        cursor: approveTx.status !== "pending" ? "pointer" : "not-allowed",
                        fontSize: "0.9rem"
                      }}
                    >
                      {approveTx.status === "pending" ? "Approving…" : approveTx.status === "success" ? "✓ Approved" : "1. Approve"}
                    </button>
                    <input
                      type="text"
                      placeholder="Amount (e.g. 100)"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 120,
                        padding: "0.5rem 0.75rem",
                        background: "#1a1a24",
                        border: "1px solid #2a2a3a",
                        borderRadius: 6,
                        color: "#e0e0e8",
                        fontFamily: "inherit",
                        fontSize: "0.9rem"
                      }}
                    />
                    <button
                      onClick={stake}
                      disabled={!stakeAmount || stakeTx.status === "pending"}
                      style={{
                        padding: "0.5rem 1rem",
                        background: stakeTx.status === "pending" ? "#4b5563" : "#22c55e",
                        border: "none",
                        borderRadius: 6,
                        color: "#fff",
                        fontWeight: 600,
                        cursor: stakeAmount && stakeTx.status !== "pending" ? "pointer" : "not-allowed",
                        fontSize: "0.9rem"
                      }}
                    >
                      {stakeTx.status === "pending"
                        ? (stakeTx.step === "approve" ? "Approving…" : "Staking…")
                        : "2. Stake"}
                    </button>
                  </div>
                  {approveTx.status === "error" && (
                    <div style={{ color: "#ef4444", fontSize: "0.85rem" }}>Approve failed: {approveTx.error}</div>
                  )}
                  {stakeTx.status === "success" && (
                    <div style={{ color: "#22c55e", fontSize: "0.85rem" }}>Staked! Tx: {stakeTx.hash?.slice(0, 10)}…</div>
                  )}
                  {stakeTx.status === "error" && (
                    <div style={{ color: "#ef4444", fontSize: "0.85rem" }}>{stakeTx.error}</div>
                  )}
                </div>
              )}
            </div>
          ) : stakingError ? (
            <div style={{ color: "#ef4444" }}>API error: {stakingError}</div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Proof Stats">
          {proofStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: proofStats.rapidsnarkEnabled ? "#22c55e" : "#f59e0b" }} />
                <span>{proofStats.rapidsnarkEnabled ? "Rapidsnark enabled" : "Using snarkjs (set RAPIDSNARK_PATH for faster proofs)"}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
                <StatBox label="Swap" count={proofStats.swap?.count} avgMs={proofStats.swap?.avgMs} />
                <StatBox label="Withdraw" count={proofStats.withdraw?.count} avgMs={proofStats.withdraw?.avgMs} />
                <StatBox label="Portfolio" count={proofStats.portfolio?.count} avgMs={proofStats.portfolio?.avgMs} />
              </div>
              {proofStats.lastError && (
                <div style={{ color: "#ef4444", fontSize: "0.8rem" }}>
                  Last error: {proofStats.lastError.type} @ {new Date(proofStats.lastError.ts).toLocaleTimeString()}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>

        <Card title="Protocol">
          {stakingStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.9rem" }}>
              <Row label="Protocol token" value={stakingStats.protocolTokenAddress} mono small />
              <Row label="Total staked" value={formatWei(stakingStats.totalStaked)} />
              <Row label="Min stake" value={formatWei(stakingStats.minStake)} />
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>Loading…</div>
          )}
        </Card>
      </section>
      )}
    </div>
  );
}

function ValidatorSetup({ base, relayer, staking, wallet }) {
  const [validatorWs, setValidatorWs] = useState(null);
  const [validatorConnected, setValidatorConnected] = useState(false);
  const [validatorConnecting, setValidatorConnecting] = useState(false);
  const [validatorError, setValidatorError] = useState(null);
  const [pendingProof, setPendingProof] = useState(null);
  const [vKey, setVKey] = useState(null);
  const wsRef = useRef(null);

  const coordinatorUrl = relayer?.coordinatorWsUrl || (base ? (() => {
    const u = base.replace(/\/$/, "").replace("phantom-protocol", "phantom-validator-coordinator");
    if (u.includes("localhost")) return "ws://localhost:6005";
    return (u.startsWith("https") ? "wss" : "ws") + u.slice(u.indexOf(":"));
  })() : null);

  useEffect(() => {
    if (!base) return;
    fetch(`${base}/verification-key`)
      .then((r) => r.ok ? r.json() : null)
      .then(setVKey)
      .catch(() => setVKey(null));
  }, [base]);

  const joinValidator = useCallback(() => {
    setValidatorError(null);
    if (!wallet?.address) {
      setValidatorError("Connect wallet first (top right).");
      return;
    }
    const hasEnoughStake = myStake?.isValid || staking?.isRelayerValid;
    if (!hasEnoughStake) {
      const myStaked = myStake?.staked ? formatWei(myStake.staked) : "0";
      setValidatorError(`Stake ≥ 1000 SHDW first. Your connected wallet has ${myStaked} staked. Connect the wallet that has the stake, or stake in the Relayer tab.`);
      return;
    }
    if (!coordinatorUrl) {
      setValidatorError("Coordinator URL not configured. Set VALIDATOR_COORDINATOR_WS_URL on the relayer (e.g. wss://phantom-validator-coordinator.onrender.com).");
      return;
    }
    const wsUrl = coordinatorUrl.startsWith("ws") ? coordinatorUrl : `wss://${coordinatorUrl}`;
    setValidatorConnecting(true);
    const timeout = setTimeout(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        setValidatorError("Connection timed out (45s). Coordinator may be sleeping — wait 1 min and try again, or deploy phantom-validator-coordinator from render.yaml.");
        setValidatorConnecting(false);
      }
    }, 45000);
    try {
      const ws = new WebSocket(wsUrl);
      const clearConnecting = () => {
        clearTimeout(timeout);
        setValidatorConnecting(false);
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", address: wallet.address }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "error") {
            setValidatorError(msg.message);
            clearConnecting();
          } else if (msg.type === "registered") {
            clearTimeout(timeout);
            setValidatorConnected(true);
            setValidatorConnecting(false);
          } else if (msg.type === "verify") setPendingProof(msg);
        } catch (_) {}
      };
      ws.onclose = () => {
        setValidatorConnected(false);
        setValidatorWs(null);
        clearConnecting();
      };
      ws.onerror = () => {
        setValidatorError("Cannot connect to coordinator. Deploy phantom-validator-coordinator on Render (see render.yaml), or it may be sleeping.");
        clearConnecting();
      };
      wsRef.current = ws;
      setValidatorWs(ws);
    } catch (e) {
      clearTimeout(timeout);
      setValidatorError(e.message);
      setValidatorConnecting(false);
    }
  }, [coordinatorUrl, wallet?.address, staking?.isRelayerValid, myStake]);

  const leaveValidator = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setValidatorWs(null);
    setValidatorConnected(false);
    setPendingProof(null);
  }, []);

  const signProof = useCallback(async () => {
    if (!pendingProof || !wallet?.signer || !vKey) return;
    const { requestId, proof, publicInputs } = pendingProof;
    const pa = proof?.a || proof?.pi_a;
    const pb = proof?.b || proof?.pi_b;
    const pc = proof?.c || proof?.pi_c;
    if (!pa || !pb || !pc) {
      setValidatorError("Invalid proof format");
      return;
    }
    try {
      const proofSnarkJS = {
        pi_a: pa.slice(0, 2),
        pi_b: [[pb[0][1], pb[0][0]], [pb[1][1], pb[1][0]]],
        pi_c: pc.slice(0, 2),
        protocol: "groth16",
        curve: "bn128"
      };
      const isValid = await groth16.verify(vKey, publicInputs, proofSnarkJS);
      const coder = AbiCoder.defaultAbiCoder();
      const a = coder.encode(["uint256[2]"], [pa.slice(0, 2)]);
      const b = coder.encode(["uint256[2][2]"], [pb]);
      const c = coder.encode(["uint256[2]"], [pc.slice(0, 2)]);
      const proofHash = keccak256(coder.encode(["bytes", "bytes", "bytes", "uint256[]"], [a, b, c, publicInputs]));
      const timestamp = Math.floor(Date.now() / 1000);
      const message = keccak256(solidityPacked(["bytes32", "bool", "uint256"], [proofHash, isValid, timestamp]));
      const signature = await wallet.signer.signMessage(getBytes(message));
      wsRef.current?.send(JSON.stringify({ requestId, valid: isValid, signature, timestamp }));
      setPendingProof(null);
    } catch (e) {
      setValidatorError(e.message);
    }
  }, [pendingProof, wallet?.signer, vKey]);

  const rejectProof = useCallback(() => setPendingProof(null), []);

  return (
    <section style={{ display: "grid", gap: "1.5rem" }}>
      <Card title="Join as Validator (Sign in Browser)">
        <p style={{ color: "#9ca3af", marginBottom: "1rem", lineHeight: 1.6 }}>
          Stake tokens, connect wallet, then click <strong>Join as validator</strong>. When a transaction needs validation, you'll get a Sign prompt — sign in MetaMask. No server to run.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {!validatorConnected ? (
            <button
              onClick={joinValidator}
              disabled={validatorConnecting}
              style={{
                padding: "0.6rem 1.2rem",
                background: validatorConnecting ? "#374151" : "#7c3aed",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: validatorConnecting ? "wait" : "pointer",
                fontWeight: 600,
                fontSize: "1rem"
              }}
            >
              {validatorConnecting ? "Connecting…" : "Join as validator"}
            </button>
          ) : (
              <div>
                <span style={{ color: "#22c55e" }}>● Connected — waiting for proof requests</span>
                <button onClick={leaveValidator} style={{ marginLeft: "1rem", padding: "0.25rem 0.5rem", background: "#374151", color: "#9ca3af", border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.85rem" }}>Leave</button>
              </div>
            )}
            {pendingProof && (
              <div style={{ background: "#0a0a0f", padding: "1rem", borderRadius: 6, marginTop: "0.5rem" }}>
                <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Proof request — sign in MetaMask:</p>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button onClick={signProof} style={{ padding: "0.5rem 1rem", background: "#22c55e", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>Sign</button>
                  <button onClick={rejectProof} style={{ padding: "0.5rem 1rem", background: "#374151", color: "#9ca3af", border: "none", borderRadius: 6, cursor: "pointer" }}>Skip</button>
                </div>
              </div>
            )}
          {!wallet?.address && <p style={{ color: "#f59e0b", fontSize: "0.9rem" }}>1. Connect wallet (top right)</p>}
          {wallet?.address && (
            <p style={{ color: myStake?.isValid ? "#22c55e" : "#f59e0b", fontSize: "0.9rem" }}>
              {myStake?.isValid
                ? `✓ Your stake: ${formatWei(myStake?.staked || "0")} SHDW`
                : `2. Your stake: ${formatWei(myStake?.staked || "0")} — need ≥ 1000 SHDW. Stake in Relayer tab.`}
            </p>
          )}
          {wallet?.address && staking?.isRelayerValid && !coordinatorUrl && <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>Coordinator not configured. Set VALIDATOR_COORDINATOR_WS_URL on relayer.</p>}
          {validatorError && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <p style={{ color: "#ef4444", fontSize: "0.9rem" }}>{validatorError}</p>
              {!validatorConnected && <button onClick={joinValidator} style={{ padding: "0.4rem 0.8rem", background: "#374151", color: "#9ca3af", border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.85rem", alignSelf: "flex-start" }}>Retry</button>}
            </div>
          )}
        </div>
      </Card>
      <Card title="Validator Setup (Advanced)">
        <p style={{ color: "#9ca3af", marginBottom: "1rem", lineHeight: 1.6 }}>
          <strong>Production:</strong> AWS Enclave. <strong>Alternative:</strong> Run Node.js client for auto-signing.
        </p>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>Option A: Node.js client (auto-sign)</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Stake ≥ 1000 SHDW, then run the client. It connects to the coordinator and signs automatically.
        </p>
        <pre style={{
          background: "#0a0a0f",
          padding: "1rem",
          borderRadius: 6,
          overflow: "auto",
          fontSize: "0.8rem",
          color: "#e0e0e8",
          margin: "0.5rem 0"
        }}>
{`# Terminal 1: Start coordinator (once per network)
cd backend && npm run validator:coordinator

# Terminal 2: Each staker runs (after staking)
export VALIDATOR_PRIVATE_KEY=0x...
export COORDINATOR_URL=ws://localhost:6005
npm run validator:client`}
        </pre>
        <p style={{ color: "#6b7280", fontSize: "0.85rem", margin: "0.5rem 0" }}>
          Set <code style={{ background: "#2a2a3a", padding: "0.1rem 0.3rem", borderRadius: 4 }}>VALIDATOR_URLS</code>=<code style={{ background: "#2a2a3a", padding: "0.1rem 0.3rem", borderRadius: 4 }}>http://coordinator-host:6005</code> in relayer. Deploy coordinator to Render for 24/7.
        </p>
        <h4 style={{ margin: "1.5rem 0 0.5rem", fontSize: "0.95rem" }}>Option B: Full Validator Server</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Deploy to Render, Railway, or VPS for 24/7 standalone validator.
        </p>
        <pre style={{
          background: "#0a0a0f",
          padding: "1rem",
          borderRadius: 6,
          overflow: "auto",
          fontSize: "0.8rem",
          color: "#e0e0e8",
          margin: "0.5rem 0"
        }}>
{`cd backend
export VALIDATOR_PRIVATE_KEY=0x...
export VALIDATOR_PORT=6000
export RELAYER_STAKING_ADDRESS=0x...
export RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545
node src/validatorServer.js`}
        </pre>
        <h4 style={{ margin: "1rem 0 0.5rem", fontSize: "0.95rem" }}>Threshold: 66%</h4>
        <p style={{ color: "#9ca3af", fontSize: "0.9rem", margin: 0 }}>
          Validators representing <strong>66% of total staked voting power</strong> must sign each proof.
        </p>
      </Card>
    </section>
  );
}

function OperationsTab({ base, health, healthError, dashboard, dashboardError, proofStats, network }) {
  const chainId = network?.chainId ?? health?.chainId;
  const fees = dashboard?.fees;
  const rl = dashboard?.rateLimit;
  const txs = dashboard?.recentTransactions || [];
  const errs = dashboard?.recentErrors || [];

  return (
    <section style={{ display: "grid", gap: "1.5rem" }}>
      <Card title="Status & uptime">
        {!base ? (
          <div style={{ color: "#f59e0b" }}>Set API URL above.</div>
        ) : healthError && !health ? (
          <div style={{ color: "#ef4444" }}>{healthError}</div>
        ) : (
          <div style={{ fontSize: "0.9rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Row label="Health" value={health?.ok ? "ok" : "degraded"} valueColor={health?.ok ? "#22c55e" : "#f59e0b"} />
            <Row label="Mode" value={health?.mode || "—"} />
            <Row label="Chain ID" value={health?.chainId != null ? String(health.chainId) : "—"} />
            <Row label="Pool configured" value={health?.poolConfigured ? "yes" : "no"} />
            <Row
              label="Process uptime"
              value={dashboard?.uptimeSec != null ? `${dashboard.uptimeSec}s` : "—"}
            />
            {health?.module7Hardening && (
              <Row
                label="Deployment tier"
                value={health.module7Hardening.deploymentTier || "unset"}
              />
            )}
          </div>
        )}
      </Card>

      <Card title="Fees (runtime parameters)">
        {dashboardError && !dashboard ? (
          <div style={{ color: "#ef4444" }}>{dashboardError}</div>
        ) : fees ? (
          <div style={{ fontSize: "0.9rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Row label="DEX swap fee" value={`${fees.dexSwapFeeBps} bps`} />
            <Row label="Internal match fee" value={`${fees.internalMatchFeeBps} bps`} />
            <Row label="Deposit fee (USD e8)" value={fees.depositFeeUsdE8} mono small />
            <Row label="Oracle fee floor (USD e8)" value={fees.oracleFeeFloorUsdE8} mono small />
            <Row label="Oracle fee rate" value={`${fees.oracleFeeRateBps} bps`} />
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
              Canonical withdraw fee policy is on-chain (see RUNBOOK / MODULE6). Full JSON:{" "}
              <code style={{ background: "#2a2a3a", padding: "0.1rem 0.35rem", borderRadius: 4 }}>/parameters</code>
            </p>
          </div>
        ) : (
          <div style={{ color: "#6b7280" }}>Loading…</div>
        )}
      </Card>

      <Card title="Rate limits (API)">
        {rl ? (
          <div style={{ fontSize: "0.9rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Row label="Default window" value={`${rl.defaultWindowMs} ms`} />
            <Row label="Default max / window" value={String(rl.defaultMaxPerWindow)} />
            <Row label="Module 4 deposit window" value={`${rl.module4WindowMs} ms`} />
            <Row label="Module 4 max / window" value={String(rl.module4MaxPerWindow)} />
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#6b7280" }}>
              Limits reduce abuse per IP; they are not a full anti-abuse product. See security section below.
            </p>
          </div>
        ) : (
          <div style={{ color: "#6b7280" }}>Loading…</div>
        )}
      </Card>

      <Card title="Recent transactions (this process)">
        {txs.length === 0 ? (
          <div style={{ color: "#6b7280", fontSize: "0.9rem" }}>
            No shielded swap / withdraw recorded since restart. Activity is in-memory only.
          </div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#e0e0e8" }}>
            {txs.map((t, i) => {
              const url = explorerTxUrl(chainId, t.txHash);
              return (
                <li key={`${t.txHash}-${i}`} style={{ marginBottom: "0.5rem" }}>
                  <strong>{t.op}</strong> — {new Date(t.ts).toLocaleString()}
                  {t.txHash ? (
                    <>
                      {" · "}
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" style={{ color: "#a78bfa" }}>
                          {t.txHash.slice(0, 10)}…
                        </a>
                      ) : (
                        <span style={{ fontFamily: "monospace" }}>{t.txHash.slice(0, 10)}…</span>
                      )}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Recent errors (proof / on-chain / RPC)">
        {proofStats?.lastError && (
          <div style={{ color: "#f97316", fontSize: "0.85rem", marginBottom: "0.75rem" }}>
            Proof stats last error: {proofStats.lastError.type} @{" "}
            {new Date(proofStats.lastError.ts).toLocaleString()}
          </div>
        )}
        {errs.length === 0 ? (
          <div style={{ color: "#6b7280", fontSize: "0.9rem" }}>No structured errors recorded since restart.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#fca5a5" }}>
            {errs.map((e, i) => (
              <li key={`${e.ts}-${i}`} style={{ marginBottom: "0.5rem", wordBreak: "break-word" }}>
                <span style={{ color: "#9ca3af" }}>{new Date(e.ts).toLocaleString()}</span> —{" "}
                <strong>{e.phase}</strong>: {e.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Security — MVP limitations">
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.88rem", color: "#d1d5db", lineHeight: 1.55 }}>
          <li>
            <strong>Relayer key compromise</strong> is catastrophic: a stolen <code style={{ background: "#2a2a3a", padding: "0.05rem 0.25rem", borderRadius: 4 }}>RELAYER_PRIVATE_KEY</code> can
            submit transactions on behalf of the relayer flow. Use HSM / vault patterns for production.
          </li>
          <li>
            <strong>Operator trust</strong>: the relayer sees proofs and payloads before broadcast. Users should read the
            public privacy page and RUNBOOK.
          </li>
          <li>
            <strong>Rate limits</strong> are coarse (per-IP). They do not stop distributed abuse.
          </li>
          <li>
            <strong>No audit implied</strong> by this MVP dashboard.
          </li>
        </ul>
        <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#6b7280" }}>
          Operator checklist:{" "}
          <a href={RUNBOOK_URL} target="_blank" rel="noreferrer" style={{ color: "#a78bfa" }}>
            RUNBOOK.md
          </a>
        </p>
      </Card>
    </section>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: "#12121a", border: "1px solid #2a2a3a", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #2a2a3a", fontWeight: 600, fontSize: "0.95rem" }}>
        {title}
      </div>
      <div style={{ padding: "1rem" }}>{children}</div>
    </div>
  );
}

function Row({ label, value, mono, small, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "baseline" }}>
      <span style={{ color: "#6b7280", fontSize: small ? "0.8rem" : undefined }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? "monospace" : "inherit",
          fontSize: small ? "0.75rem" : "0.9rem",
          color: valueColor || "#e0e0e8",
          wordBreak: "break-all",
          textAlign: "right"
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatBox({ label, count, avgMs }) {
  return (
    <div style={{ background: "#0a0a0f", padding: "0.75rem", borderRadius: 6, textAlign: "center" }}>
      <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.25rem" }}>{label}</div>
      <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{count ?? 0}</div>
      <div style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
        avg {typeof avgMs === "number" ? `${avgMs.toFixed(0)}ms` : "—"}
      </div>
    </div>
  );
}

function formatWei(s) {
  if (!s || s === "0") return "0";
  const n = BigInt(s);
  if (n < 10n ** 18n) return n.toString();
  return (Number(n) / 1e18).toFixed(4) + " …";
}
