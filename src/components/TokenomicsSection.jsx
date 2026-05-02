import { motion } from 'framer-motion';

const tokenSummary = [
  { label: 'Total supply', value: '1,000,000,000 PPT' },
  { label: 'Listing price', value: '$0.12' },
  { label: 'Initial Network Capacity', value: '4.12%' },
  { label: 'Project Funding for Infrastructure Development', value: '$19,000,000' },
];

const allocations = [
  { name: 'Ecosystem Growth Fund', percent: '25.00%', tokens: '250,000,000' },
  { name: 'Private', percent: '10.00%', tokens: '100,000,000' },
  { name: 'Strategic', percent: '10.00%', tokens: '100,000,000' },
  { name: 'Treasury', percent: '10.00%', tokens: '100,000,000' },
  { name: 'Liquidity', percent: '10.00%', tokens: '100,000,000' },
  { name: 'Team', percent: '8.00%', tokens: '80,000,000' },
  { name: 'LP Mining Rewards', percent: '5.00%', tokens: '50,000,000' },
  { name: 'Marketing', percent: '5.00%', tokens: '50,000,000' },
  { name: 'Advisors', percent: '5.00%', tokens: '50,000,000' },
  { name: 'Pre-Seed', percent: '4.00%', tokens: '40,000,000' },
  { name: 'Seed', percent: '4.00%', tokens: '40,000,000' },
  { name: 'KOL Round', percent: '2.00%', tokens: '20,000,000' },
  { name: 'Airdrop', percent: '1.00%', tokens: '10,000,000' },
  { name: 'Community Round', percent: '1.00%', tokens: '10,000,000' },
];

const vestingHighlights = [
  'Team: 12-month cliff, then 36-month daily vesting (48 months total).',
  'Treasury: 18-month cliff, then 54-month daily vesting (72 months total).',
  'Liquidity: 15% unlocked at TGE, then 18-month daily vesting.',
  'Ecosystem Growth Fund: 48-month daily vesting with no cliff.',
];

export default function TokenomicsSection() {
  return (
    <section className="section" id="tokenomics">
      <div className="container">
        <div style={{ marginBottom: '2rem' }}>
          <div className="section-label">$PPT Tokenomics</div>
          <h2 className="display-lg">Token distribution and release schedule.</h2>
          <p style={{ color: '#fff', fontSize: 'var(--body-size)', fontWeight: 500, lineHeight: 'var(--body-line)', maxWidth: 760, marginTop: '1rem' }}>
            Supply and vesting data from the current tokenomics model. This section shows headline metrics, allocation split, and key vesting parameters used for release planning.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          {tokenSummary.map((item, idx) => (
            <motion.div
              key={item.label}
              className="card"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: idx * 0.06 }}
              style={{ padding: '1rem 1.1rem' }}
            >
              <div className="mono text-cyan" style={{ marginBottom: '0.45rem' }}>{item.label}</div>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: '1.05rem' }}>{item.value}</div>
            </motion.div>
          ))}
        </div>

        <div className="card" style={{ padding: '1rem 1rem 1.2rem', overflowX: 'auto' }}>
          <div className="mono text-cyan" style={{ marginBottom: '0.75rem' }}>Allocation</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', color: '#fff', fontSize: '0.78rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.55rem 0.45rem' }}>Category</th>
                <th style={{ textAlign: 'right', color: '#fff', fontSize: '0.78rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.55rem 0.45rem' }}>% Supply</th>
                <th style={{ textAlign: 'right', color: '#fff', fontSize: '0.78rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.55rem 0.45rem' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((row) => (
                <tr key={row.name} style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                  <td style={{ color: 'rgba(255,255,255,0.92)', padding: '0.62rem 0.45rem', fontWeight: 500 }}>{row.name}</td>
                  <td style={{ color: 'var(--cyan)', padding: '0.62rem 0.45rem', textAlign: 'right', fontWeight: 600 }}>{row.percent}</td>
                  <td style={{ color: 'rgba(255,255,255,0.86)', padding: '0.62rem 0.45rem', textAlign: 'right' }}>{row.tokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ marginTop: '1rem', padding: '1rem 1.1rem' }}>
          <div className="mono text-cyan" style={{ marginBottom: '0.7rem' }}>Vesting highlights</div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.45rem' }}>
            {vestingHighlights.map((item) => (
              <li key={item} style={{ color: 'rgba(255,255,255,0.9)', lineHeight: 1.6 }}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
