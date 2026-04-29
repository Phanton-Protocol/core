import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { getFhePublicKey, encryptFhe, submitFheOrder } from '../api/phantomApi';

const ASSETS = [
  { id: '0', symbol: 'WBNB' },
  { id: '1', symbol: 'BUSD' },
  { id: '2', symbol: 'USDT' },
  { id: '3', symbol: 'USDC' },
  { id: '4', symbol: 'CAKE' },
];

function FHEMatching() {
  const [fheAvailable, setFheAvailable] = useState(null);
  const [orderSide, setOrderSide] = useState('sell');
  const [assetIn, setAssetIn] = useState('0');
  const [assetOut, setAssetOut] = useState('1');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getFhePublicKey()
      .then(() => { if (!cancelled) setFheAvailable(true); })
      .catch(() => { if (!cancelled) setFheAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSubmitOrder = async () => {
    setError('');
    setStatus('Preparing order…');
    const amountNum = parseFloat(amount);
    const priceNum = parseFloat(price);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      setError('Invalid amount');
      setStatus('');
      return;
    }
    if (!price || isNaN(priceNum) || priceNum <= 0) {
      setError('Invalid price');
      setStatus('');
      return;
    }
    try {
      const payload = {
        side: orderSide,
        assetIn: assetIn,
        assetOut: assetOut,
        amount: amountNum,
        price: priceNum,
        timestamp: Date.now(),
      };
      setStatus('Encrypting…');
      const encResult = await encryptFhe(payload);
      const encrypted = encResult.ciphertext ?? encResult.encrypted ?? encResult;
      if (!encrypted) {
        throw new Error('FHE encryption unavailable. Order submission is blocked.');
      }
      setStatus('Submitting…');
      const result = await submitFheOrder(encrypted);
      setOrderId(result.orderId ?? result.id ?? 'submitted');
      setStatus('Order submitted. Waiting for match.');
    } catch (e) {
      setError(e.message || 'Order failed');
      setStatus('');
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
        Place an order at your chosen price. When a counterparty submits an opposite order at a compatible price, you are matched inside the shielded pool (0.2% fee). No public order book.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Side</label>
          <select
            value={orderSide}
            onChange={(e) => setOrderSide(e.target.value)}
            className="mono"
            style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.85rem',
            }}
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
            style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.85rem',
            }}
          >
            {ASSETS.map((a) => (
              <option key={a.id} value={a.id}>{a.symbol}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mono t-dim" style={{ fontSize: '0.7rem', display: 'block', marginBottom: '0.35rem' }}>Asset out</label>
          <select
            value={assetOut}
            onChange={(e) => setAssetOut(e.target.value)}
            className="mono"
            style={{
              padding: '0.5rem 0.75rem',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.85rem',
            }}
          >
            {ASSETS.map((a) => (
              <option key={a.id} value={a.id}>{a.symbol}</option>
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
            style={{
              width: 120,
              padding: '0.5rem 0.75rem',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.85rem',
            }}
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
            style={{
              width: 120,
              padding: '0.5rem 0.75rem',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              fontSize: '0.85rem',
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: 'var(--cyan)',
            color: '#0a0a0a',
            padding: '0.6rem 1.25rem',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            cursor: 'pointer',
          }}
          onClick={handleSubmitOrder}
          onMouseEnter={(e) => { e.target.style.opacity = 0.9; }}
          onMouseLeave={(e) => { e.target.style.opacity = 1; }}
        >
          Place order
        </button>
        {status && <span className="mono t-cyan" style={{ fontSize: '0.8rem' }}>{status}</span>}
        {orderId && <span className="mono t-dim" style={{ fontSize: '0.75rem' }}>Order: {orderId}</span>}
      </div>
      {error && <p className="mono" style={{ color: '#f88', fontSize: '0.8rem', marginTop: '0.5rem' }}>{error}</p>}
    </motion.div>
  );
}

export default FHEMatching;
