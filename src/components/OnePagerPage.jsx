import Navbar from './Navbar';
import SeoHead from './SeoHead';

const sections = [
  {
    title: 'WHAT IS PHANTOM PROTOCOL?',
    bullets: [
      'Privacy layer for blockchain enabling confidential transactions with zero-knowledge proofs.',
      'Shielded pool protocol: deposit, swap, and withdraw assets with cryptographic privacy guarantees.',
      'Multi-asset support with confidential DEX trading and FHE-based internal matching.',
      'Built for traders, institutions, enterprises, and global payroll operations.',
    ],
  },
  {
    title: 'CORE TECHNOLOGY',
    bullets: [
      'Groth16 SNARKs on BN254: Constant-size proofs (~192 bytes), ~250-350k gas verification.',
      'MiMC7 compression: 91-round hash optimised for zero-knowledge circuits.',
      'Commitment-nullifier model: Cryptographic hiding prevents linking deposits to withdrawals.',
      'Merkle tree membership: Depth-10 tree (1,024 commitments) with MiMC7 parent nodes.',
      'Relayer network: Address unlinkability, gas abstraction, metadata obfuscation.',
    ],
  },
  {
    title: 'HOW IT WORKS',
    bullets: [
      'Deposit: Move tokens into shielded pool -> receive private note (commitment on-chain, plaintext off-chain).',
      'Swap: Trade assets via DEX or internal FHE matching -> output commitments hide amounts/recipients.',
      'Withdraw: Extract to public address -> only withdrawal amount/recipient public, source note private.',
      'Batch: Enterprise payroll/treasury operations with approval workflows and atomic execution.',
    ],
  },
  {
    title: 'MEV & FRONT-RUNNING PROTECTION',
    bullets: [
      'Hidden trade details: Zero-knowledge proofs reveal only nullifiers and commitments (random hashes).',
      'Encrypted submission via relayers: Mempool observers cannot decode trade amounts, assets, or direction.',
      'Internal FHE matching: Complete front-running immunity - orders encrypted end-to-end, no public order book.',
      'DEX route: Partial protection - AMM call is public, but source/amounts remain private in shielded pool.',
    ],
  },
  {
    title: 'FHE CONFIDENTIAL MATCHING',
    bullets: [
      'Orders encrypted with FHE: Parameters stay encrypted during matching.',
      'Compatibility evaluation on ciphertexts without decryption.',
      'Internal settlement: 0.2% fee vs 0.1% DEX fee (better net pricing for size, zero front-running risk, 0 slippage).',
      'Fallback to DEX if no match found.',
    ],
  },
  {
    title: 'PHANTOM 2.0: PAYROLL SaaS',
    bullets: [
      'Global enterprise payroll on blockchain: CSV/API ingestion, multi-asset payouts, fiat off-ramp.',
      'Configurable approval workflows (N-of-M, maker-checker, sequential/parallel).',
      'Employee portal: Digital payslips, payment history, tax exports, blockchain proof-of-payment.',
      'HRIS integration: Workday, ADP, BambooHR connectors (where implemented).',
    ],
  },
  {
    title: 'PHANTOM 3.0: BANKING SaaS',
    bullets: [
      'Institutional privacy infrastructure: Multi-tenant isolation, RBAC, HSM-backed keys.',
      'Intra-bank transfers: Instant settlement off-chain (no gas, complete privacy).',
      'Inter-bank settlement: Privacy-preserving on-chain settlement between institutions.',
      'Compliance: Real-time Chainalysis screening, audit logs, regulator reporting (policy-gated).',
    ],
  },
  {
    title: 'PHANTOM 4.0: SDK PLATFORM',
    bullets: [
      'Developer toolkit: TypeScript SDK (live), Python/Java/Go (planned).',
      'REST APIs, WebSocket events, proof generation, Merkle path helpers.',
      'Semantic versioning, LTS support, circuit pinning for integration stability.',
    ],
  },
  {
    title: 'FEE STRUCTURE & ECONOMICS',
    bullets: [
      'Deposit: ~$2 USD equivalent -> 80% to relayers, 20% to treasury.',
      'Swap (DEX): 0.1% protocol fee + external DEX fees.',
      'Swap (Internal): 0.2% protocol fee (no DEX fees, often cheaper net of slippage).',
      'Withdrawal: No fee.',
      'Relayer earnings: $0.50 fixed per transaction + proportional fee share based on volume.',
    ],
  },
  {
    title: 'GOVERNANCE & DECENTRALIZATION',
    bullets: [
      'All token holders can vote (including staked tokens - no voting rights loss when staking).',
      'Voting power proportional to tokens held/staked.',
      'Mandatory timelock on approved proposals (2-14 days depending on parameter class).',
      'Roadmap: Multisig -> advisory votes -> binding governance -> full community control.',
    ],
  },
  {
    title: 'SECURITY & PRIVACY',
    bullets: [
      'Cryptographic hiding: ~128-bit security (discrete log hardness on BN254, MiMC7 collision resistance).',
      'Trusted setup: Groth16 requires circuit-specific ceremony (future: migrate to transparent setup).',
      'Privacy boundaries: Note contents hidden; deposits/withdrawals inherently public at edges.',
      'Threat mitigation: Multi-relayer censorship resistance, client-side proving, audit logging.',
    ],
  },
  {
    title: 'DEVELOPMENT ROADMAP',
    bullets: [
      'Phase 1-3: Foundation, security audit, and mainnet launch readiness.',
      'Phase 4: Platform & enterprise (Banking/Payroll SaaS beta, HRIS integrations).',
      'Phase 5: Advanced privacy (FHE matching production, view keys, metadata reduction).',
      'Phase 6-8: Ecosystem expansion (multi-language SDKs, cross-chain, developer dApp toolkit).',
    ],
  },
  {
    title: 'KEY USE CASES',
    bullets: [
      'Traders: Private position building, hidden trade amounts, reduced MEV exposure.',
      'Enterprises: Confidential payroll, treasury privacy, supplier payment confidentiality.',
      'Banks: Cross-border settlement, internal transfers, and regulatory compliance with privacy.',
      'Developers: Build privacy-preserving dApps (messaging, healthcare, finance).',
    ],
  },
];

