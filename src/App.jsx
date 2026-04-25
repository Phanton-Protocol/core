import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, useLocation, Link, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import WhoCanUseIt from './components/WhoCanUseIt';
import Benefits from './components/Benefits';
import ComparisonTable from './components/ComparisonTable';
import TechCards from './components/TechCards';
import TokenomicsSection from './components/TokenomicsSection';
import SDKSection from './components/SDKSection';
import MetricsVisualizer from './components/MetricsVisualizer';
import NewsSection from './components/NewsSection';
import NewsletterSection from './components/NewsletterSection';
import BackersPartnersSection from './components/BackersPartnersSection';
import Mechanics from './components/Mechanics';
import RelayersSection from './components/RelayersSection';
import PrivacyExplainer from './components/PrivacyExplainer';
import FeesSection from './components/FeesSection';
import Roadmap from './components/Roadmap';
import FAQ from './components/FAQ';
import InvestorSection from './components/InvestorSection';
import SeoHead from './components/SeoHead';
import SeoContentPage from './components/SeoContentPage';
import BlogIndexPage from './components/BlogIndexPage';
import BlogArticlePage from './components/BlogArticlePage';
import WhitepaperPage from './components/WhitepaperPage';
import OnePagerPage from './components/OnePagerPage';
import PrivacyVisibilityPage from './components/PrivacyVisibilityPage';
import PitchDeckPage from './components/PitchDeckPage';
import BankingSystemPage from './components/BankingSystemPage';
import { blogPosts } from './data/blogPosts';
import logoUrl from './assets/logo-pro.svg';
import { API_URL, SOCIAL_LINKS, RUNBOOK_URL } from './config';
import { HOME_SCROLL_SECTION_IDS } from './seo/homeScrollSections';
import GhostChainVisualizer from './components/GhostChainVisualizer';
import DataInterceptionBackground from './components/DataInterceptionBackground';

const DAppSection = lazy(() => import('./components/DAppSection'));
const ProtocolUserDapp = lazy(() => import('./components/ProtocolUserDapp'));
const AppPageShell = lazy(() => import('./components/AppPageShell'));
const PayrollPage = lazy(() => import('./components/enterprise/PayrollPage'));
const CompliancePage = lazy(() => import('./components/enterprise/CompliancePage'));
const GovernancePage = lazy(() => import('./components/enterprise/GovernancePage'));
const AuditPage = lazy(() => import('./components/enterprise/AuditPage'));
const EnterpriseHomePage = lazy(() => import('./components/enterprise/EnterpriseHomePage'));
const EnterpriseLayout = lazy(() => import('./components/enterprise/EnterpriseLayout'));

function RouteLoader() {
  return <div className="container section" style={{ paddingTop: '8rem', color: 'rgba(202, 225, 250, 0.82)' }}>Loading...</div>;
}

function UserDappPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <SeoHead
        title="Phantom User Console | Shielded Deposit, Swap, Withdraw"
        description="Use the Phantom Protocol user console for private pool operations, shielded swaps, and withdrawals on BNB Chain."
        path="/user"
      />
      <Navbar />
      <Suspense fallback={<RouteLoader />}>
        <AppPageShell
          label="Protocol console"
          title="User console"
          subtitle="Deposit to the shielded pool, swap with relayer-submitted transactions, and withdraw. Connect MetaMask on the same chain as the relayer."
          maxWidth={800}
        >
          <ProtocolUserDapp />
          <div style={{ marginTop: '2.5rem' }}>
            <DAppSection embedded />
          </div>
        </AppPageShell>
      </Suspense>
    </div>
  );
}

function TradePage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <SeoHead
        title="Phantom Trade Console | Shielded Deposit, Swap, Withdraw"
        description="Use the Phantom trade console for shielded deposits, private swaps, and withdrawals on BNB Chain."
        path="/trade"
      />
      <Navbar />
      <Suspense fallback={<RouteLoader />}>
        <AppPageShell
          label="Trade console"
          title="Trade"
          subtitle="Deposit to the shielded pool, swap privately, and withdraw from one console."
        >
          <ProtocolUserDapp uiVariant="trade" />
        </AppPageShell>
      </Suspense>
    </div>
  );
}

