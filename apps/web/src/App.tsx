import { lazy, Suspense, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import type { Api } from './api.ts';
import { StoreProvider, useStore, type Session } from './store.tsx';
import { Mark, ThemeToggle, useTheme, Waiting, type Theme } from './components/ui.tsx';
import { Ask, defaultDraft } from './components/Ask.tsx';
import { Discover } from './components/Discover.tsx';
import { Invent } from './components/Invent.tsx';
import { AgreementSection } from './components/Agreement.tsx';
import { Commit } from './components/Commit.tsx';
import { Adapt } from './components/Adapt.tsx';
import { Footer } from './components/Footer.tsx';
import { Explore } from './components/Explore.tsx';
import { SellerTerminal } from './mounts.tsx';

const Evidence = lazy(() => import('./components/Evidence.tsx').then((m) => ({ default: m.Evidence })));

type Route = { name: 'product' } | { name: 'evidence'; market?: string } | { name: 'seller' };

function parse(hash: string): Route {
  if (/^#\/seller\//.test(hash)) return { name: 'seller' };
  const m = hash.match(/^#\/evidence(?:\/([^/?#]+))?/);
  if (m) return { name: 'evidence', market: m[1] ? decodeURIComponent(m[1]) : undefined };
  return { name: 'product' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo({ top: 0 });
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App({ api }: { api: Api }) {
  const [theme, setTheme] = useTheme();
  return (
    <MotionConfig reducedMotion="user">
      <StoreProvider api={api} initialDraft={defaultDraft()}>
        <Shell theme={theme} setTheme={setTheme} />
      </StoreProvider>
    </MotionConfig>
  );
}

type RailState = 'todo' | 'current' | 'done';

function railStates(s: Session): { id: string; target: string; label: string; state: RailState }[] | null {
  if (!s.market && !s.busy) return null;
  const feasible = !!s.negotiation?.report?.plan || (!!s.analysis?.report.plan && s.analysis.report.status !== 'infeasible');
  const paid = Object.values(s.payments).some((p) => p.state === 'CAPTURE_COMPLETED' || p.state.startsWith('REFUND'));
  const disrupted = !!s.disruption;
  const discoverDone = !!s.invention || feasible;
  const inventDone = feasible;
  const commitDone = paid || disrupted;
  const items: { id: string; target: string; label: string; state: RailState }[] = [
    { id: 'discover', target: 'discover', label: 'Discover', state: discoverDone ? 'done' : 'current' },
    { id: 'invent', target: 'invent', label: 'Invent', state: inventDone ? 'done' : discoverDone ? 'current' : 'todo' },
    { id: 'commit', target: 'agreement', label: 'Commit', state: commitDone ? 'done' : inventDone ? 'current' : 'todo' },
  ];
  if (disrupted) items.push({ id: 'adapt', target: 'adapt', label: 'Adapt', state: s.recovery ? 'done' : 'current' });
  return items;
}

function Rail({ s }: { s: Session }) {
  const items = railStates(s);
  if (!items) return null;
  return (
    <nav aria-label="Progress">
      <ol className="rail">
        {items.map((it, i) => (
          <li key={it.id}>
            {i > 0 ? <span className="rail-sep" aria-hidden="true" /> : null}
            <a
              href={`#${it.target}`}
              data-state={it.state}
              aria-current={it.state === 'current' ? 'step' : undefined}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(it.target)?.scrollIntoView({ block: 'start' });
                document.getElementById(it.target)?.focus({ preventScroll: true });
              }}
            >
              <span className="rail-dot" aria-hidden="true" />
              <span className="rail-label">{it.label}</span>
              <span className="sr-only">{it.state === 'done' ? ' (done)' : it.state === 'current' ? ' (in progress)' : ''}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Shell({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const route = useRoute();
  const { s } = useStore();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(scrollY > 8);
    on();
    addEventListener('scroll', on, { passive: true });
    return () => removeEventListener('scroll', on);
  }, []);
  const market = s.market?.market;
  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <header className="top" data-scrolled={scrolled}>
        <div className="top-in">
          <a
            className="brand"
            href="#/"
            onClick={(e) => {
              if (route.name === 'product') {
                e.preventDefault();
                window.scrollTo({ top: 0 });
              }
            }}
            aria-label="Framvera home"
          >
            <Mark />
            <span className="brand-word">Framvera</span>
          </a>
          {route.name === 'product' ? <Rail s={s} /> : null}
          <span className="top-spacer" />
          <div className="top-links">
            {route.name === 'seller' ? null : route.name === 'evidence' ? (
              <a className="top-link" href="#/">
                Back to the deal
              </a>
            ) : market ? (
              <a className="top-link" href={`#/evidence/${encodeURIComponent(market)}`}>
                Evidence
              </a>
            ) : null}
            <ThemeToggle theme={theme} onChange={setTheme} />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
        {route.name === 'seller' ? (
          <SellerTerminal loading="Opening the seller terminal" fallback={<div className="page"><Waiting>The seller terminal is not available in this build.</Waiting></div>} />
        ) : route.name === 'evidence' ? (
          <Suspense fallback={<div className="page"><Waiting>Loading evidence</Waiting></div>}>
            <Evidence market={route.market ?? market} />
          </Suspense>
        ) : (
          <div className="page">
            <Ask />
            <Discover />
            <Invent />
            <AgreementSection theme={theme} />
            <Commit />
            <Adapt />
            <Explore />
            <Footer />
          </div>
        )}
      </main>
    </>
  );
}
