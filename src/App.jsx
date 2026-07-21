import { useEffect, useState } from 'react';
import { tokens, applyTheme, initialTheme } from './tokens.js';
import { api } from './data/client.js';
import { TickerTape } from './ui/TickerTape.jsx';
import { CardDetail } from './ui/CardDetail.jsx';
import { ListingDetail } from './ui/ListingDetail.jsx';
import { GachaDesk } from './ui/tables.jsx';
import { Terminal } from './ui/Terminal.jsx';

/**
 * Real pages, lazy data (Kaleb, 2026-07-21: "would it make sense for the
 * Dashboard to be one page and the Gacha Desk a separate page?" — yes):
 *
 *   /                     Terminal dashboard (indexes + movers + lookup)
 *   /desk                 Gacha Desk (the ~11k-listing payload loads ONLY here)
 *   /card/<id>            card research page  — deep-linkable/shareable
 *   /listing/<platform>/<external_id>  listing page — deep-linkable/shareable
 *
 * History-API routing (the server already falls every non-/api path through
 * to the SPA), so browser back/forward and link-sharing behave like a real
 * website. Each section fetches its own data on first visit and caches it in
 * state — opening the Terminal no longer downloads the entire desk.
 */
const TABS = [['Terminal', '/'], ['Gacha Desk', '/desk']];

const parseRoute = (path) => {
  if (path === '/desk') return { page: 'desk' };
  const card = /^\/card\/(.+)$/.exec(path);
  if (card) return { page: 'card', cardId: decodeURIComponent(card[1]) };
  const listing = /^\/listing\/([^/]+)\/(.+)$/.exec(path);
  if (listing) return { page: 'listing', platform: decodeURIComponent(listing[1]), externalId: decodeURIComponent(listing[2]) };
  return { page: 'terminal' };
};

