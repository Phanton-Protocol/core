export const blogPosts = [
  {
    slug: 'partnership-crypto-rafts-pr',
    title: 'Partnership with Crypto Rafts',
    excerpt:
      'Phantom Protocol and Crypto Rafts are teaming up. Read the full partnership release for scope, timing, and what it means for users.',
    date: 'MAY 04, 2026',
    readTime: '2 min read',
    category: 'ANNOUNCEMENT',
    description:
      'Official partnership announcement: Phantom Protocol x Crypto Rafts. Summary on the blog; full details in the downloadable PR PDF.',
    intro:
      'We are announcing a strategic partnership with Crypto Rafts to extend how builders and communities discover and use privacy-preserving infrastructure. The release below summarizes the collaboration; the PDF contains the complete press statement and quotes.',
    pdfHref: '/partnership-crypto-rafts-pr.pdf',
    pdfLabel: 'Partnership release (PDF)',
    sections: [
      {
        heading: 'What this partnership is about',
        body: 'Crypto Rafts and Phantom Protocol are aligning on education, distribution, and practical paths for teams that want confidential execution without giving up verifiable settlement. Together we focus on clear communication, safer defaults, and real workflows—not hype.',
      },
      {
        heading: 'Read the full release',
        body: 'The official PR PDF includes the full narrative, partner context, and next steps. Download it from this page or open it in a new tab if you prefer to read inline.',
      },
    ],
  },
  {
    slug: 'private-defi-for-teams',
    title: 'Private DeFi for teams: treasury, payroll, and execution',
    excerpt: 'How teams can move from fully public on-chain operations to controlled confidentiality without losing settlement.',
    date: 'APR 07, 2026',
    readTime: '7 min read',
    category: 'PRODUCT',
    description: 'How teams can run treasury and payroll operations with stronger confidentiality while keeping on-chain settlement and controls.',
    intro: 'Teams that operate on-chain quickly run into a real problem: everyone can see balances, transfer timing, and counterparties. That can leak negotiation power, salary information, and strategy. Private DeFi infrastructure helps teams keep operations sane while still settling on-chain.',
    sections: [
      {
        heading: 'Treasury operations without broadcasting every move',
        body: 'With shielded note transitions, treasury managers can rebalance and route liquidity without exposing every internal step to external observers. This can reduce signaling risk during large or sensitive moves.',
      },
      {
        heading: 'Payroll workflows with practical privacy boundaries',
        body: 'Payroll-style flows can be orchestrated as batches of standard withdrawals. Internally, note history can remain private; externally, final payouts remain verifiable. This gives a better balance between confidentiality and accounting requirements.',
      },
      {
        heading: 'Operational controls still matter',
        body: 'Privacy does not replace governance. Teams still need approval workflows, key management, rate limits, and policy checks. The strongest setups combine cryptography with disciplined operational controls and monitoring.',
      },
    ],
  },
  {
    slug: 'relayer-failover-explained',
    title: 'Relayer failover explained: what happens when one relayer goes down',
    excerpt: 'A practical explanation of automatic relayer fallback and why it matters for uptime and operations.',
    date: 'APR 07, 2026',
    readTime: '5 min read',
    category: 'USE CASE',
    description: 'How automatic relayer failover works in Phantom Protocol frontend flows and why it improves reliability.',
    intro: 'A single relayer is a single point of operational failure. If that relayer is down, users cannot submit transactions through it. The right answer is failover: attempt primary relayer first, then automatically retry on healthy secondary relayers.',
    sections: [
      {
        heading: 'What failover does',
        body: 'When a request fails due to network issues or retriable server errors, the client can automatically try the next configured relayer endpoint. Users do not need to manually switch URLs every time.',
      },
      {
        heading: 'What failover does not do',
        body: 'Failover does not change cryptographic validity rules. Proofs still need to verify, and non-retriable errors like invalid input should fail fast. The goal is reliability, not bypassing protocol checks.',
      },
      {
        heading: 'Best practice in production',
        body: 'Run at least two relayer backends in separate infrastructure zones, monitor health continuously, and keep endpoint rotation simple for clients. Reliability is a protocol-adjacent product feature users feel immediately.',
      },
    ],
  },
];
