import { useEffect, useState } from 'react';
import { tokens, applyTheme, initialTheme } from './tokens.js';
import { api } from './data/client.js';
import { TickerTape } from './ui/TickerTape.jsx';
import { CardDetail } from './ui/CardDetail.jsx';
import { ListingDetail } from './ui/ListingDetail.jsx';
import { GachaDesk } from './ui/tables.jsx';
import { Terminal, CardsPage } from './ui/Terminal.jsx';
import { Binder } from './ui/Binder.jsx';

/**
 * Real pages, lazy data (Kaleb, 2026-07-21: "would it make sense for the
 * Dashboard to be one page and the Gacha Desk a separate page?" — yes):
 *
 *   /                     Terminal dashboard (indexes + movers + lookup)
 *   /listings             Listings (the ~11k-listing payload loads ONLY here; /desk redirects)
 *   /card/<id>            card research page  — deep-linkable/shareable
 *   /listing/<platform>/<external_id>  listing page — deep-linkable/shareable
 *
 * History-API routing (the server already falls every non-/api path through
 * to the SPA), so browser back/forward and link-sharing behave like a real
 * website. Each section fetches its own data on first visit and caches it in
 * state — opening the Terminal no longer downloads the entire desk.
 */
// TERMINAL / CARDS / LISTINGS (Kaleb, 2026-07-21): the lookup table moves to
// its own CARDS tab — the database gets a home; the Terminal page is the
// market-strength snapshot + deal radar.
// BINDER (2026-07-22): major build #1 — the portfolio tracker gets a tab.
// DESK not TERMINAL (Kaleb, 2026-07-23): "make this less intimidating…
// the word Terminal may lean too hard into the analytics side."
const TABS = [['Desk', '/'], ['Cards', '/cards'], ['Listings', '/listings'], ['Binder', '/binder']];