export default function App() {
  const [path, setPath] = useState(typeof window !== 'undefined' ? window.location.pathname : '/');
  const [days, setDays] = useState(90);
  const [indexes, setIndexes] = useState(null);
  const [movers, setMovers] = useState(null);
  const [gacha, setGacha] = useState(null);
  const [platforms, setPlatforms] = useState(null);
  const [recentSales, setRecentSales] = useState(null);
  // The filtered+sorted desk list at the moment a listing was opened — the
  // detail page's prev/next arrows walk THIS, not the whole collection.
  const [navListings, setNavListings] = useState(null);
  // Which list page the user came from — details keep it mounted underneath
  // so filters + scroll survive the back-click (Kaleb, 2026-07-20).
  const [origin, setOrigin] = useState('terminal');
  const [theme, setTheme] = useState(initialTheme());
  const [err, setErr] = useState(null);

  const route = parseRoute(path);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to) => {
    if (to !== window.location.pathname) window.history.pushState(null, '', to);
    setPath(to);
  };
  const goBack = (fallback) => {
    if (window.history.length > 1) window.history.back();
    else navigate(fallback);
  };

  const openCard = (id) => { if (route.page !== 'listing') setOrigin(route.page === 'desk' ? 'desk' : 'terminal'); navigate(`/card/${encodeURIComponent(id)}`); };
  const openListing = (l, ctx) => {
    if (route.page === 'desk') setOrigin('desk');
    if (ctx) setNavListings(ctx);
    navigate(`/listing/${encodeURIComponent(l.platform)}/${encodeURIComponent(l.external_id)}`);
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  // ── Lazy, per-page data. Fetched on first need, cached for the session. ──
  const needDesk = route.page === 'desk' || route.page === 'listing';
  const needTerminal = route.page === 'terminal';
  useEffect(() => {
    if (needDesk && gacha === null) {
      setGacha(undefined); // in-flight marker
      api.gacha().then(setGacha).catch(() => setGacha([]));
      api.platforms().then(setPlatforms).catch(() => setPlatforms([]));
      api.recentSales().then(setRecentSales).catch(() => setRecentSales([]));
    }
  }, [needDesk, gacha]);
  useEffect(() => {
    if (needTerminal && movers === null) {
      api.movers(1).then(setMovers).catch(e => setErr(String(e)));
    }
  }, [needTerminal, movers]);
  useEffect(() => {
    if (needTerminal) api.indexes(days).then(setIndexes).catch(e => setErr(String(e)));
  }, [needTerminal, days]);

  // A deep-linked /listing URL resolves against the desk data once it lands.
  const selectedListing = route.page === 'listing' && Array.isArray(gacha)
    ? gacha.find(l => l.platform === route.platform && l.external_id === route.externalId) ?? 'missing'
    : null;

  return (
    <div style={{ minHeight: '100vh', background: tokens.color.bg, color: tokens.color.ink, fontFamily: tokens.font.body }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 24, padding: '20px 28px 0' }}>
        <h1 style={{ font: `22px ${tokens.font.display}`, margin: 0, letterSpacing: '0.5px' }}>
          Topload <span style={{ color: tokens.color.inkMuted, fontSize: 12, fontFamily: tokens.font.mono }}>card terminal · v2</span>
        </h1>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          {TABS.map(([label, to]) => {
            const active = (route.page === 'terminal' && to === '/') || (route.page === 'desk' && to === '/desk');
            return (
              <button key={to} onClick={() => { setOrigin(to === '/desk' ? 'desk' : 'terminal'); navigate(to); }} style={{
                background: active ? tokens.color.surfaceRaised : 'none',
                border: 'none', borderBottom: active ? `2px solid ${tokens.color.brass}` : '2px solid transparent',
                color: active ? tokens.color.ink : tokens.color.inkSecondary,
                padding: '8px 14px', font: `13px ${tokens.font.body}`, cursor: 'pointer', borderRadius: '4px 4px 0 0',
              }}>{label}</button>
            );
          })}
          <button onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} style={{
            background: 'none', border: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary,
            borderRadius: 4, padding: '4px 10px', font: `12px ${tokens.font.body}`, cursor: 'pointer', marginLeft: 16,
          }}>{theme === 'dark' ? '☀' : '☾'}</button>
        </nav>
      </header>
      <hr style={{ border: 'none', borderTop: `1px solid ${tokens.color.border}`, margin: 0 }} />
      <TickerTape onSelect={openCard} />
      <div style={{ height: 20 }} />

      <main style={{ padding: '0 28px 40px', maxWidth: 1000, margin: '0 auto' }}>
        {err && <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}`, marginBottom: 12 }}>{err}</div>}

        {route.page === 'card' && (
          <CardDetail cardId={route.cardId} onBack={() => goBack(origin === 'desk' ? '/desk' : '/')} />
        )}

        {route.page === 'listing' && (
          selectedListing && selectedListing !== 'missing' ? (
            <ListingDetail
              listing={selectedListing}
              listings={gacha}
              navListings={navListings ?? gacha}
              onBack={() => goBack('/desk')}
              onOpenListing={openListing}
              onSelectCard={openCard}
            />
          ) : (
            <div style={{ color: tokens.color.inkMuted, padding: 24, font: `13px ${tokens.font.body}` }}>
              {selectedListing === 'missing'
                ? 'This listing is no longer on the desk — it may have sold or been delisted.'
                : 'Loading listing…'}
            </div>
          )
        )}

        {route.page === 'terminal' && (
          <Terminal
            indexes={indexes} days={days} setDays={setDays}
            movers={movers} onSelect={openCard}
          />
        )}

        {/* Desk stays MOUNTED (hidden) underneath detail pages opened from it,
            so filters + scroll survive browser-back (Kaleb, 2026-07-20). */}
        {(route.page === 'desk' || ((route.page === 'card' || route.page === 'listing') && origin === 'desk')) && (
          <div style={{ display: route.page === 'desk' ? 'block' : 'none' }}>
            {Array.isArray(gacha)
              ? <GachaDesk listings={gacha} platforms={platforms} sales={recentSales}
                           onSelect={openCard} onOpenListing={openListing} />
              : <div style={{ color: tokens.color.inkMuted, padding: 24, font: `13px ${tokens.font.body}` }}>Loading the desk…</div>}
          </div>
        )}
      </main>
    </div>
  );
}
