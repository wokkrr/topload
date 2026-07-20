import { useEffect, useState } from 'react';
import { tokens, applyTheme, initialTheme } from './tokens.js';
import { api } from './data/client.js';
import { TickerTape } from './ui/TickerTape.jsx';
import { CardDetail } from './ui/CardDetail.jsx';
import { ListingDetail } from './ui/ListingDetail.jsx';
import { GachaDesk } from './ui/tables.jsx';
import { Terminal } from './ui/Terminal.jsx';

// Cards / Movers / Basket merged into the single 'Terminal' dashboard
// (Kaleb, 2026-07-20: "combine them into one singular tab… keep things
// simple"). Their tables live on inside Terminal.jsx sections.
const TABS = ['Terminal', 'Gacha Desk'];

export default function App() {
  const [tab, setTab] = useState('Terminal');
  const [days, setDays] = useState(90);
  const [indexes, setIndexes] = useState(null);
  const [movers, setMovers] = useState(null);
  const [gacha, setGacha] = useState(null);
  const [platforms, setPlatforms] = useState(null);
  const [recentSales, setRecentSales] = useState(null);
  const [selectedCard, setSelectedCard] = useState(null);
  const [selectedListing, setSelectedListing] = useState(null);
  const [theme, setTheme] = useState(initialTheme());
  const [err, setErr] = useState(null);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  useEffect(() => { api.gacha().then(setGacha).catch(() => setGacha([])); }, []);
  useEffect(() => { api.platforms().then(setPlatforms).catch(() => setPlatforms([])); }, []);
  useEffect(() => { api.recentSales().then(setRecentSales).catch(() => setRecentSales([])); }, []);
  useEffect(() => { api.indexes(days).then(setIndexes).catch(e => setErr(String(e))); }, [days]);
  useEffect(() => { api.movers(1).then(setMovers).catch(e => setErr(String(e))); }, []);

  return (
    <div style={{ minHeight: '100vh', background: tokens.color.bg, color: tokens.color.ink, fontFamily: tokens.font.body }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 24, padding: '20px 28px 0' }}>
        <h1 style={{ font: `22px ${tokens.font.display}`, margin: 0, letterSpacing: '0.5px' }}>
          Topload <span style={{ color: tokens.color.inkMuted, fontSize: 12, fontFamily: tokens.font.mono }}>card terminal · v2</span>
        </h1>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          {TABS.map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedCard(null); setSelectedListing(null); }} style={{
              background: tab === t ? tokens.color.surfaceRaised : 'none',
              border: 'none', borderBottom: tab === t ? `2px solid ${tokens.color.brass}` : '2px solid transparent',
              color: tab === t ? tokens.color.ink : tokens.color.inkSecondary,
              padding: '8px 14px', font: `13px ${tokens.font.body}`, cursor: 'pointer', borderRadius: '4px 4px 0 0',
            }}>{t}</button>
          ))}
          <button onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} style={{
            background: 'none', border: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary,
            borderRadius: 4, padding: '4px 10px', font: `12px ${tokens.font.body}`, cursor: 'pointer', marginLeft: 16,
          }}>{theme === 'dark' ? '☀' : '☾'}</button>
        </nav>
      </header>
      <hr style={{ border: 'none', borderTop: `1px solid ${tokens.color.border}`, margin: 0 }} />
      <TickerTape onSelect={setSelectedCard} />
      <div style={{ height: 20 }} />

      <main style={{ padding: '0 28px 40px', maxWidth: 1000, margin: '0 auto' }}>
        {err && <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}`, marginBottom: 12 }}>{err}</div>}

        {selectedCard && (
          <CardDetail cardId={selectedCard} onBack={() => setSelectedCard(null)} />
        )}

        {!selectedCard && selectedListing && (
          <ListingDetail
            listing={selectedListing}
            listings={gacha}
            onBack={() => setSelectedListing(null)}
            onOpenListing={setSelectedListing}
            onSelectCard={(id) => { setSelectedListing(null); setSelectedCard(id); }}
          />
        )}

        {!selectedCard && !selectedListing && tab === 'Terminal' && (
          <Terminal
            indexes={indexes} days={days} setDays={setDays}
            movers={movers} onSelect={setSelectedCard}
          />
        )}

        {!selectedCard && !selectedListing && tab === 'Gacha Desk' && (
          <GachaDesk listings={gacha} platforms={platforms} sales={recentSales}
                     onSelect={setSelectedCard} onOpenListing={setSelectedListing} />
        )}
      </main>
    </div>
  );
}
