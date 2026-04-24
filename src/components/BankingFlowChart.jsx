import React from 'react';
import { motion } from 'framer-motion';

const canAnimate = () => {
    if (typeof window === 'undefined') return true;
    return !(
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ||
        window.matchMedia?.('(pointer: coarse)')?.matches ||
        window.innerWidth <= 900
    );
};

const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
};
const itemVariants = {
    hidden: { opacity: 0, y: 6 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

const SvgGrid = () => (
    <>
        <defs>
            <pattern id="bcg" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.025)" strokeWidth="1" />
            </pattern>
            <marker id="arr-w" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="rgba(255,255,255,0.6)" />
            </marker>
            <marker id="arr-g" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="rgba(34,197,94,0.8)" />
            </marker>
            <marker id="arr-c" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="rgba(158,164,170,0.8)" />
            </marker>
            <marker id="arr-p" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="rgba(168,85,247,0.8)" />
            </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#bcg)" />
    </>
);

// Animated flow path
const Conn = ({ d, label, labelX, labelY, color, dashed = false, marker = 'arr-w', dur = '3s', delay = 0 }) => {
    const anim = canAnimate();
    return (
        <motion.g variants={itemVariants}>
            <motion.path
                d={d} fill="none" stroke={color} strokeWidth="1.5"
                strokeDasharray={dashed ? '5,4' : '0'}
                markerEnd={`url(#${marker})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 0.75 }}
                transition={{ duration: 1.6, delay }}
            />
            {anim && !dashed && (
                <motion.circle r="2.5" fill="#fff" opacity="0.9">
                    <animateMotion dur={dur} repeatCount="indefinite" path={d} begin={`${delay}s`} />
                </motion.circle>
            )}
            {label && (
                <text x={labelX} y={labelY} fill={color} fontFamily="var(--font-mono)"
                    fontSize="9.5" textAnchor="middle" letterSpacing="0.08em"
                    stroke="rgba(0,0,0,0.85)" strokeWidth="4" paintOrder="stroke">
                    {label}
                </text>
            )}
        </motion.g>
    );
};

// Step badge — ①②③…
const Step = ({ x, y, n, color }) => (
    <motion.g variants={itemVariants}>
        <circle cx={x} cy={y} r="11" fill="rgba(0,0,0,0.75)" stroke={color} strokeWidth="1.5" />
        <text x={x} y={y + 4} fill={color} fontFamily="var(--font-mono)"
            fontSize="10" fontWeight="bold" textAnchor="middle">{n}</text>
    </motion.g>
);

// Pool outer boundary
const Pool = ({ x, y, w, h, label, sublabel, color }) => (
    <motion.g variants={itemVariants}>
        <rect x={x} y={y} width={w} height={h}
            fill={`${color.replace('1)', '0.025)')}`}
            stroke={color} strokeWidth="2" strokeDasharray="10 5" rx="14" />
        <rect x={x + 4} y={y + 4} width={w - 8} height={h - 8}
            fill="none" stroke={`${color.replace('1)', '0.07)')}`} strokeWidth="1" rx="10" />
        {/* Top-left label pill */}
        <rect x={x + 16} y={y - 13} width={sublabel ? 280 : 220} height="26"
            fill="rgba(0,0,0,0.8)" stroke={color} strokeWidth="1" rx="13" />
        <text x={x + 24} y={y + 4} fill={color} fontFamily="var(--font-mono)"
            fontSize="11" fontWeight="bold" letterSpacing="0.12em">{label}</text>
        {sublabel && (
            <text x={x + 24 + (label.length * 6.8)} y={y + 4}
                fill="rgba(255,255,255,0.35)" fontFamily="var(--font-system)" fontSize="9.5">
                {'  ·  '}{sublabel}
            </text>
        )}
    </motion.g>
);

// Bank sub-pool
const SubPool = ({ x, y, w, h, title, color }) => (
    <motion.g variants={itemVariants}>
        <rect x={x} y={y} width={w} height={h}
            fill="rgba(0,0,0,0.45)"
            stroke={color} strokeWidth="1.5" strokeDasharray="6 3" rx="8" />
        <rect x={x} y={y} width="4" height={h} fill={color} rx="2" />
        <text x={x + w / 2} y={y + 22}
            fill={color} fontFamily="var(--font-mono)" fontSize="12"
            fontWeight="bold" textAnchor="middle" letterSpacing="0.1em">{title}</text>
    </motion.g>
);

// Hex bank/user node
const Node = ({ x, y, label, sub, color, active = false }) => {
    const s = 22;
    const anim = canAnimate();
    return (
        <motion.g variants={itemVariants}>
            {active && (
                <circle cx={x} cy={y} r={s + 12} fill="none" stroke={color}
                    strokeWidth="1" strokeDasharray="2 5" opacity="0.6">
                    {anim && <animateTransform attributeName="transform" type="rotate"
                        from={`0 ${x} ${y}`} to={`360 ${x} ${y}`} dur="7s" repeatCount="indefinite" />}
                </circle>
            )}
            <polygon
                points={`${x},${y-s} ${x+s-4},${y-s/2} ${x+s-4},${y+s/2} ${x},${y+s} ${x-s+4},${y+s/2} ${x-s+4},${y-s/2}`}
                fill={`${color.replace('1)', '0.09)')}`}
                stroke={color} strokeWidth="1.5" />
            <circle cx={x} cy={y} r={s - 9} fill="none" stroke={color}
                strokeWidth="0.7" strokeDasharray="3 3" opacity="0.3">
                {anim && <animateTransform attributeName="transform" type="rotate"
                    from={`360 ${x} ${y}`} to={`0 ${x} ${y}`} dur="14s" repeatCount="indefinite" />}
            </circle>
            <text x={x} y={sub ? y + 1 : y + 4} fill="#fff"
                fontFamily="var(--font-mono)" fontSize="11" fontWeight="bold" textAnchor="middle">{label}</text>
            {sub && (
                <text x={x} y={y + 34} fill={color} fontFamily="var(--font-system)"
                    fontSize="8" textAnchor="middle" opacity="0.7">{sub}</text>
            )}
        </motion.g>
    );
};

// Annotation box (right-side notes)
const Annotation = ({ x, y, w, lines, color }) => (
    <motion.g variants={itemVariants}>
        <rect x={x} y={y} width={w} height={lines.length * 22 + 22}
            fill="rgba(3,7,12,0.96)" stroke="rgba(255,255,255,0.24)" strokeWidth="1.3" rx="6" />
        <rect x={x} y={y} width="3" height={lines.length * 22 + 22} fill={color} rx="1.5" />
        {lines.map((l, i) => (
            <text key={i} x={x + 12} y={y + 17 + i * 22}
                fill={i === 0 ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.9)'}
                fontFamily={i === 0 ? 'var(--font-mono)' : 'var(--font-system)'}
                fontSize={i === 0 ? '12.5' : '11.5'} fontWeight={i === 0 ? 'bold' : 'normal'}
                letterSpacing={i === 0 ? '0.08em' : '0'}
                stroke="rgba(0,0,0,0.92)" strokeWidth="2.6" paintOrder="stroke">{l}</text>
        ))}
    </motion.g>
);

// ─── Main ────────────────────────────────────────────────────────────────────

const BankingFlowChart = () => {
    const C = {
        cyan:   'rgba(158, 164, 170, 1)',
        purple: 'rgba(168, 85, 247, 1)',
        blue:   'rgba(59, 130, 246, 1)',
        green:  'rgba(34, 197, 94, 1)',
        rose:   'rgba(244, 63, 94, 1)',
        yellow: 'rgba(234, 179, 8, 1)',
        white:  'rgba(255, 255, 255, 0.85)',
    };

    return (
        <motion.div
            className="whitepaper-diagram-frame"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
        >
            <svg width="100%" height="auto" viewBox="0 0 1600 1050"
                preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
                <SvgGrid />
                <g transform="translate(0 0) scale(1)">

                {/* ── ON-CHAIN BADGE ─────────────────────────────────── */}
                <motion.g variants={itemVariants}>
                    <rect x="360" y="28" width="170" height="28"
                        fill="rgba(158,164,170,0.06)" stroke={C.cyan} strokeWidth="1" strokeDasharray="4 4" rx="14" />
                    <text x="445" y="47" fill={C.cyan} fontFamily="var(--font-mono)"
                        fontSize="10.5" textAnchor="middle" letterSpacing="0.16em"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.2" paintOrder="stroke">★ ON-CHAIN ★</text>
                </motion.g>

                {/* ① Onboarding + CREATE2 mapping */}
                <Conn d="M 1280 109 L 1155 109 L 1155 140"
                    color={C.cyan} marker="arr-c"
                    label="" dur="2.5s"  />
                <Step x={1242} y={109} n="①" color={C.cyan} />
                <Conn
                    d="M 1265 114 L 1235 114 L 1235 128 L 1155 128"
                    color={C.cyan}
                    dashed
                    marker="arr-c"
                    label=""
                    dur="2.3s"
                    delay={0.2}
                />

                {/* ── STATE BANK COUNTRY 1 ───────────────────────────── */}
                <Pool x="80" y="72" w="1220" h="370"
                    label="STATE BANK — COUNTRY 1" sublabel="Master Ledger Pool" color={C.purple} />

                {/* Annotation: Country 1 */}

                {/* Bank ABC */}
                <SubPool x="110" y="120" w="490" h="290" title="BANK: ABC" color={C.blue} />
                <motion.g variants={itemVariants}>
                    <rect x="140" y="158" width="210" height="112" fill="rgba(0,0,0,0.35)" stroke="rgba(59,130,246,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="245" y="176" fill="rgba(147,197,253,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH A1 POOL</text>
                    <rect x="360" y="158" width="210" height="112" fill="rgba(0,0,0,0.35)" stroke="rgba(59,130,246,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="465" y="176" fill="rgba(147,197,253,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH A2 POOL</text>
                </motion.g>
                {[
                    [220, 210, '1', 'USER NODE'],
                    [380, 210, '2', 'USER NODE'],
                    [220, 340, '3', 'USER NODE'],
                    [380, 340, '4', 'USER NODE'],
                ].map(([nx, ny, lbl, sub], i) => (
                    <Node key={i} x={nx} y={ny} label={lbl} sub={sub} color={C.blue} />
                ))}

                {/* ② Branch->bank backend synchronization */}
                <Conn d="M 600 255 L 640 255"
                    color={C.purple} dashed marker="arr-p"
                    label="" delay={0.4}  />

                {/* Bank XYZ */}
                <SubPool x="640" y="120" w="555" h="290" title="BANK: XYZ" color={C.cyan} />
                <motion.g variants={itemVariants}>
                    <rect x="670" y="158" width="240" height="112" fill="rgba(0,0,0,0.35)" stroke="rgba(158,164,170,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="790" y="176" fill="rgba(203,213,225,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH X1 POOL</text>
                    <rect x="930" y="158" width="240" height="112" fill="rgba(0,0,0,0.35)" stroke="rgba(158,164,170,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="1050" y="176" fill="rgba(203,213,225,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH X2 POOL</text>
                </motion.g>
                {[
                    [750, 210, '1', 'USER NODE'],
                    [910, 210, '2', 'USER NODE'],
                    [1065, 210, '3', 'ACTIVE'],
                    [750, 340, '4', 'USER NODE'],
                    [910, 340, '5', 'USER NODE'],
                    [1065, 340, '6', 'USER NODE'],
                ].map(([nx, ny, lbl, sub], i) => (
                    <Node key={i} x={nx} y={ny} label={lbl} sub={sub}
                        color={C.cyan} active={lbl === '3'} />
                ))}

                {/* ③ In-country centralized matching + state reporting */}
                <Conn d="M 910 120 L 910 72"
                    color={C.white} marker="arr-w"
                    label="" dur="2s" delay={0.6}  />

                {/* ── BETWEEN COUNTRIES ─────────────────────────────── */}
                {/* ④ Country pool synchronization */}
                <Conn d="M 295 442 L 295 510"
                    color={C.white} marker="arr-w"
                    label="" dur="2s" delay={0.9}  />

                {/* ⑤ Inter-country on-chain transfer only */}
                <Conn d="M 1180 442 C 1290 458 1290 510 1180 526"
                    color={C.green} marker="arr-g"
                    label="" dur="3.5s" delay={0.7}  />
                <motion.g variants={itemVariants}>
                    {/* ZK badge */}
                    <rect x="1280" y="456" width="170" height="46"
                        fill="rgba(0,0,0,0.75)" stroke={C.green} strokeWidth="1.5" rx="23" />
                    <text x="1365" y="474" fill={C.green} fontFamily="var(--font-mono)"
                        fontSize="9" fontWeight="bold" textAnchor="middle" letterSpacing="0.1em">⑤ INTER-COUNTRY BRIDGE</text>
                    <text x="1365" y="491" fill="rgba(255,255,255,0.5)" fontFamily="var(--font-system)"
                        fontSize="8.5" textAnchor="middle">On-Chain Settlement Only</text>
                </motion.g>

                {/* ── STATE BANK COUNTRY 2 ───────────────────────────── */}
                <Pool x="80" y="510" w="1220" h="430"
                    label="STATE BANK — COUNTRY 2" sublabel="Master Ledger Pool" color={C.green} />

                {/* Annotation: Country 2 */}

                {/* Bank 2 */}
                <SubPool x="110" y="560" w="490" h="350" title="BANK 2" color={C.yellow} />
                <motion.g variants={itemVariants}>
                    <rect x="140" y="598" width="210" height="122" fill="rgba(0,0,0,0.35)" stroke="rgba(234,179,8,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="245" y="616" fill="rgba(254,240,138,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH B2-1 POOL</text>
                    <rect x="360" y="598" width="210" height="122" fill="rgba(0,0,0,0.35)" stroke="rgba(234,179,8,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="465" y="616" fill="rgba(254,240,138,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH B2-2 POOL</text>
                </motion.g>
                {[
                    [220, 655, '1', 'USER NODE'],
                    [380, 655, '2', 'USER NODE'],
                    [220, 790, '3', 'USER NODE'],
                    [380, 790, '4', 'USER NODE'],
                    [300, 722, '5', 'USER NODE'],
                ].map(([nx, ny, lbl, sub], i) => (
                    <Node key={i} x={nx} y={ny} label={lbl} sub={sub} color={C.yellow} />
                ))}

                {/* Bank 1 */}
                <SubPool x="640" y="560" w="555" h="350" title="BANK 1" color={C.green} />
                <motion.g variants={itemVariants}>
                    <rect x="670" y="598" width="240" height="122" fill="rgba(0,0,0,0.35)" stroke="rgba(34,197,94,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="790" y="616" fill="rgba(187,247,208,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH B1-1 POOL</text>
                    <rect x="930" y="598" width="240" height="122" fill="rgba(0,0,0,0.35)" stroke="rgba(34,197,94,0.35)" strokeWidth="1" strokeDasharray="5 3" rx="8" />
                    <text x="1050" y="616" fill="rgba(187,247,208,0.9)" fontFamily="var(--font-mono)" fontSize="9" textAnchor="middle" letterSpacing="0.08em">BRANCH B1-2 POOL</text>
                </motion.g>
                {[
                    [750, 655, 'A', 'USER NODE'],
                    [910, 655, 'B', 'USER NODE'],
                    [1065, 655, 'C', 'USER NODE'],
                    [910, 790, 'D', 'USER NODE'],
                ].map(([nx, ny, lbl, sub], i) => (
                    <Node key={i} x={nx} y={ny} label={lbl} sub={sub} color={C.green} />
                ))}

                {/* ⑥ Direct bank crypto credit flow */}
                <Conn d="M 640 720 L 600 720"
                    color={C.white} dashed marker="arr-w"
                    label="" delay={1.2}  />
                {/* ── TEXT OVERLAY LAYER (always above drawing) ───────── */}
                <motion.g variants={itemVariants}>
                    {/* Legend top-right */}
                    <rect x="20" y="18" width="308" height="134" fill="rgba(3,7,12,0.96)"
                        stroke="rgba(255,255,255,0.24)" strokeWidth="1.2" rx="6" />
                    <text x="36" y="42" fill="#fff" fontFamily="var(--font-mono)"
                        fontSize="11.5" fontWeight="bold" letterSpacing="0.15em"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.4" paintOrder="stroke">LEGEND</text>
                    <line x1="36" y1="57" x2="80" y2="57" stroke={C.white} strokeWidth="1.5" />
                    <text x="92" y="61" fill="rgba(255,255,255,0.95)" fontFamily="var(--font-system)" fontSize="10.6"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.2" paintOrder="stroke">Bank Backend / Ledger Flow</text>
                    <line x1="36" y1="79" x2="80" y2="79" stroke={C.purple} strokeWidth="1.5" strokeDasharray="5 3" />
                    <text x="92" y="83" fill="rgba(255,255,255,0.95)" fontFamily="var(--font-system)" fontSize="10.6"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.2" paintOrder="stroke">Encrypted Sync</text>
                    <line x1="36" y1="101" x2="80" y2="101" stroke={C.green} strokeWidth="1.5" />
                    <text x="92" y="105" fill="rgba(255,255,255,0.95)" fontFamily="var(--font-system)" fontSize="10.6"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.2" paintOrder="stroke">Inter-country On-Chain Transfer</text>
                    <polygon points="58,125 66,120 66,130 58,135 50,130 50,120"
                        fill="rgba(158,164,170,0.12)" stroke={C.cyan} strokeWidth="1.2" />
                    <text x="92" y="128" fill="rgba(255,255,255,0.95)" fontFamily="var(--font-system)" fontSize="10.6"
                        stroke="rgba(0,0,0,0.9)" strokeWidth="2.2" paintOrder="stroke">Account-Holder Note Node</text>
                </motion.g>

                <motion.g variants={itemVariants}>
                    <rect x="1220" y="20" width="230" height="40"
                        fill="rgba(0,0,0,0.65)" stroke="rgba(158,164,170,0.5)"
                        strokeWidth="1.5" rx="4" />
                    <text x="1335" y="45" fill="#fff" fontFamily="var(--font-mono)"
                        fontSize="11.4" fontWeight="bold" textAnchor="middle">ACCOUNT HOLDER</text>
                    <rect x="1220" y="70" width="230" height="92" fill="rgba(0,0,0,0.97)" stroke="rgba(158,164,170,0.6)" strokeWidth="1.3" rx="8" />
                    <text x="1335" y="93" fill="#fff" fontFamily="var(--font-mono)" fontSize="11" textAnchor="middle" letterSpacing="0.06em">ON-CHAIN USER TX</text>
                    <text x="1335" y="117" fill="rgba(255,255,255,0.98)" fontFamily="var(--font-system)" fontSize="10.2" textAnchor="middle">
                        User always signs and submits on-chain.
                    </text>
                    <text x="1335" y="140" fill="rgba(255,255,255,0.98)" fontFamily="var(--font-system)" fontSize="10.2" textAnchor="middle">
                        Bank backend maps it to CREATE2 wallet.
                    </text>
                </motion.g>
                <Annotation x={1220} y={158} w={230} color={C.cyan}
                    lines={['① CREATE2 WALLET MAPPING', 'Deterministic wallet from', 'bank account identifier.']} />
                <Annotation x={1220} y={278} w={230} color={C.purple}
                    lines={['COUNTRY 1 POOL', 'Master ledger', 'ZK sync', 'Regulatory vault']} />
                <Annotation x={430} y={282} w={260} color={C.purple}
                    lines={['② BRANCH TO BANK BACKEND SYNC', 'Branch note pools reconcile into', 'the bank sub-pool ledger.']} />
                <Annotation x={720} y={18} w={360} color={C.white}
                    lines={['③ IN-COUNTRY CENTRALIZED MATCHING', 'Bank/branch ledgers reconcile inside country pool.', 'Account holder path remains on-chain.']} />
                <Annotation x={310} y={410} w={230} color={C.white}
                    lines={['④ COUNTRY MASTER POOL SYNC', 'Internal data moves country to country', 'through controlled backend channels.']} />
                <Annotation x={1240} y={570} w={210} color={C.green}
                    lines={['COUNTRY 2 POOL', 'National master ledger', 'ZK-proof synchronized', 'Cross-border settlement']} />
                <Annotation x={555} y={738} w={350} color={C.yellow}
                    lines={['⑥ DIRECT BANK FIAT TO CRYPTO CREDIT', 'After fiat deposit confirmation, bank backend', 'credits crypto to mapped CREATE2 wallet/note.']} />

                {/* Flow direction hint at bottom */}
                <motion.g variants={itemVariants}>
                    <text x="750" y="955" fill="rgba(255,255,255,0.2)" fontFamily="var(--font-mono)"
                        fontSize="9" textAnchor="middle" letterSpacing="0.15em">
                        COUNTRY MASTER POOL TO BANK SUB-POOLS TO BRANCH SUB-POOLS TO ACCOUNT-HOLDER NOTES (CREATE2 MAPPED)
                    </text>
                </motion.g>

                </g>
            </svg>
        </motion.div>
    );
};

export default BankingFlowChart;
