import React, { useMemo, useEffect, useState, useRef } from 'react';
import { motion, useReducedMotion, useScroll, useSpring } from 'framer-motion';
import whitepaperContent from '../data/whitepaper.txt?raw';
import SeoHead from './SeoHead';
import Navbar from './Navbar';
import { useLocation } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { MasterPhantomDiagram, CommitmentFormulaDiagram, NullifierFormulaDiagram, RelayerSystemDiagram } from './WhitepaperDiagrams';
import BankingFlowChart from './BankingFlowChart';

const parseTextToBlocks = (text) => {
    const rawLines = text.split(/\r?\n/);
    const blocks = [];
    let currentParagraph = [];

    const pushParagraph = () => {
        if (currentParagraph.length > 0) {
            blocks.push({ type: 'p', content: currentParagraph.join(' ').replace(/(\*\*|\*|__|_|`)/g, '') });
            currentParagraph = [];
        }
    };

    for (let i = 0; i < rawLines.length; i++) {
        let line = rawLines[i].replace(/^\uFEFF/, '').trim();
        if (!line) {
            pushParagraph();
            continue;
        }

        const numberedItemMatch = line.match(/^(\d+)\.\s+(.+)$/);
        const prevLine = (rawLines[i - 1] || '').replace(/^\uFEFF/, '').trim();
        const nextLine = (rawLines[i + 1] || '').replace(/^\uFEFF/, '').trim();
        const prevNumMatch = prevLine.match(/^(\d+)\.\s+(.+)$/);
        const nextNumMatch = nextLine.match(/^(\d+)\.\s+(.+)$/);
        const isSequentialNumberedItem = Boolean(
            numberedItemMatch &&
            (
                (prevNumMatch && Number(prevNumMatch[1]) === Number(numberedItemMatch[1]) - 1) ||
                (nextNumMatch && Number(nextNumMatch[1]) === Number(numberedItemMatch[1]) + 1)
            )
        );

        const isMainHeading = /^\d+\.\s+[A-Z]/.test(line) || /^Conclusion/i.test(line) || /^Phantom\s+\d+\.\d+$/i.test(line);
        const isSubHeading = /^\d+\.\d+\s+/.test(line);
        const isSubSubHeading = /^\d+\.\d+\.\d+\s+/.test(line);

        const isTitle = line === "Phantom Protocol E-Paper";
        const isSubtitle = line === "Privacy by Proof. Invisible by Design.";

        if (isTitle) {
            pushParagraph();
            blocks.push({ type: 'h1', content: line, id: 'title' });
        } else if (isSubtitle) {
            pushParagraph();
            blocks.push({ type: 'subtitle', content: line });
        } else if (isSequentialNumberedItem) {
            pushParagraph();
            blocks.push({ type: 'li', content: line });
        } else if (isMainHeading) {
            pushParagraph();
            blocks.push({ type: 'h2', content: line, id: line.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() });
        } else if (isSubHeading) {
            pushParagraph();
            blocks.push({ type: 'h3', content: line, id: line.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() });
        } else if (isSubSubHeading) {
            pushParagraph();
            blocks.push({ type: 'h4', content: line, id: line.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() });
        } else if (line.startsWith('* ') || line.startsWith('- ')) {
            pushParagraph();
            blocks.push({ type: 'li', content: line.replace(/^[-*]\s/, '') });
        } else {
            currentParagraph.push(line);
        }
    }
    pushParagraph();

    return blocks;
};

const HighTechBlock = ({ block, idx, enableDiagrams, isMobile }) => {
    switch (block.type) {
        case 'h1':
            return (
                <motion.div initial={{ opacity: 0, y: 30 }} whileInView={isMobile ? undefined : { opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.8 }} key={idx} id={block.id} className="whitepaper-title-block" style={{ marginBottom: 'clamp(1.5rem, 5vw, 3rem)', position: 'relative', opacity: isMobile ? 1 : undefined, transform: isMobile ? 'none' : undefined }}>
                    <h1 className="whitepaper-h1" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--whitepaper-h1)', color: '#fff', letterSpacing: '-0.02em', lineHeight: 1.08, textShadow: '0 0 40px rgba(158, 164, 170, 0.4)', scrollMarginTop: 'var(--whitepaper-scroll-margin)', overflowWrap: 'anywhere', maxWidth: '100%' }}>
                        {block.content}
                    </h1>
                    <div style={{ height: '1px', width: '100%', background: 'linear-gradient(90deg, var(--cyan) 0%, transparent 100%)', marginTop: 'clamp(1rem, 3vw, 2rem)', opacity: 0.5 }} />
                </motion.div>
            );
        case 'h2':
            return (
                <React.Fragment key={idx}>
                    <motion.div initial={{ opacity: 0, x: -20 }} whileInView={isMobile ? undefined : { opacity: 1, x: 0 }} viewport={{ once: true, margin: '-10%' }} transition={{ duration: 0.5 }} className="whitepaper-h2-wrap" style={{ marginBottom: 'clamp(1.25rem, 4vw, 2.5rem)', position: 'relative', paddingLeft: 'clamp(0.65rem, 2vw, 1.5rem)', opacity: isMobile ? 1 : undefined, transform: isMobile ? 'none' : undefined }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '2px', background: 'var(--cyan)', boxShadow: '0 0 10px var(--cyan)' }} />
                        <h2 id={block.id} className="whitepaper-h2" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--whitepaper-h2)', color: '#fff', display: 'flex', alignItems: 'center', gap: '1rem', scrollMarginTop: 'var(--whitepaper-scroll-margin)', lineHeight: 1.15, wordBreak: 'break-word', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap' }}>
                            {block.content}
                        </h2>
                    </motion.div>
                    {enableDiagrams && block.content.includes('Phantom 3.0') && <BankingFlowChart />}
                </React.Fragment>
            );
        case 'h3':
            return (
                <React.Fragment key={idx}>
                    <motion.h3 initial={{ opacity: 0 }} whileInView={isMobile ? undefined : { opacity: 1 }} viewport={{ once: true }} id={block.id} className="whitepaper-h3" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--whitepaper-h3)', color: 'rgba(255,255,255,0.95)', marginTop: 'clamp(2rem, 6vw, 4rem)', marginBottom: 'clamp(0.85rem, 2vw, 1.5rem)', display: 'flex', alignItems: 'center', gap: '0.75rem', scrollMarginTop: 'var(--whitepaper-scroll-margin)', lineHeight: 1.2, wordBreak: 'break-word', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap', opacity: isMobile ? 1 : undefined }}>
                        {block.content}
                    </motion.h3>
                    {enableDiagrams && block.content.includes('Core Model and Architecture') && <MasterPhantomDiagram />}
                    {enableDiagrams && block.content.includes('Key management') && <CommitmentFormulaDiagram />}
                    {enableDiagrams && block.content.includes('Operational safeguards') && <NullifierFormulaDiagram />}
                </React.Fragment>
            );
        case 'h4':
            return (
                <h4 key={idx} id={block.id} className="whitepaper-h4" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--whitepaper-h4)', color: 'var(--cyan)', marginTop: 'clamp(1.75rem, 5vw, 3rem)', marginBottom: 'clamp(0.65rem, 2vw, 1rem)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', lineHeight: 1.35, wordBreak: 'break-word', scrollMarginTop: 'var(--whitepaper-scroll-margin)' }}>
                    {block.content}
                </h4>
            );
        case 'subtitle':
            return (
                <motion.p
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={isMobile ? undefined : { opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    key={idx}
                    className="whitepaper-subtitle"
                    style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 'var(--whitepaper-subtitle)',
                        color: 'rgba(255,255,255,0.9)',
                        marginBottom: 'clamp(1.25rem, 4vw, 2rem)',
                        letterSpacing: '0.01em',
                        lineHeight: 1.55,
                        opacity: isMobile ? 1 : undefined,
                        transform: isMobile ? 'none' : undefined,
                    }}
                >
                    {block.content}
                </motion.p>
            );
        case 'li':
            return (
                <motion.div initial={{ opacity: 0, x: 10 }} whileInView={isMobile ? undefined : { opacity: 1, x: 0 }} viewport={{ once: true }} key={idx} style={{ marginBottom: 'clamp(0.65rem, 2vw, 1rem)', paddingLeft: 'clamp(0.5rem, 2vw, 1rem)', opacity: isMobile ? 1 : undefined, transform: isMobile ? 'none' : undefined }}>
                    <li className="whitepaper-li" style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--whitepaper-body)', color: 'rgba(255,255,255,0.75)', lineHeight: 1.65, listStyleType: 'none', wordBreak: 'break-word' }}>{block.content}</li>
                </motion.div>
            );
        case 'p':
        default:
            if (block.content.trim() === 'Add Diagram') {
                return (
                    <motion.div initial={{ opacity: 0, y: 20 }} whileInView={isMobile ? undefined : { opacity: 1, y: 0 }} viewport={{ once: true }} key={idx} style={{ opacity: isMobile ? 1 : undefined, transform: isMobile ? 'none' : undefined }}>
                        {enableDiagrams ? <RelayerSystemDiagram /> : null}
                    </motion.div>
                );
            }
            return (
                <motion.p initial={{ opacity: 0, y: 10 }} whileInView={isMobile ? undefined : { opacity: 1, y: 0 }} viewport={{ once: true }} key={idx} className="tech-paragraph whitepaper-p" style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--whitepaper-body)', color: 'rgba(255,255,255,0.85)', marginBottom: 'clamp(1rem, 3vw, 1.5rem)', lineHeight: 1.72, wordBreak: 'break-word', opacity: isMobile ? 1 : undefined, transform: isMobile ? 'none' : undefined }}>
                    {block.content}
                </motion.p>
            );
    }
};

export default function WhitepaperPage() {
    const blocks = useMemo(() => parseTextToBlocks(whitepaperContent), []);
    const outline = useMemo(
        () => blocks.filter((block) => block.type === 'h2' || block.type === 'h3'),
        [blocks]
    );
    const location = useLocation();
    const [activeSection, setActiveSection] = useState('');
    const mobileTocRef = useRef(null);
    const reducedMotion = useReducedMotion();
    const [isMobile, setIsMobile] = useState(() => {
        if (typeof window === 'undefined') return false;
        return window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth <= 900;
    });
    const [enableDiagrams, setEnableDiagrams] = useState(() => {
        if (typeof window === 'undefined') return true;
        const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
        const narrow = window.innerWidth <= 900;
        return !(coarse || narrow);
    });

    const { scrollYProgress } = useScroll();
    const scaleX = useSpring(scrollYProgress, {
        stiffness: 100,
        damping: 30,
        restDelta: 0.001
    });

    useEffect(() => {
        window.scrollTo(0, 0);
    }, [location.pathname]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;

        let headings = Array.from(document.querySelectorAll('h2, h3'));
        let raf = 0;

        const update = () => {
            const line = Math.min(160, Math.max(110, window.innerWidth * 0.12 + 88));
            let current = '';
            for (const heading of headings) {
                if (heading.getBoundingClientRect().top < line) current = heading.id;
            }
            if (current) setActiveSection((prev) => (prev === current ? prev : current));
        };

        const onScroll = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(() => {
                raf = 0;
                update();
            });
        };

        const onResize = () => {
            headings = Array.from(document.querySelectorAll('h2, h3'));
            const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
            const narrow = window.innerWidth <= 900;
            const nextIsMobile = coarse || narrow;
            setIsMobile(nextIsMobile);
            setEnableDiagrams(!(coarse || narrow));
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onResize, { passive: true });
        update();
        return () => {
            if (raf) window.cancelAnimationFrame(raf);
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
        };
    }, []);

    const closeMobileToc = () => {
        const el = mobileTocRef.current;
        if (el) el.open = false;
    };

    return (
        <>
            <Navbar />
            <main className="whitepaper-page" style={{ position: 'relative', width: '100%', maxWidth: '100%', minWidth: 0, minHeight: '100vh', paddingBottom: 'max(4rem, env(safe-area-inset-bottom, 0px) + 3rem)' }}>
                <SeoHead
                    title="Phantom Protocol E-Paper | Phantom Protocol"
                    description="Phantom Protocol specifies a shielded pool with commitments, nullifiers, Merkle membership, and Groth16-verified join-split transitions."
                    path="/e-paper"
                />

                <motion.div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: '3px', background: 'var(--cyan)', transformOrigin: '0%', scaleX: (reducedMotion || isMobile) ? 1 : scaleX, zIndex: 199, boxShadow: '0 0 15px var(--cyan)' }} />

                <div className="container whitepaper-page-inner">
                    {(isMobile || reducedMotion) && (
                        <div style={{ marginBottom: 'clamp(1rem, 3vw, 1.75rem)' }}>
                            <div
                                className="card"
                                style={{
                                    padding: '0.95rem 1rem',
                                    background: 'rgba(2, 2, 2, 0.72)',
                                    borderColor: 'rgba(138, 196, 255, 0.26)',
                                }}
                            >
                                <div className="mono" style={{ color: 'var(--cyan)', marginBottom: '0.35rem' }}>Mobile safe mode</div>
                                <p style={{ margin: 0, color: 'rgba(214, 234, 255, 0.85)', lineHeight: 1.55, fontSize: 'clamp(0.85rem, 2.7vw, 0.95rem)' }}>
                                    Heavy animated diagrams are disabled to prevent mobile browser crashes. You can still read the full document.
                                </p>
                                {!enableDiagrams && (
                                    <button
                                        type="button"
                                        className="btn-outline btn-outline-cyan"
                                        style={{ marginTop: '0.75rem' }}
                                        onClick={() => setEnableDiagrams(true)}
                                    >
                                        Load diagrams anyway
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="whitepaper-spec-badge" style={{ fontFamily: 'var(--font-mono)', fontSize: 'clamp(0.5rem, 1.2vw, 0.6rem)', color: 'rgba(255,255,255,0.3)', textAlign: 'right', letterSpacing: '0.2em', lineHeight: 1.5, pointerEvents: 'none' }}>
                        SPEC-DOC: PHANTOM-PROT-EP-V1<br />
                        ENCRYPTION: ENABLED<br />
                        STATUS: SECURE_SYNC
                    </div>

                    <p className="whitepaper-spec-inline" aria-hidden="true">
                        SPEC-DOC: PHANTOM-PROT-EP-V1 · ENCRYPTION: ENABLED · STATUS: SECURE_SYNC
                    </p>

                    <details ref={mobileTocRef} className="whitepaper-mobile-toc">
                        <summary className="whitepaper-mobile-toc__summary">Contents</summary>
                        <nav className="whitepaper-mobile-toc__nav" aria-label="E-Paper sections">
                            <ul>
                                {outline.map((item, idx) => (
                                    <li key={`m-${item.id}-${idx}`} className={item.type === 'h3' ? 'whitepaper-mobile-toc__sub' : ''}>
                                        <a
                                            href={`#${item.id}`}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                                closeMobileToc();
                                            }}
                                        >
                                            {item.content}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </nav>
                    </details>

                    <div style={{ display: 'grid', gap: 'clamp(2rem, 6vw, 5rem)' }} className="whitepaper-grid">
                    <aside className="whitepaper-sidebar">
                        <div style={{ position: 'sticky', top: '8rem', maxHeight: 'calc(100vh - 10rem)', overflowY: 'auto', paddingRight: '1rem', paddingBottom: '2rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '2rem' }}>
                                <Shield size={16} color="var(--cyan)" />
                                <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--cyan)', textTransform: 'uppercase', letterSpacing: '0.15em', margin: 0 }}>Index Navigation</h3>
                            </div>
                            <div style={{ position: 'relative', paddingLeft: '1rem', borderLeft: '1px solid rgba(255,255,255,0.1)' }}>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {outline.map((item, idx) => {
                                        const isActive = activeSection === item.id;
                                        return (
                                            <li
                                                key={`${item.id}-${idx}`}
                                                style={{
                                                    paddingLeft: item.type === 'h3' ? '1rem' : '0',
                                                    position: 'relative',
                                                }}
                                            >
                                                {isActive && (
                                                    <motion.div layoutId="activeNav" style={{ position: 'absolute', left: item.type === 'h3' ? '-1.8rem' : '-1.3rem', top: '50%', width: '4px', height: '4px', borderRadius: '50%', background: 'var(--cyan)', boxShadow: '0 0 10px var(--cyan)', transform: 'translateY(-50%)' }} />
                                                )}
                                                <a
                                                    href={`#${item.id}`}
                                                    style={{
                                                        color: isActive ? 'var(--cyan)' : (item.type === 'h2' ? '#fff' : 'rgba(255,255,255,0.4)'),
                                                        textDecoration: 'none',
                                                        fontSize: item.type === 'h2' ? '0.85rem' : '0.75rem',
                                                        fontFamily: item.type === 'h2' ? 'var(--font-display)' : 'var(--font-body)',
                                                        transition: 'all 0.3s ease',
                                                        lineHeight: 1.4,
                                                        display: 'block',
                                                        textShadow: isActive ? '0 0 10px rgba(158, 164, 170, 0.4)' : 'none',
                                                    }}
                                                    onMouseOver={(e) => { e.target.style.color = 'var(--cyan)'; }}
                                                    onMouseOut={(e) => { e.target.style.color = isActive ? 'var(--cyan)' : (item.type === 'h2' ? '#fff' : 'rgba(255,255,255,0.4)'); }}
                                                >
                                                    {item.content}
                                                </a>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </aside>
                    <article className="whitepaper-content" style={{ flex: 1, minWidth: 0 }}>
                        {blocks.map((block, idx) => (
                            <HighTechBlock
                                key={idx}
                                block={block}
                                idx={idx}
                                enableDiagrams={enableDiagrams && !reducedMotion}
                                isMobile={isMobile}
                            />
                        ))}
                    </article>
                </div>
            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
        .whitepaper-page {
          overflow-x: clip;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .whitepaper-page-inner {
          position: relative;
          z-index: 10;
          padding-top: max(6.25rem, env(safe-area-inset-top, 0px) + 5.35rem);
          width: 100%;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .whitepaper-grid {
          grid-template-columns: minmax(0, 1fr);
          width: 100%;
          max-width: 100%;
          min-width: 0;
        }
        .whitepaper-page .whitepaper-page-inner.container {
          --wp-pl: max(env(safe-area-inset-left, 0px), var(--pad));
          --wp-pr: max(env(safe-area-inset-right, 0px), var(--pad));
          padding-left: var(--wp-pl);
          padding-right: var(--wp-pr);
          box-sizing: border-box;
        }
        @media (max-width: 1099px) {
          .whitepaper-page .whitepaper-page-inner.container {
            --wp-pl: max(env(safe-area-inset-left, 0px), clamp(1.35rem, 7vw, 2.25rem));
            --wp-pr: max(env(safe-area-inset-right, 0px), clamp(1.35rem, 7vw, 2.25rem));
            padding-left: var(--wp-pl);
            padding-right: var(--wp-pr);
          }
        }
        @media (min-width: 1200px) {
          .whitepaper-page-inner {
            padding-top: max(6rem, env(safe-area-inset-top, 0px) + 5.1rem);
          }
        }
        .whitepaper-spec-badge {
          position: absolute;
          right: var(--pad);
          top: max(5rem, env(safe-area-inset-top, 0px) + 4.1rem);
        }
        @media (min-width: 1100px) {
          .whitepaper-spec-badge {
            top: max(4.75rem, env(safe-area-inset-top, 0px) + 3.85rem);
          }
        }
        .whitepaper-title-block {
          max-width: 100%;
        }
        .whitepaper-h2-wrap {
          margin-top: clamp(2.25rem, 10vw, 6rem);
          max-width: 100%;
        }
        .whitepaper-content {
          overflow-x: clip;
          word-break: break-word;
          overflow-wrap: break-word;
          min-width: 0;
          width: 100%;
          max-width: 100%;
        }
        .whitepaper-spec-inline {
          display: none;
          margin: 0 0 0.85rem 0;
          font-family: var(--font-mono);
          font-size: clamp(0.5rem, 2.6vw, 0.65rem);
          color: rgba(255,255,255,0.38);
          letter-spacing: 0.1em;
          line-height: 1.55;
          text-transform: uppercase;
          overflow-wrap: anywhere;
        }
        @media (max-width: 1099px) {
          .whitepaper-spec-inline { display: block; }
        }
        .whitepaper-mobile-toc {
          display: none;
          margin-bottom: clamp(1rem, 3vw, 1.75rem);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          background: rgba(255,255,255,0.03);
          overflow: hidden;
        }
        .whitepaper-mobile-toc__summary {
          list-style: none;
          cursor: pointer;
          font-family: var(--font-mono);
          font-size: var(--label-size);
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--cyan);
          padding: 0.85rem 1rem;
          font-weight: 600;
        }
        .whitepaper-mobile-toc__summary::-webkit-details-marker { display: none; }
        .whitepaper-mobile-toc__nav {
          border-top: 1px solid rgba(255,255,255,0.08);
          padding: 0.65rem 0.85rem 1rem;
          max-height: min(50vh, 420px);
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }
        .whitepaper-mobile-toc__nav ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }
        .whitepaper-mobile-toc__nav a {
          color: rgba(255,255,255,0.88);
          text-decoration: none;
          font-size: clamp(0.8rem, 2.8vw, 0.9rem);
          line-height: 1.35;
          display: block;
        }
        .whitepaper-mobile-toc__nav a:active { color: var(--cyan); }
        .whitepaper-mobile-toc__sub { padding-left: 0.85rem; }
        .whitepaper-mobile-toc__sub a {
          color: rgba(255,255,255,0.65);
          font-size: clamp(0.75rem, 2.5vw, 0.82rem);
        }
        @media (max-width: 1099px) {
          .whitepaper-mobile-toc { display: block; }
          .whitepaper-spec-badge { display: none; }
          .whitepaper-h2-wrap {
            padding-right: 0.35rem;
          }
        }
        @media (max-width: 560px) {
          .whitepaper-spec-badge { display: none; }
        }
        @media (min-width: 1100px) {
          .whitepaper-grid {
            grid-template-columns: 240px minmax(0, 1fr) !important;
          }
        }
        @media (max-width: 1099px) {
          .whitepaper-sidebar {
            display: none;
          }
        }
        .whitepaper-sidebar div::-webkit-scrollbar {
          width: 2px;
        }
        .whitepaper-sidebar div::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.02);
        }
        .whitepaper-sidebar div::-webkit-scrollbar-thumb {
          background: var(--cyan);
        }
        .tech-paragraph {
            transition: color 0.3s ease;
        }
        .tech-paragraph:hover {
            color: #fff;
        }
        @media (hover: none) {
          .tech-paragraph:hover { color: rgba(255,255,255,0.85); }
        }
      `}} />
            </main>
        </>
    );
}
