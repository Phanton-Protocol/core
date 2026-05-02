import { motion } from 'framer-motion';

const pillars = [
  {
    title: 'Shielded liquidity',
    body: 'Balances and swap amounts move through a pool on-chain with the main AMM routers (for example, PancakeSwap for BNB), with ZK proofs and relayer submission—users sign intents, not public DEX transactions.',
  },
  {
    title: 'Operator economics',
    body: 'Relayers stake and execute user flows; gas is modeled from note parameters so the network can align incentives without users broadcasting raw swap txs.',
  },
  {
    title: 'Compliance-oriented design',
    body: 'Chainnalysis screening Reporting keys and public hooks exit alongside privacy so enterprises can reconsile flows for auditors, tax and internal accounting when required',
  },
];

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-40px' },
  transition: { duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] },
});

export default function InvestorSection() {
  return (
    <section className="section" id="investors">
      <div className="container">
        <motion.div {...fade(0)}>
          <div className="section-label">Ecosystem participants & partners</div>
          <h2 className="display-lg" style={{ maxWidth: '14ch' }}>
            One pool, <em>many rails.</em>
          </h2>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--body-size)',
              fontWeight: 500,
              lineHeight: 'var(--body-line)',
              maxWidth: 640,
              marginTop: '1.25rem',
            }}
          >
            Phantom targets teams and treasuries that need programmable privacy on-chain—not anonymity for its own sake, but selective disclosure, audit paths, and
            infrastructure that can sit next to CeFi and traditional reporting.
          </p>
        </motion.div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1.5rem',
            marginTop: 'clamp(2.5rem, 5vw, 3.5rem)',
          }}
        >
          {pillars.map((p, i) => (
            <motion.article
              key={p.title}
              {...fade(0.08 + i * 0.06)}
              className="card"
              style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
            >
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.45rem', fontWeight: 400, lineHeight: 1.2 }}>
                {p.title}
              </h3>
              <p style={{ color: 'rgba(255,255,255,0.82)', fontSize: '0.98rem', lineHeight: 1.65, fontWeight: 500 }}>
                {p.body}
              </p>
            </motion.article>
          ))}
        </div>

      </div>
    </section>
  );
}
