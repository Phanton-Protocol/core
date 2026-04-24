import { motion } from 'framer-motion';

const Roadmap = () => {
    const phases = [
        {
            num: "Phase 1",
            completed: true,
            title: "Confidentiality Engine",
            desc: "",
            items: ["Shielded Pool Architectural Flow Design", "ZK Circuit Development", "FHE Architecture Design", "Relayer Architecture Build on BNB Chain"]
        },
        {
            num: "Phase 2",
            completed: true,
            title: "The Confidentiality Rail",
            desc: "",
            items: [
                "Production FHE Matching Implementation",
                "Merkle Tree Growth Under Live Load",
                "Fully On-Chain Deposit / Withdraw / Swap Execution",
                "Payroll System Architecture",
                "Bank Integration Architecture",
                "Integration Rails for Launch Readiness"
            ]
        },
        {
            num: "Phase 3",
            current: true,
            title: "Confidentiality Activation",
            desc: "",
            items: ["Launch Campaigns", "Protocol Stress Testing", "Real Payroll System Rollout", "Base Chain Addition"]
        },
        {
            num: "Phase 4",
            title: "Confidentiality Mainnet",
            desc: "",
            items: [
                "Mainnet Go-Live",
                "Protocol Token Launch",
                "Relayer Staking on Mainnet",
                "Protocol Activation on Mainnet",
                "Additional EVM Chain Expansion",
                "Payroll System Stress Testing"
            ]
        },
        {
            num: "Phase 5",
            title: "Confidentiality Adoption & Expansion",
            desc: "",
            items: [
                "Payroll System Live on Mainnet",
                "Awareness Campaigns for Organisations",
                "Bank SaaS Model Stress Testing",
                "Solana Chain Addition"
            ]
        },
        {
            num: "Phase 6",
            title: "Banking SaaS Launch",
            desc: "",
            items: [
                "Banking SaaS Model Launch",
                "Partnerships with Private Banks",
                "Partnerships with Public Banks",
                "BTC Network Integration Research for Phantom Protocol"
            ]
        }
    ];

    return (
        <section className="section" id="roadmap">
            <div className="container">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '4rem', flexWrap: 'wrap', gap: '2rem' }}>
                    <div>
                        <div className="section-label">Deployment Schedule</div>
                        <h2 className="display-lg">
                            The<br /><em>roadmap.</em>
                        </h2>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {phases.map((phase, idx) => (
                        <motion.div
                            key={idx}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: idx * 0.15, duration: 0.6 }}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(80px, auto) 1fr',
                                gap: '3rem',
                                padding: '2rem 0',
                                borderTop: idx === 0 ? '1px solid var(--border)' : '1px solid rgba(255,255,255,0.03)'
                            }}
                        >
                            <div className="display-lg" style={{ color: 'var(--text-tertiary)', fontSize: 'clamp(3rem, 5vw, 4.5rem)', lineHeight: 0.9 }}>
                                <span
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '1em',
                                        marginRight: '0.2em',
                                        color: 'var(--cyan)',
                                        fontSize: '0.8em'
                                    }}
                                >
                                    {phase.completed ? '✓' : phase.current ? '➜' : ''}
                                </span>
                                {phase.num}
                            </div>
                            <div>
                                <h3 style={{
                                    fontFamily: 'var(--font-display)',
                                    fontSize: '2rem',
                                    fontWeight: 400,
                                    marginBottom: '1rem',
                                    color: 'var(--cyan)'
                                }}>
                                    {phase.title}
                                </h3>
                                {phase.desc && (
                                    <p style={{
                                        color: '#fff',
                                        fontSize: 'var(--body-size)',
                                        fontWeight: 500,
                                        lineHeight: 'var(--body-line)',
                                        maxWidth: '600px',
                                        marginBottom: '2rem'
                                    }}>
                                        {phase.desc}
                                    </p>
                                )}
                                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                                    {phase.items.map((item, i) => (
                                        <div key={i} className="mono text-muted" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <span style={{ width: 4, height: 4, background: 'var(--cyan)', borderRadius: '50%' }} />
                                            {item}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </motion.div>
                    ))}
                    <div className="divider" />
                </div>
            </div>

            <style>{`
                @media (max-width: 640px) {
                    #roadmap .container > div:last-child > div {
                        grid-template-columns: 1fr !important;
                        gap: 1.5rem !important;
                    }
                }
            `}</style>
        </section>
    );
};

export default Roadmap;