const parseRoute = (path) => {
  // '/desk' was the Listings URL before the front tab became Desk
  // (2026-07-23) — old links land on the same page at its new address.
  if (path === '/listings' || path === '/desk') return { page: 'desk' };
  if (path === '/cards') return { page: 'cards' };
  if (path === '/binder') return { page: 'binder' };
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

  // Boot mark dismissal: fade the inline splash once the app is mounted.
  // 600ms minimum display (measured from the splash's own paint) so fast
  // loads read as an intentional beat, never a blink; slow loads simply
  // stay covered until we're actually here. It never ADDS wait beyond that.
  useEffect(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    const elapsed = performance.now() - (window.__bootT0 ?? 0);
    const t = setTimeout(() => {
      boot.classList.add('done');
      setTimeout(() => boot.remove(), 450);
    }, Math.max(0, 600 - elapsed));
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to, replace = false) => {
    if (to !== window.location.pathname) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    }
    setPath(to);
  };
  const goBack = (fallback) => {
    if (window.history.length > 1) window.history.back();
    else navigate(fallback);
  };

  const openCard = (id) => { if (route.page !== 'listing') setOrigin(route.page === 'desk' ? 'desk' : route.page === 'cards' ? 'cards' : route.page === 'binder' ? 'binder' : 'terminal'); navigate(`/card/${encodeURIComponent(id)}`); };
  const openListing = (l, ctx) => {
    if (route.page === 'desk') setOrigin('desk');
    if (ctx) setNavListings(ctx);
    // Listing→listing moves (prev/next arrows, similar-listings) REPLACE the
    // history entry — shuffling through 20 slabs is one browsing session, and
    // Back returns to the desk thumbnails, not back through every slab
    // (Kaleb, 2026-07-21).
    const listingToListing = route.page === 'listing';
    navigate(`/listing/${encodeURIComponent(l.platform)}/${encodeURIComponent(l.external_id)}`, listingToListing);
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
      {/* ── Header, terminal aesthetic (Kaleb, 2026-07-21: logo + tabs felt
          off-brand). Brass slab mark + spaced wordmark; tabs speak the same
          uppercase-mono language as every section head. ── */}
      <header style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 24px', padding: '16px clamp(12px, 3vw, 28px) 12px' }}>
        <a href="/" onClick={e => { e.preventDefault(); setOrigin('terminal'); navigate('/'); }}
           style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}>
          {/* The mark: a toploader sleeve — brass frame, card inside. */}
          <span aria-hidden style={{
            width: 26, height: 34, borderRadius: 4, border: `1.5px solid ${tokens.color.brass}`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
          }}>
            <span style={{ width: 16, height: 22, borderRadius: 2, background: tokens.color.brass, opacity: 0.85 }} />
          </span>
          <span>
            <span style={{ display: 'block', font: `600 19px ${tokens.font.display}`, letterSpacing: '3px', lineHeight: 1 }}>TOPLOAD</span>
            <span style={{ display: 'block', font: `9px ${tokens.font.mono}`, letterSpacing: '3.5px', color: tokens.color.inkMuted, marginTop: 3 }}>CARD DESK</span>
          </span>
        </a>
        <nav style={{ display: 'flex', gap: 2, marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
          {TABS.map(([label, to]) => {
            const active = (route.page === 'terminal' && to === '/') || (route.page === 'desk' && to === '/listings') || (route.page === 'cards' && to === '/cards') || (route.page === 'binder' && to === '/binder');
            return (
              <button key={to} onClick={() => { setOrigin(to === '/listings' ? 'desk' : to === '/cards' ? 'cards' : 'terminal'); navigate(to); }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = tokens.color.ink; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = tokens.color.inkSecondary; }}
                style={{
                  background: 'none',
                  border: 'none', borderBottom: active ? `2px solid ${tokens.color.brass}` : '2px solid transparent',
                  color: active ? tokens.color.ink : tokens.color.inkSecondary,
                  padding: '10px clamp(8px, 1.8vw, 16px)', font: `11px ${tokens.font.mono}`, textTransform: 'uppercase',
                  letterSpacing: '1.5px', cursor: 'pointer', transition: 'color .12s ease',
                }}>{label}</button>
            );
          })}
          <button onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} style={{
            background: 'none', border: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary,
            borderRadius: 4, padding: '4px 10px', font: `12px ${tokens.font.body}`, cursor: 'pointer', marginLeft: 'clamp(6px, 1.5vw, 18px)',
          }}>{theme === 'dark' ? '☀' : '☾'}</button>
        </nav>
      </header>
      <hr style={{ border: 'none', borderTop: `1px solid ${tokens.color.border}`, margin: 0 }} />
      <TickerTape onSelect={openCard} />
      <div style={{ height: 20 }} />

      {/* 1400 (was 1000): the terminal should FILL the screen — wasted margins
          made the market read small (Kaleb, 2026-07-21). */}
      <main style={{ padding: '0 28px 40px', maxWidth: 1400, margin: '0 auto' }}>
        {err && <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}`, marginBottom: 12, textTransform: 'uppercase' }}>{err}</div>}

        {route.page === 'card' && (
          <CardDetail cardId={route.cardId} onBack={() => goBack(origin === 'desk' ? '/listings' : origin === 'cards' ? '/cards' : origin === 'binder' ? '/binder' : '/')} onOpenCard={openCard} />
        )}

        {route.page === 'listing' && (
          selectedListing && selectedListing !== 'missing' ? (
            <ListingDetail
              listing={selectedListing}
              listings={gacha}
              navListings={navListings ?? gacha}
              onBack={() => goBack('/listings')}
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
            movers={movers} onSelect={openCard} onOpenListing={openListing}
          />
        )}

        {/* Cards tab stays MOUNTED (hidden) under detail pages opened from it,
            so search + filters survive the back-click — same desk pattern. */}
        {(route.page === 'cards' || (route.page === 'card' && origin === 'cards')) && (
          <div style={{ display: route.page === 'cards' ? 'block' : 'none' }}>
            <CardsPage onSelect={openCard} />
          </div>
        )}

        {/* Binder stays MOUNTED (hidden) under card pages opened from it —
            positions state + add-flow survive the back-click, same pattern. */}
        {(route.page === 'binder' || (route.page === 'card' && origin === 'binder')) && (
          <div style={{ display: route.page === 'binder' ? 'block' : 'none' }}>
            <Binder onSelect={openCard} />
          </div>
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
