import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { EPAPER_PUBLIC_URL } from '../config';
import logoImg from '../assets/logo-pro.svg';

const primaryLinks = [
    { name: 'Ecosystem Participants', sectionId: 'investors', oneWordLabel: true },
    { name: 'Who it\'s for', sectionId: 'who-its-for' },
    { name: 'Relayers', sectionId: 'relayers' },
    { name: 'Architecture', sectionId: 'architecture' },
    { name: 'Technology', sectionId: 'technology' },
    { name: 'Tokenomics', sectionId: 'tokenomics' },
    { name: 'Fees', sectionId: 'fees' },
    { name: 'Roadmap', sectionId: 'roadmap' },
    { name: 'Backers & Partners', sectionId: 'backers-partners' },
    { name: 'Blog', to: '/blog' },
    { name: 'Newsletter', sectionId: 'newsletter' },
];

const moreLinks = [
    { name: 'Trade', to: '/trade' },
    { name: 'Privacy & visibility', to: '/privacy-visibility' },
    { name: 'Internal Matching', to: '/trade' },
    { name: 'Relayer (Stake)', to: '/relayer' },
    { name: 'Payroll (Coming Soon)', to: '/enterprise/payroll' },
    { name: 'Governance', to: '/enterprise/governance' },
];

const SECTION_SCROLL_LINE = 132;

