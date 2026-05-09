import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ethers } from 'ethers';
import {
  getFhePublicKey,
  encryptFhe,
  createInternalIntent,
  getRelayerConfig,
} from '../api/phantomApi';
import { buildInternalIntentRequest } from '../lib/internalMatchIntent.js';

// Fallback asset map (mirrors backend `bscTestnet.json`); replaced by
// `/config.assets` whenever the relayer reports it.
const FALLBACK_ASSETS = [
  { assetId: '0', symbol: 'WBNB' },
  { assetId: '1', symbol: 'BUSD' },
  { assetId: '2', symbol: 'USDT' },
];

function FHEMatching() {
  const [fheAvailable, setFheAvailable] = useState(null);
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [orderSide, setOrderSide] = useState('sell');
  const [assetIn, setAssetIn] = useState('0');
  const [assetOut, setAssetOut] = useState('1');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState(null);
  const [matchIntentBound, setMatchIntentBound] = useState(false);
  const [busy, setBusy] = useState(false);

  const assets = useMemo(() => {
    const list = Array.isArray(config?.assets) ? config.assets : [];
    return list.length ? list : FALLBACK_ASSETS;
  }, [config?.assets]);

  useEffect(() => {
    let cancelled = false;
    getFhePublicKey()
      .then(() => { if (!cancelled) setFheAvailable(true); })
      .catch(() => { if (!cancelled) setFheAvailable(false); });
    getRelayerConfig()
      .then((cfg) => { if (!cancelled) setConfig(cfg); })
      .catch((e) => { if (!cancelled) setConfigError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  async function getBrowserSigner() {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new Error('No injected wallet found. Connect MetaMask (or another EIP-1193 wallet) and retry.');
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();
    return signer;
  }

  function symbolForAssetId(id) {
    const hit = assets.find((a) => String(a.assetId) === String(id));
    return hit ? String(hit.symbol).toUpperCase() : `ASSET#${id}`;
  }

  const handleSubmitOrder = async () => {
    setError('');
    setOrderId(null);
    setMatchIntentBound(false);
    setStatus('Preparing order…');
    const amountNum = Number(amount);
    const priceNum = Number(price);
    if (!amount || !Number.isFinite(amountNum) || amountNum <= 0) {
      setError('Invalid amount');
      setStatus('');
      return;
    }
    if (!price || !Number.isFinite(priceNum) || priceNum <= 0) {
      setError('Invalid price');
      setStatus('');
      return;
    }
    if (assetIn === assetOut) {
      setError('Asset in and asset out must differ.');
      setStatus('');
      return;
    }
    if (!config?.chainId || !config?.addresses?.shieldedPool) {
      setError('Relayer config missing chainId / shieldedPool. Cannot sign intent.');
      setStatus('');
      return;
    }

    setBusy(true);
    try {
      setStatus('Encrypting amount + price via FHE service…');
      const encResult = await encryptFhe({
        amount: amountNum,
        limitPrice: priceNum,
        side: orderSide,
        assetIn,
        assetOut,
        timestamp: Date.now(),
      });
      const ciphertext = encResult?.ciphertext ?? encResult?.encrypted ?? encResult;
      if (!ciphertext || (typeof ciphertext === 'object' && !Object.keys(ciphertext).length)) {
        throw new Error('FHE encryption unavailable. Order submission is blocked.');
      }

      setStatus('Awaiting wallet signature 1/2 (operator intent)…');
      const signer = await getBrowserSigner();

      setStatus('Awaiting wallet signature 2/2 (FHE match intent)…');
      const expirySec = Math.floor(Date.now() / 1000) + 3600;
      const operatorNonce = Date.now();
      const matchNonce = operatorNonce + 1;
      const body = await buildInternalIntentRequest({
        signer,
        chainId: config.chainId,
        verifyingContract: config.addresses.shieldedPool,
        side: orderSide,
        baseAsset: symbolForAssetId(assetIn),
        quoteAsset: symbolForAssetId(assetOut),
        inputAssetID: assetIn,
        outputAssetID: assetOut,
        amount: String(BigInt(Math.round(amountNum))),
        limitPrice: String(BigInt(Math.round(priceNum))),
        expirySec,
        operatorNonce,
        matchNonce,
        ciphertext,
      });

      setStatus('Submitting signed intent to relayer…');
      const result = await createInternalIntent(body);
      setOrderId(result?.orderId ?? 'submitted');
      setMatchIntentBound(Boolean(result?.matchIntentBound));
      setStatus('Order submitted. Waiting for FHE-matched counterparty.');
    } catch (e) {
      const msg = e?.message || String(e);
      setError(msg);
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      style={{ padding: '1.5rem 2rem' }}
    >
      <div className="section-label" style={{ marginBottom: '1rem' }}>FHE internal matching (OTC)</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        Encrypt amount + price under the FHE service public key, then sign two EIP-712 intents
        (operator + on-chain match-intent) with your wallet. The relayer matches you
        against an opposite signed intent inside the shielded pool. No public order book.
      </p>
      {configError && (
        <p className="mono" style={{ color: '#fb6', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
          Relayer /config error: {configError}
        </p>
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
          disabled={busy}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: busy ? 'rgba(80,80,80,0.6)' : 'var(--cyan)',
            color: '#0a0a0a',
            padding: '0.6rem 1.25rem',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.7 : 1,
          }}
          onClick={handleSubmitOrder}
        >
          {busy ? 'Working…' : 'Sign & place order'}
        </button>
        {status && <span className="mono t-cyan" style={{ fontSize: '0.8rem' }}>{status}</span>}
        {orderId && (
          <span className="mono t-dim" style={{ fontSize: '0.75rem' }}>
            Order: {orderId}
            {matchIntentBound ? ' (FHE match intent bound)' : ''}
          </span>
        )}
      </div>
      {error && <p className="mono" style={{ color: '#f88', fontSize: '0.8rem', marginTop: '0.5rem' }}>{error}</p>}
    </motion.div>
  );
}

export default FHEMatching;
