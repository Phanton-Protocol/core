import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

const stats = [
  { value: '1', label: 'SHIELDED POOL FOR MANY USES' },
  { value: '3+', label: 'PRIMARY PAYROLL / TREASURY FLOWS' },
  { value: 'ZK', label: 'PRIVACY WITH AUDIT TRAILS' },
  { value: 'API', label: 'BACKEND-FIRST PROVER LAYER' },
  { value: 'FHE / OTC', label: 'INTERNAL MATCHING — SWAPS LIVE' },
];

const Hero = () => {
  const fade = (delay = 0) => ({
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] },
  });

  return (
    <section
      id="hero"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        paddingTop: '8rem',
        paddingBottom: '6rem',
        position: 'relative',
      }}
    >
      <div className="container" style={{ width: '100%' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(160px, 240px)', gap: '3rem', alignItems: 'center' }}>

          {/* Left: Headline */}
          <div>
            <motion.div {...fade(0.1)} className="section-label">
              Privacy by Proof. Invisible by Design.
            </motion.div>

            <motion.h1
              {...fade(0.25)}
              className="display-xl"
              style={{ marginBottom: 'clamp(1.5rem, 4vw, 2.5rem)', maxWidth: 'min(820px, 100%)' }}
            >
              The Privacy Layer: <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>FHE + ZK-SNARKs</span>
            </motion.h1>

            <motion.p
              {...fade(0.4)}
              style={{
                maxWidth: 'min(520px, 100%)',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--body-size)',
                fontWeight: 500,
                lineHeight: 'var(--body-line)',
                marginBottom: 'clamp(1.75rem, 4vw, 3rem)',
              }}
            >
              Phantom Protocol delivers Confidentiality as a Service (CaaS),
              providing a high-performance privacy layer designed for the rigorous
              demands of professional traders, global banking institutions, and
              secure corporate payroll systems.
            </motion.p>

            <motion.div {...fade(0.5)} style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <Link
                to="/trade"
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--btn-text-size)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: 'var(--color-accent-primary)',
                  color: 'var(--color-bg-primary)',
                  padding: '0.85rem 1.75rem',
                  textDecoration: 'none',
                  fontWeight: 600,
                  transition: 'opacity 0.3s, box-shadow 0.3s, transform 0.3s',
                  border: '1px solid var(--color-accent-primary)',
                }}
                className="btn-cyan"
                onMouseEnter={e => { e.target.style.opacity = '0.93'; e.target.style.boxShadow = 'none'; e.target.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.target.style.opacity = '1'; e.target.style.boxShadow = 'none'; e.target.style.transform = 'none'; }}
              >
                InternalMatching
              </Link>
              <a href="#architecture" className="btn-outline">
                How it works
              </a>
              <a href="#newsletter" className="btn-outline">
                Subscribe newsletter
              </a>
              <Link to="/relayer" className="btn-outline">
                Become a relayer
              </Link>
              <a href="#investors" className="btn-outline">
                Ecosystem Participants
              </a>
            </motion.div>
          </div>

          {/* Right: Stats */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6, duration: 1 }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '2.5rem',
              minWidth: '160px',
              alignSelf: 'flex-end',
              paddingBottom: '1rem',
            }}
          >
            {stats.map((s, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.7 + i * 0.1, duration: 0.6 }}
                style={{ textAlign: 'right' }}
              >
                <div className="stat-value">{s.value}</div>
                <div className="stat-label">{s.label}</div>
              </motion.div>
            ))}
          </motion.div>

        </div>
      </div>

      {/* Bottom fade */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '120px',
        background: 'linear-gradient(to bottom, transparent, rgba(2, 2, 2, 0.82))',
        pointerEvents: 'none',
      }} />

      {/* Responsive: hide stats on small screens */}
      <style>{`
        @media (max-width: 1366px) {
          #hero > .container > div {
            gap: 2rem !important;
          }
        }
        @media (max-width: 1180px) {
          #hero > .container > div {
            grid-template-columns: 1fr !important;
          }
          #hero > .container > div > div:last-child {
            display: none !important;
          }
        }
        @media (max-width: 768px) {
          #hero {
            padding-top: 7rem !important;
            padding-bottom: 4.5rem !important;
          }
          #hero > .container > div > div:last-child {
            display: none !important;
          }
        }
      `}</style>
    </section>
  );
};

export default Hero;