const Navbar = () => {
    const [scrolled, setScrolled] = useState(false);
    const [open, setOpen] = useState(false);
    const [activeSection, setActiveSection] = useState('');
    const navigate = useNavigate();
    const location = useLocation();
    const onBlogRoute = location.pathname === '/blog' || location.pathname.startsWith('/blog/');

    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 40);
        window.addEventListener('scroll', onScroll);
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        if (location.pathname !== '/') {
            setActiveSection('');
            return;
        }

        const sectionEntries = primaryLinks
            .filter((l) => l.sectionId)
            .map((l) => ({ id: l.sectionId, el: document.getElementById(l.sectionId) }))
            .filter((x) => x.el)
            .sort((a, b) => a.el.offsetTop - b.el.offsetTop);

        const updateActive = () => {
            let next = '';
            for (const { id, el } of sectionEntries) {
                if (el.getBoundingClientRect().top <= SECTION_SCROLL_LINE) {
                    next = id;
                }
            }
            setActiveSection((prev) => (prev === next ? prev : next));
        };

        updateActive();
        window.addEventListener('scroll', updateActive, { passive: true });
        window.addEventListener('resize', updateActive, { passive: true });
        return () => {
            window.removeEventListener('scroll', updateActive);
            window.removeEventListener('resize', updateActive);
        };
    }, [location.pathname]);

    const scrollToSection = (sectionId) => {
        if (!sectionId) return;
        const target = document.getElementById(sectionId);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    const handleSectionNav = (e, sectionId) => {
        e.preventDefault();
        setOpen(false);

        if (location.pathname === '/') {
            scrollToSection(sectionId);
            return;
        }

        navigate('/');
        let attempts = 0;
        const maxAttempts = 25;
        const tryScroll = () => {
            attempts += 1;
            const target = document.getElementById(sectionId);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (attempts < maxAttempts) {
                window.setTimeout(tryScroll, 40);
            }
        };
        window.setTimeout(tryScroll, 40);
    };

    return (
        <motion.nav
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 200,
                padding: scrolled ? '1rem 0' : '1.75rem 0',
                background: scrolled ? 'var(--color-bg-primary)' : 'rgba(2, 2, 2, 0.9)',
                backdropFilter: scrolled ? 'blur(16px)' : 'blur(12px)',
                WebkitBackdropFilter: scrolled ? 'blur(16px)' : 'blur(12px)',
                borderBottom: scrolled ? '1px solid var(--color-border)' : '1px solid transparent',
                transition: 'all 0.4s ease',
            }}
        >
            <div className="container nav-container">
                {/* Logo */}
                <Link
                    to="/"
                    className="nav-brand"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none', flexShrink: 0 }}
                    onClick={() => {
                        setOpen(false);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                >
                    <img
                        src={logoImg}
                        alt="Phantom Protocol"
                        style={{
                            width: 40,
                            height: 40,
                            objectFit: 'contain',
                            borderRadius: '10px',
                            background: 'rgba(2, 2, 2, 0.85)',
                            padding: '5px',
                            border: '1px solid rgba(136, 196, 255, 0.36)',
                            boxShadow: '0 0 20px rgba(83, 153, 221, 0.28)',
                        }}
                    />
                    <span style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 'var(--nav-brand-size)',
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: '#ffffff',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                    }}>
                        PHANTOM<span style={{ color: 'var(--cyan)' }}>.</span>PROTOCOL
                    </span>
                </Link>

                {/* Desktop links */}
                <div className="nav-links nav-links--primary nav-desktop-only">
                    {primaryLinks.map((link) => (
                        link.to ? (
                            <Link
                                key={link.name}
                                to={link.to}
                                className="hover-underline"
                                style={{
                                    fontFamily: 'var(--font-body)',
                                    fontSize: 'var(--nav-link-size)',
                                    letterSpacing: '0.06em',
                                    textTransform: 'uppercase',
                                    color: onBlogRoute && link.to === '/blog' ? 'var(--color-accent-primary)' : '#ffffff',
                                    fontWeight: onBlogRoute && link.to === '/blog' ? 600 : 500,
                                    textDecoration: 'none',
                                    transition: 'color 0.3s',
                                    whiteSpace: 'nowrap',
                                    flex: '0 0 auto',
                                    textShadow: onBlogRoute && link.to === '/blog' ? '0 0 14px rgba(0, 229, 199, 0.35)' : 'none',
                                }}
                                onMouseEnter={(e) => { e.target.style.color = 'var(--color-accent-primary)'; }}
                                onMouseLeave={(e) => {
                                    e.target.style.color = onBlogRoute && link.to === '/blog' ? 'var(--color-accent-primary)' : '#ffffff';
                                }}
                            >
                                {link.name}
                            </Link>
                        ) : (
                            <a
                                key={link.sectionId}
                                href={`#${link.sectionId}`}
                                className={`hover-underline${link.oneWordLabel ? ' nav-link--oneword' : ''}`}
                                style={{
                                    fontFamily: 'var(--font-body)',
                                    fontSize: 'var(--nav-link-size)',
                                    letterSpacing: link.oneWordLabel ? '0.02em' : '0.06em',
                                    textTransform: link.oneWordLabel ? 'none' : 'uppercase',
                                    color: activeSection === link.sectionId ? 'var(--color-accent-primary)' : 'var(--color-text-primary)',
                                    fontWeight: activeSection === link.sectionId ? 600 : 500,
                                    textDecoration: 'none',
                                    transition: 'color 0.25s ease, text-shadow 0.25s ease',
                                    whiteSpace: 'nowrap',
                                    flex: '0 0 auto',
                                    textShadow: activeSection === link.sectionId ? '0 0 14px rgba(0, 229, 199, 0.35)' : 'none',
                                }}
                                onClick={(e) => handleSectionNav(e, link.sectionId)}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.color = 'var(--color-accent-primary)';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.color = activeSection === link.sectionId ? 'var(--color-accent-primary)' : 'var(--color-text-primary)';
                                }}
                            >
                                {link.name}
                            </a>
                        )
                    ))}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }} className="nav-cta">
                    <button
                        type="button"
                        className="nav-desktop-only"
                        onClick={() => setOpen(!open)}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.45rem',
                            background: 'var(--color-accent-glow)',
                            border: '1px solid var(--color-accent-primary)',
                            color: 'var(--color-text-primary)',
                            fontFamily: 'var(--font-body)',
                            fontSize: 'var(--btn-text-size)',
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            padding: 'clamp(0.5rem, 1.2vw, 0.6rem) clamp(0.85rem, 1.8vw, 1rem)',
                            cursor: 'pointer',
                        }}
                    >
                        More
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '3px' }}>
                            <span style={{ display: 'block', width: 12, height: 1, background: '#fff' }} />
                            <span style={{ display: 'block', width: 12, height: 1, background: '#fff' }} />
                            <span style={{ display: 'block', width: 12, height: 1, background: '#fff' }} />
                        </span>
                    </button>
                    <a
                        href={EPAPER_PUBLIC_URL}
                        className="btn-outline nav-desktop-only"
                        style={{ fontSize: 'var(--btn-text-size)', padding: 'clamp(0.5rem, 1.2vw, 0.6rem) clamp(0.9rem, 2vw, 1.2rem)', color: 'var(--color-text-primary)', borderColor: 'var(--color-border)' }}
                    >
                        Read E-Paper
                    </a>
                    <button
                        type="button"
                        style={{
                            display: 'none',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: '#fff',
                            padding: '0.5rem',
                        }}
                        className="nav-mobile-only"
                        onClick={() => setOpen(!open)}
                    >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                            <span style={{ display: 'block', width: 22, height: 1, background: 'var(--color-text-primary)', transition: 'transform 0.3s', transform: open ? 'translateY(6px) rotate(45deg)' : 'none' }} />
                            <span style={{ display: 'block', width: 22, height: 1, background: 'var(--color-text-primary)', opacity: open ? 0 : 1, transition: 'opacity 0.3s' }} />
                            <span style={{ display: 'block', width: 22, height: 1, background: 'var(--color-text-primary)', transition: 'transform 0.3s', transform: open ? 'translateY(-6px) rotate(-45deg)' : 'none' }} />
                        </div>
                    </button>
                </div>
            </div>

            {/* Mobile Menu */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        style={{
                            background: 'var(--color-bg-primary)',
                            borderTop: '1px solid var(--color-border)',
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            className="container nav-drawer-inner"
                            style={{
                                paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
                                paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1.25rem',
                                maxHeight: 'min(78vh, 100dvh - 5rem)',
                                overflowY: 'auto',
                                WebkitOverflowScrolling: 'touch',
                            }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {primaryLinks.map((link) => (
                                    link.to ? (
                                        <Link
                                            key={link.name}
                                            to={link.to}
                                            onClick={() => setOpen(false)}
                                            style={{
                                                fontFamily: 'var(--font-body)',
                                                fontSize: 'var(--nav-drawer-size)',
                                                letterSpacing: '0.07em',
                                                textTransform: 'uppercase',
                                                color: link.to === '/blog' && onBlogRoute ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                                                fontWeight: link.to === '/blog' && onBlogRoute ? 600 : 500,
                                                textDecoration: 'none',
                                                lineHeight: 1.35,
                                            }}
                                        >
                                            {link.name}
                                        </Link>
                                    ) : (
                                        <a
                                            key={link.sectionId}
                                            href={`#${link.sectionId}`}
                                            onClick={(e) => handleSectionNav(e, link.sectionId)}
                                            style={{
                                                fontFamily: 'var(--font-body)',
                                                fontSize: 'var(--nav-drawer-size)',
                                                letterSpacing: link.oneWordLabel ? '0.03em' : '0.07em',
                                                textTransform: link.oneWordLabel ? 'none' : 'uppercase',
                                                color: location.pathname === '/' && activeSection === link.sectionId ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                                                fontWeight: location.pathname === '/' && activeSection === link.sectionId ? 600 : 500,
                                                textDecoration: 'none',
                                                lineHeight: 1.35,
                                            }}
                                        >
                                            {link.name}
                                        </a>
                                    )
                                ))}
                            </div>
                            <div style={{ height: 1, background: 'var(--color-border)', margin: '0.15rem 0' }} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {moreLinks.map((link) => (
                                    link.to ? (
                                        <Link
                                            key={link.name}
                                            to={link.to}
                                            onClick={() => setOpen(false)}
                                            style={{
                                                fontFamily: 'var(--font-body)',
                                                fontSize: 'var(--nav-drawer-size)',
                                                letterSpacing: '0.07em',
                                                textTransform: 'uppercase',
                                                color: 'rgba(255, 255, 255, 0.95)',
                                                fontWeight: 500,
                                                textDecoration: 'none',
                                                lineHeight: 1.35,
                                            }}
                                        >
                                            {link.name}
                                        </Link>
                                    ) : (
                                        <a
                                            key={link.name}
                                            href={`#${link.sectionId}`}
                                            onClick={(e) => handleSectionNav(e, link.sectionId)}
                                            style={{
                                                fontFamily: 'var(--font-body)',
                                                fontSize: 'var(--nav-drawer-size)',
                                                letterSpacing: '0.07em',
                                                textTransform: 'uppercase',
                                                color: 'rgba(255, 255, 255, 0.95)',
                                                fontWeight: 500,
                                                textDecoration: 'none',
                                                lineHeight: 1.35,
                                            }}
                                        >
                                            {link.name}
                                        </a>
                                    )
                                ))}
                            </div>
                            <a
                                href={EPAPER_PUBLIC_URL}
                                onClick={() => setOpen(false)}
                                style={{
                                    fontFamily: 'var(--font-body)',
                                    fontSize: 'var(--nav-drawer-size)',
                                    letterSpacing: '0.07em',
                                    textTransform: 'uppercase',
                                    color: 'var(--color-accent-primary)',
                                    fontWeight: 600,
                                    textDecoration: 'none',
                                    lineHeight: 1.35,
                                    marginTop: '0.25rem',
                                }}
                            >
                                Read E-Paper
                            </a>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <style>{`
        .nav-container {
          overflow: visible;
          align-items: center;
          display: flex;
          flex-wrap: nowrap;
          justify-content: space-between;
          gap: 1rem;
        }
        .nav-links--primary {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1 1 auto;
          min-width: 0;
          max-width: 100%;
          flex-wrap: wrap;
          row-gap: 0.3rem;
          column-gap: clamp(0.4rem, 0.9vw, 0.72rem);
          padding-left: 0.2rem;
          padding-right: 0.2rem;
        }
        @media (min-width: 1200px) and (max-width: 1439px) {
          .nav-links--primary {
            column-gap: clamp(0.35rem, 0.65vw, 0.55rem);
            row-gap: 0.25rem;
          }
          .nav-links--primary a:not(.nav-link--oneword) { letter-spacing: 0.06em !important; }
        }
        @media (min-width: 1440px) {
          .nav-links--primary {
            flex-wrap: nowrap;
            column-gap: clamp(0.5rem, 1vw, 0.8rem);
          }
        }
        .nav-links--primary a { overflow: visible; }
        @media (max-width: 1199px) {
          .nav-desktop-only { display: none !important; }
          .nav-mobile-only { display: flex !important; align-items: center; justify-content: center; }
        }
        @media (min-width: 1200px) {
          .nav-mobile-only { display: none !important; }
        }
      `}</style>
        </motion.nav>
    );
};

export default Navbar;
