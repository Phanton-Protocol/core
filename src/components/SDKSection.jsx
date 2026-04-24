import { useState } from 'react';
import { motion } from 'framer-motion';

const useCases = [
  {
    title: 'On-chain contracts',
    desc: 'Integrate your dApps with the shielded pool. Use our contract interfaces (ShieldedPool, NoteStorage, SwapAdaptor) to add private deposits, swaps, and withdrawals to your protocol or DAO.',
  },
  {
    title: 'Messaging & payments',
    desc: 'Build private payment rails or messaging layers that settle through Phantom. Users get shielded transfers and optional per-wallet disclosure for compliance.',
  },
  {
    title: 'Treasury & payroll apps',
    desc: 'Dashboards, payroll runners, and treasury tools that call our relayer API for proofs and submissions. Run payroll or rebalance without exposing amounts on-chain.',
  },
  {
    title: 'Trading & automation',
    desc: 'Bots and aggregators that submit swaps via our API, use internal OTC matching when available, or route through the pool for privacy-preserving execution.',
  },
];

const SDKSection = () => {
  const [showComingSoon, setShowComingSoon] = useState(false);

  return (
  <section className="section" id="sdk">
    <div className="container">
      <div style={{ marginBottom: '4rem' }}>
        <div className="section-label">Build on Phantom</div>
        <h2 className="display-lg">
          SDK & APIs.
          <br />
          <em>Build applications.</em>
        </h2>
        <p style={{ color: '#fff', fontSize: 'var(--body-size)', fontWeight: 500, lineHeight: 'var(--body-line)', maxWidth: '680px', marginTop: '1.5rem' }}>
          Use Phantom’s APIs and contract interfaces to build on-chain contracts, messaging apps, treasury tools, and more. Our relayer API handles proof generation and transaction submission; you bring the product.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem', marginBottom: '4rem' }}>
        {useCases.map((item, idx) => (
          <motion.div
            key={idx}
            className="card"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: idx * 0.08, duration: 0.5 }}
            style={{ padding: '1.75rem' }}
          >
            <h3 style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: '1.05rem', color: '#fff', marginBottom: '0.5rem' }}>
              {item.title}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--body-size)', fontWeight: 500, lineHeight: 'var(--body-line)', margin: 0 }}>
              {item.desc}
            </p>
          </motion.div>
        ))}
      </div>

      <div className="card" style={{ padding: '2.5rem', background: 'var(--bg-card)', marginBottom: '2rem' }}>
        <div className="mono text-cyan" style={{ fontSize: '0.6rem', letterSpacing: '0.18em', marginBottom: '1.25rem' }}>
          WHAT YOU GET
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem 2rem' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 600, marginBottom: '0.35rem' }}>Relayer API</div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0, lineHeight: 1.5 }}>
              REST endpoints for quote, intent, swap, deposit, withdraw, merkle proofs, and health. Submit proofs and get receipts.
            </p>
          </div>
          <div>
            <div style={{ color: '#fff', fontWeight: 600, marginBottom: '0.35rem' }}>Contract interfaces</div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0, lineHeight: 1.5 }}>
              ShieldedPool, NoteStorage, SwapAdaptor, RelayerStaking. ABIs and deployment addresses for BNB Chain environments.
            </p>
          </div>
          <div>
            <div style={{ color: '#fff', fontWeight: 600, marginBottom: '0.35rem' }}>Client patterns</div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0, lineHeight: 1.5 }}>
              TypeScript/JS client for wallet integration, note handling, and API calls. Use our DApp as reference or ship your own UI.
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <button
          type="button"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            background: 'var(--cyan)',
            color: '#0a0a0a',
            padding: '0.85rem 1.75rem',
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
            transition: 'opacity 0.3s, box-shadow 0.3s',
          }}
          onClick={() => setShowComingSoon(true)}
          onMouseEnter={e => { e.target.style.opacity = '0.9'; e.target.style.boxShadow = 'none'; }}
          onMouseLeave={e => { e.target.style.opacity = '1'; e.target.style.boxShadow = 'none'; }}
        >
          SDK
        </button>
      </div>

      {showComingSoon && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setShowComingSoon(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.62)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
            padding: '1rem',
          }}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '420px',
              padding: '1.5rem',
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
            }}
          >
            <div className="section-label" style={{ marginBottom: '0.75rem' }}>SDK</div>
            <h3 style={{ fontFamily: 'var(--font-body)', fontWeight: 700, color: '#fff', marginBottom: '0.5rem' }}>
              Coming soon
            </h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              SDK access will be available soon.
            </p>
            <button
              type="button"
              className="btn-outline btn-outline-cyan"
              onClick={() => setShowComingSoon(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  </section>
  );
};

export default SDKSection;
