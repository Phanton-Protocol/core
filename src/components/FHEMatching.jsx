// M8 — refactored to consume `useInternalMatch` so the encrypted-order flow is
// the single source of truth across `/trade` (ProtocolUserDapp internal tab)
// and this legacy `/dapp` card. Behavior-preserving: same UI, same submit flow.

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ethers } from 'ethers';
import useInternalMatch from '../hooks/useInternalMatch.js';

const FALLBACK_ASSETS = [
  { assetId: '0', symbol: 'WBNB' },
  { assetId: '1', symbol: 'BUSD' },
  { assetId: '2', symbol: 'USDT' },
];

function FHEMatching() {
  const [signer, setSigner] = useState(null);
  const [signerAddress, setSignerAddress] = useState(null);
  const [orderSide, setOrderSide] = useState('sell');
  const [assetIn, setAssetIn] = useState('0');
  const [assetOut, setAssetOut] = useState('1');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function connect() {
      if (typeof window === 'undefined' || !window.ethereum) return;
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        await provider.send('eth_requestAccounts', []);
        const s = await provider.getSigner();
        const addr = await s.getAddress();
        if (cancelled) return;
        setSigner(s);
        setSignerAddress(addr);
      } catch {
        // No wallet — render fallback UI below.
      }
    }
    connect();
    return () => { cancelled = true; };
  }, []);

  const im = useInternalMatch({ signer, address: signerAddress, autoFetch: true });
  const {
    config,
    configError,
    fheAvailable,
    isEnrolled,
    enroll,
    submitInternalOrder,
    status,
    error,
    busy,
    lastOrder,
    privacyCopy,
  } = im;

  const assets = useMemo(() => {
    const list = Array.isArray(config?.assets) ? config.assets : [];
    return list.length ? list : FALLBACK_ASSETS;
  }, [config?.assets]);

  if (fheAvailable === null) {
    return (
      <div className="card" style={{ padding: '1.5rem 2rem' }}>
        <span className="mono t-dim">Checking FHE service…</span>
      </div>
    );
  }

  if (!fheAvailable) {
    return (
      <div className="card" style={{ padding: '1.5rem 2rem', borderColor: 'rgba(255,180,0,0.25)' }}>
        <div className="section-label" style={{ marginBottom: '0.5rem' }}>FHE internal matching</div>
        <p className="mono t-dim" style={{ fontSize: '0.9rem' }}>
          FHE matching service is not available. Use DEX swap in the DApp when the backend FHE endpoint is running.
        </p>
      </div>
    );
  }

  const handleSubmit = async () => {
    try {
      await submitInternalOrder({ side: orderSide, amount, price, assetIn, assetOut });
    } catch {
      // hook already exposes error/state
    }
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      style={{ padding: '1.5rem 2rem' }}
    >
      <div className="section-label" style={{ marginBottom: '1rem' }}>FHE internal matching (OTC)</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>
        {privacyCopy.headline}
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginBottom: '1.25rem', lineHeight: 1.45, opacity: 0.85 }}>
        {privacyCopy.v1Disclaimer}
      </p>
      {configError && (
        <p className="mono" style={{ color: '#fb6', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
          Relayer /config error: {configError}
        </p>
      )}

      {!isEnrolled && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.85rem 1rem',
            border: '1px solid rgba(0,229,199,0.32)',
            borderRadius: 6,
            background: 'rgba(0,229,199,0.08)',
          }}
        >
          <div className="mono" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
            One-time on-chain opt-in required (pays a small BNB gas fee).
          </div>
          <button
            type="button"
            disabled={!signer || busy}
            onClick={() => enroll(signer).catch(() => {})}
            className="mono"
            style={{
              fontSize: '0.78rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: busy ? 'rgba(80,80,80,0.6)' : 'var(--cyan)',
              color: '#0a0a0a',
              padding: '0.55rem 1.1rem',
              border: 'none',
              borderRadius: 4,
              fontWeight: 600,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Working…' : 'Enroll in internal match'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Side</label>
          <select
            value={orderSide}
            onChange={(e) => setOrderSide(e.target.value)}
            className="mono"
            style={{ padding: '0.5rem 0.75rem', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', fontSize: '0.85rem' }}
          >
            <option value="sell">Sell</option>
            <option value="buy">Buy</option>
          </select>
        </div>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Asset in</label>
          <select
            value={assetIn}
            onChange={(e) => setAssetIn(e.target.value)}
            className="mono"
            style={{ padding: '0.5rem 0.75rem', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', fontSize: '0.85rem' }}
          >
            {assets.map((a) => (
              <option key={a.assetId} value={String(a.assetId)}>{a.symbol}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Asset out</label>
          <select
            value={assetOut}
            onChange={(e) => setAssetOut(e.target.value)}
            className="mono"
            style={{ padding: '0.5rem 0.75rem', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', fontSize: '0.85rem' }}
          >
            {assets.map((a) => (
              <option key={a.assetId} value={String(a.assetId)}>{a.symbol}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Amount</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mono"
            style={{ width: 120, padding: '0.5rem 0.75rem', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', fontSize: '0.85rem' }}
          />
        </div>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Price</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mono"
            style={{ width: 120, padding: '0.5rem 0.75rem', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border)', borderRadius: 4, color: '#fff', fontSize: '0.85rem' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy || !isEnrolled}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: busy || !isEnrolled ? 'rgba(80,80,80,0.6)' : 'var(--cyan)',
            color: '#0a0a0a',
            padding: '0.6rem 1.25rem',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
          onClick={handleSubmit}
        >
          {busy ? 'Working…' : 'Sign & place order'}
        </button>
        {status && <span className="mono t-cyan" style={{ fontSize: '0.8rem' }}>{status}</span>}
        {lastOrder?.orderId && (
          <span className="mono t-dim" style={{ fontSize: '0.75rem' }}>
            Order: {lastOrder.orderId}
            {lastOrder.matchIntentBound ? ' (FHE match intent bound)' : ''}
          </span>
        )}
      </div>
      {error && <p className="mono" style={{ color: '#f88', fontSize: '0.8rem', marginTop: '0.5rem' }}>{error}</p>}
    </motion.div>
  );
}

export default FHEMatching;