export default function OnePagerPage() {
  return (
    <>
      <SeoHead
        title="Phantom Protocol One Pager"
        description="Investor one pager for Phantom Protocol."
        path="/onepager"
      />
      <Navbar />
      <main
        style={{
          minHeight: '100vh',
          paddingTop: '7.5rem',
          paddingBottom: '3rem',
        }}
      >
        <div className="container" style={{ maxWidth: '980px' }}>
          <h1 className="display-lg" style={{ marginBottom: '0.5rem' }}>
            PHANTOM PROTOCOL
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', marginBottom: '2rem', fontSize: '1.02rem' }}>
            Privacy by Proof. Invisible by Design.
          </p>

          {sections.map((section) => (
            <section key={section.title} style={{ marginBottom: '1.75rem' }}>
              <h2
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.86rem',
                  letterSpacing: '0.12em',
                  color: 'var(--cyan)',
                  marginBottom: '0.7rem',
                }}
              >
                {section.title}
              </h2>
              <ul style={{ margin: 0, paddingLeft: '1.1rem', color: '#fff', lineHeight: 1.65 }}>
                {section.bullets.map((item) => (
                  <li key={item} style={{ marginBottom: '0.35rem' }}>{item}</li>
                ))}
              </ul>
              <div style={{ marginTop: '0.9rem', borderBottom: '1px solid rgba(255,255,255,0.14)' }} />
            </section>
          ))}

          <p className="mono" style={{ color: 'rgba(255,255,255,0.75)', marginTop: '1.4rem' }}>
            One Pager: phantomprotocol.io • Status: Live Buildout • Target Multi-Chain.
          </p>
        </div>
      </main>
    </>
  );
}