function RelayerStakerPage() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('phantom_api') || API_URL);
  const [health, setHealth] = useState(null);
  const [stakingStats, setStakingStats] = useState(null);
  const [relayerStatus, setRelayerStatus] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const isLocalEnv = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);

  useEffect(() => {
    localStorage.setItem('phantom_api', apiBase);
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoadErr('');
      try {
        const base = String(apiBase || '').replace(/\/$/, '');
        const [h, stats, status] = await Promise.all([
          fetch(`${base}/health`).then((r) => r.json()),
          fetch(`${base}/staking/stats`).then((r) => r.json()),
          fetch(`${base}/relayer/staking-status`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setHealth(h);
        setStakingStats(stats);
        setRelayerStatus(status);
      } catch (e) {
        if (!cancelled) setLoadErr(e?.message || 'Could not load relayer status');
      }
    }
    run();
    const timer = window.setInterval(run, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiBase]);

  return (
    <div style={{ minHeight: '100vh' }}>
      <SeoHead
        title="Become a Phantom Relayer | Staking and Node Participation"
        description="Stake protocol tokens, run a relayer node, and claim distributed rewards in the Phantom relayer network."
        path="/relayer"
      />
      <Navbar />
      <section className="section" style={{ paddingTop: '7rem' }}>
        <div className="container" style={{ maxWidth: 900 }}>
          <div className="section-label">Relayers / stakers</div>
          <h1 className="display-lg" style={{ marginBottom: '0.85rem' }}>
            Become a <em>relayer node.</em>
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.78)', maxWidth: 760, lineHeight: 1.65 }}>
            Stake protocol tokens, run a relayer locally, join the active node set, and claim distributed profits based on network activity.
            This page is focused only on relayer participation and rewards.
          </p>

          <div style={{ marginTop: '1.25rem', display: 'grid', gap: '1rem' }}>
            <div className="card" style={{ padding: '1.1rem 1.25rem' }}>
              <div className="mono" style={{ color: 'var(--cyan)', marginBottom: '0.55rem' }}>Live relayer state</div>
              {loadErr ? (
                <p style={{ color: '#f88', margin: 0 }}>{loadErr}</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem 1.25rem', color: '#fff' }}>
                  <span>Backend: {health?.ok ? 'online' : 'offline'}</span>
                  <span>Min stake: {stakingStats?.minStake || '5,000,000 PPT'}</span>
                  <span>Total staked: {stakingStats?.totalStaked || '—'}</span>
                  <span>Relayer valid: {relayerStatus?.isRelayerValid ? 'yes' : 'no'}</span>
                  <span>Your stake: {relayerStatus?.staked || '—'}</span>
                </div>
              )}
            </div>

            <div className="card" style={{ padding: '1.1rem 1.25rem' }}>
              <div className="mono" style={{ color: 'var(--cyan)', marginBottom: '0.55rem' }}>How to join node set</div>
              <p style={{ margin: 0, color: 'rgba(199, 222, 248, 0.85)', lineHeight: 1.65 }}>
                1) Stake tokens from the relayer onboarding flow. 2) Keep at least 5,000,000 PPT staked to qualify. 3) Run a relayer node locally.
                4) Use the same wallet for relayer operations so the network recognizes your node participation.
              </p>
            </div>

            <div className="card" style={{ padding: '1.1rem 1.25rem' }}>
              <div className="mono" style={{ color: 'var(--cyan)', marginBottom: '0.55rem' }}>Rewards and claiming profits</div>
              <p style={{ margin: 0, color: 'rgba(199, 222, 248, 0.85)', lineHeight: 1.65 }}>
                Relayers earn distribution from protocol activity based on participation and volume. Use staking controls in relayer onboarding to
                review balances and claim available rewards.
              </p>
            </div>

            <div className="card" style={{ padding: '1.1rem 1.25rem' }}>
              <div className="mono" style={{ color: 'var(--cyan)', marginBottom: '0.55rem' }}>Local node testing</div>
              <p style={{ margin: 0, color: 'rgba(199, 222, 248, 0.85)', lineHeight: 1.65 }}>
                For local verification, run your relayer backend and open the operator dashboard locally. This lets you test staking status and
                relayer readiness before running broader node operations.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
            <Link to="/relayer" className="btn-outline btn-outline-cyan">Relayer onboarding</Link>
            {isLocalEnv && (
              <a className="btn-outline" href="http://localhost:5177/" target="_blank" rel="noreferrer">Open local node dashboard</a>
            )}
            <a className="btn-outline" href={`${String(apiBase || '').replace(/\/$/, '')}/health`} target="_blank" rel="noreferrer">Open relayer API health</a>
            <a className="btn-outline" href={`${String(apiBase || '').replace(/\/$/, '')}/relayer/dashboard`} target="_blank" rel="noreferrer">Relayer dashboard JSON</a>
            <Link to="/privacy-visibility" className="btn-outline">Privacy & visibility</Link>
            <a className="btn-outline" href={RUNBOOK_URL} target="_blank" rel="noreferrer">Operator RUNBOOK</a>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label className="mono" style={{ color: 'rgba(176, 203, 235, 0.72)', fontSize: '0.72rem' }}>Relayer API endpoint</label>
            <input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              style={{
                marginTop: '0.35rem',
                width: '100%',
                borderRadius: 10,
                border: '1px solid rgba(138, 196, 255, 0.32)',
                background: 'rgba(10, 21, 39, 0.62)',
                color: 'rgba(229, 242, 255, 0.96)',
                padding: '0.7rem 0.8rem',
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function EnterprisePage() {
  return (
    <EnterpriseShell
      seo={{
        title: 'Phantom Enterprise Suite | Payroll, Compliance, Governance',
        description:
          'Enterprise-facing flows for private payroll, compliance-ready reporting, and governance operations in Phantom Protocol.',
        path: '/enterprise',
      }}
    >
      <Suspense fallback={<RouteLoader />}>
        <EnterpriseLayout><EnterpriseHomePage /></EnterpriseLayout>
      </Suspense>
    </EnterpriseShell>
  );
}

function EnterpriseShell({ children, seo }) {
  return (
    <div style={{ minHeight: '100vh' }}>
      <SeoHead title={seo.title} description={seo.description} path={seo.path} />
      <Navbar />
      <section className="section" style={{ paddingTop: '7rem' }}>
        <div className="container">{children}</div>
      </section>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <SeoHead
        robots="noindex, follow"
        title="Page not found | Phantom Protocol"
        description="This URL is not a published page on phantomproto.com."
        path="/404"
      />
      <Navbar />
      <section className="section" style={{ paddingTop: '7rem' }}>
        <div className="container" style={{ maxWidth: 640 }}>
          <h1 className="display-lg" style={{ marginBottom: '0.75rem' }}>
            Page not found
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.78)', lineHeight: 1.65, marginBottom: '1.5rem' }}>
            If you followed an old link, try the homepage or the product console.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link to="/" className="btn-outline btn-outline-cyan">
              Home
            </Link>
            <Link to="/trade" className="btn-outline">
              Trade
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function UnknownRoutePage() {
  const { pathname } = useLocation();
  const slug = String(pathname || '').replace(/^\/+|\/+$/g, '');
  if (slug && HOME_SCROLL_SECTION_IDS.has(slug)) {
    return <LandingPage />;
  }
  return <NotFoundPage />;
}

function LandingPage() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === '/') return;

    const sectionId = (location.pathname || '').replace(/^\/+/, '');
    if (!sectionId) return;

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
  }, [location.pathname]);

  return (
    <main style={{ position: 'relative', minHeight: '100vh' }}>
      <DataInterceptionBackground />
      <GhostChainVisualizer />
      {/* Logo Watermark — fixed, centered, z:0 */}
      <div className="watermark">
        <img src={logoUrl} alt="" aria-hidden="true" draggable="false" />
      </div>

      {/* Page content — z:10 */}
      <div style={{ position: 'relative', zIndex: 10 }}>
        <SeoHead
          title="Phantom Protocol | Private DeFi Infrastructure"
          description="Phantom Protocol enables shielded pool operations, relayer-based private execution, and compliance-friendly DeFi workflows."
          path="/"
        />
        <Navbar />

        <Hero />
        <InvestorSection />
        <WhoCanUseIt />
        <Benefits />
        <ComparisonTable />
        <TechCards />
        <TokenomicsSection />
        <SDKSection />
        <MetricsVisualizer />
        <NewsSection />
        <Mechanics />
        <RelayersSection />
        <PrivacyExplainer />
        <FeesSection />
        <Roadmap />
        <FAQ />
        <BackersPartnersSection />
        <NewsletterSection />

        {/* Footer */}
        <footer
          className="section"
          style={{ paddingTop: '3rem', paddingBottom: '3rem' }}
        >
          <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.5rem' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: '#fff', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              © 2026 Phantom Protocol — <span style={{ color: 'var(--cyan)' }}>Mathematical Privacy.</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem 2rem', justifyContent: 'flex-end', alignItems: 'center' }}>
              <Link to="/trade" className="hover-underline" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: 'var(--cyan)', letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
                Trade
              </Link>
              <Link to="/user" className="hover-underline" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: 'rgba(225, 240, 255, 0.94)', letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
                Console
              </Link>
              <Link to="/phantom-protocol" className="hover-underline" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: 'rgba(225, 240, 255, 0.94)', letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
                Phantom protocol
              </Link>
              <Link to="/blog" className="hover-underline" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: 'rgba(225, 240, 255, 0.94)', letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
                Blog
              </Link>
              {SOCIAL_LINKS.map(({ name, href }) => (
                <a
                  key={name}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover-underline"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--label-size)', fontWeight: 500, color: 'rgba(225, 240, 255, 0.94)', letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none', transition: 'color 0.3s' }}
                >
                  {name}
                </a>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

function PitchDeckRedirect() {
  useEffect(() => {
    window.location.href = '/pitchdeck.pdf';
  }, []);
  return null;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/user" element={<Navigate to="/trade" replace />} />
      <Route path="/trade" element={<TradePage />} />
      <Route path="/privacy-visibility" element={<PrivacyVisibilityPage />} />
      <Route path="/e-paper" element={<WhitepaperPage />} />
      <Route path="/whitepaper" element={<Navigate to="/e-paper" replace />} />
      <Route path="/onepager" element={<OnePagerPage />} />
      <Route path="/blog" element={<BlogIndexPage />} />
      {blogPosts.map((post) => (
        <Route
          key={post.slug}
          path={`/blog/${post.slug}`}
          element={
            <BlogArticlePage
              title={post.title}
              description={post.description}
              path={`/blog/${post.slug}`}
              date={post.date}
              readTime={post.readTime}
              intro={post.intro}
              sections={post.sections}
            />
          }
        />
      ))}
      <Route path="/relayer" element={<RelayerStakerPage />} />
      <Route path="/enterprise" element={<EnterprisePage />} />
      <Route
        path="/enterprise/payroll"
        element={(
          <EnterpriseShell
            seo={{
              title: 'Phantom Enterprise Payroll | Batch payouts and approvals',
              description:
                'Create, approve, and execute payroll runs against the Phantom enterprise API with idempotency and audit-friendly workflows.',
              path: '/enterprise/payroll',
            }}
          >
            <Suspense fallback={<RouteLoader />}>
              <EnterpriseLayout><PayrollPage /></EnterpriseLayout>
            </Suspense>
          </EnterpriseShell>
        )}
      />
      <Route
        path="/enterprise/compliance"
        element={(
          <EnterpriseShell
            seo={{
              title: 'Phantom Enterprise Compliance | Screening and reporting keys',
              description:
                'Compliance demos: wallet screening decisions, tax reporting keys, and structured audit exports for enterprise operators.',
              path: '/enterprise/compliance',
            }}
          >
            <Suspense fallback={<RouteLoader />}>
              <EnterpriseLayout><CompliancePage /></EnterpriseLayout>
            </Suspense>
          </EnterpriseShell>
        )}
      />
      <Route
        path="/enterprise/governance"
        element={(
          <EnterpriseShell
            seo={{
              title: 'Phantom Enterprise Governance | Proposals and votes',
              description:
                'Governance workspace for proposals, votes, and protocol parameter discussions in the Phantom enterprise suite.',
              path: '/enterprise/governance',
            }}
          >
            <Suspense fallback={<RouteLoader />}>
              <EnterpriseLayout><GovernancePage /></EnterpriseLayout>
            </Suspense>
          </EnterpriseShell>
        )}
      />
      <Route
        path="/enterprise/audit"
        element={(
          <EnterpriseShell
            seo={{
              title: 'Phantom Enterprise Audit | Event stream and controls',
              description:
                'Review enterprise audit events and operational controls surfaced by the Phantom relayer dashboard.',
              path: '/enterprise/audit',
            }}
          >
            <Suspense fallback={<RouteLoader />}>
              <EnterpriseLayout><AuditPage /></EnterpriseLayout>
            </Suspense>
          </EnterpriseShell>
        )}
      />
      <Route
        path="/phantom-protocol"
        element={
          <SeoContentPage
            title="What is Phantom Protocol? | Private DeFi Layer"
            description="Learn how Phantom Protocol works: shielded notes, relayers, and private execution with compliance-ready reporting controls."
            path="/phantom-protocol"
            heading="What is Phantom Protocol?"
            intro="Phantom Protocol is private DeFi infrastructure that combines shielded pools and relayer-based transaction execution so organizations can run sensitive financial operations on-chain and coordinate off-chain workflows while keeping operations confidential."
            bullets={[
              'Shielded note model with commitment tree and nullifier protection.',
              'Relayer flow that separates users from transaction broadcast addresses.',
              'Enterprise-friendly controls such as reporting key workflows and policy surfaces.',
              'Built for use cases such as treasury operations, payroll flows, private swaps, and private withdrawals.',
            ]}
          />
        }
      />
      <Route
        path="/private-defi"
        element={
          <SeoContentPage
            title="Private DeFi Infrastructure | Phantom Protocol"
            description="Private DeFi infrastructure for institutions, teams, and power users. Execute shielded pool operations while preserving operational confidentiality."
            path="/private-defi"
            heading="Private DeFi infrastructure for serious teams"
            intro="Most DeFi applications expose full transaction graphs. Phantom Protocol is designed for workflows that need public settlement with materially stronger privacy for balances and transfer patterns."
            bullets={[
              'Private pool architecture for internal value movement.',
              'Relayer-assisted submission to reduce metadata linkage from user wallets.',
              'Composable integration paths for protocol teams and enterprise operators.',
              'Operational flexibility across compliance, governance, and payout use cases.',
            ]}
          />
        }
      />
      <Route
        path="/shielded-pool-bnb"
        element={
          <SeoContentPage
            title="Shielded Pool on BNB Chain | Phantom Protocol"
            description="Explore Phantom Protocol shielded pool design on BNB Chain, including deposit, swap, and withdrawal lifecycle with private notes."
            path="/shielded-pool-bnb"
            heading="Shielded pool on BNB Chain"
            intro="The Phantom shielded pool tracks private notes through commitments while preventing double spend with nullifiers. Users can deposit, swap, and withdraw while exposing only required public outputs."
            bullets={[
              'Commitment tree anchors private note membership proofs.',
              'Nullifier set prevents replay and double-spend behavior.',
              'Join-split style proofs enforce value conservation constraints.',
              'Designed for integrations where transparency and confidentiality must be balanced.',
            ]}
          />
        }
      />
      <Route path="/banking-system" element={<BankingSystemPage />} />
      <Route path="/pitchdeck" element={<PitchDeckPage />} />
      <Route path="*" element={<UnknownRoutePage />} />
    </Routes>
  );
}

export default App;
