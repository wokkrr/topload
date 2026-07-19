import { useEffect, useState } from 'react';
import { tokens } from './tokens.js';
import { api } from './data/client.js';
import { IndexChart } from './ui/IndexChart.jsx';
import { TickerTape } from './ui/TickerTape.jsx';
import { CardDetail } from './ui/CardDetail.jsx';
import { MoversTable, BasketTable, CardsTable, GachaDesk } from './ui/tables.jsx';

const TABS = ['Cards', 'Indexes', 'Movers', 'Basket', 'Gacha Desk'];
const RANGES = [7, 30, 90];

export default function App() {
  const [tab, setTab] = useState('Cards');
  const [days, setDays] = useState(90);
  const [basketIp, setBasketIp] = useState('PKMN');
  const [indexes, setIndexes] = useState(null);
  const [movers, setMovers] = useState(null);
  const [basket, setBasket] = useState(null);
  const [cards, setCards] = useState(null);
  const [gacha, setGacha] = useState(null);
  const [selectedCard, setSelectedCard] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api.cards().then(setCards).catch(e => setErr(String(e))); }, []);
  useEffect(() => { api.gacha().then(setGacha).catch(() => setGacha([])); }, []);
  useEffect(() => { api.indexes(days).then(setIndexes).catch(e => setErr(String(e))); }, [days]);
  useEffect(() => { api.movers(1).then(setMovers).catch(e => setErr(String(e))); }, []);
  useEffect(() => { api.basket(basketIp).then(setBasket).catch(e => setErr(String(e))); }, [basketIp]);

  return (
    <div style={{ minHeight: '100vh', background: tokens.color.bg, color: tokens.color.ink, fontFamily: tokens.font.body }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 24, padding: '20px 28px 0' }}>
        <h1 style={{ font: `22px ${tokens.font.display}`, margin: 0, letterSpacing: '0.5px' }}>
          Topload <span style={{ color: tokens.color.inkMuted, fontSize: 12, fontFamily: tokens.font.mono }}>card terminal · v2</span>
        </h1>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {TABS.map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedCard(null); }} style={{
              background: tab === t ? tokens.color.surfaceRaised : 'none',
              border: 'none', borderBottom: tab === t ? `2px solid ${tokens.color.brass}` : '2px solid transparent',
              color: tab === t ? tokens.color.ink : tokens.color.inkSecondary,
              padding: '8px 14px', font: `13px ${tokens.font.body}`, cursor: 'pointer', borderRadius: '4px 4px 0 0',
            }}>{t}</button>
          ))}
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

        {!selectedCard && tab === 'Indexes' && (
          <section>
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {RANGES.map(r => (
                <button key={r} onClick={() => setDays(r)} style={{
                  background: days === r ? tokens.color.surfaceRaised : 'none',
                  border: `1px solid ${days === r ? tokens.color.inkMuted : tokens.color.border}`,
                  color: days === r ? tokens.color.ink : tokens.color.inkSecondary,
                  borderRadius: 4, padding: '3px 12px', font: `11px ${tokens.font.mono}`, cursor: 'pointer',
                }}>{r}D</button>
              ))}
              <span style={{ marginLeft: 12, alignSelf: 'center', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>
                liquidity-weighted, rules-based baskets, base 100
              </span>
            </div>
            <IndexChart data={indexes} />
          </section>
        )}

        {!selectedCard && tab === 'Cards' && <CardsTable cards={cards} onSelect={setSelectedCard} />}

        {!selectedCard && tab === 'Movers' && <MoversTable movers={movers} onSelect={setSelectedCard} />}

        {!selectedCard && tab === 'Basket' && (
          <section>
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {Object.entries(tokens.series).map(([id, s]) => (
                <button key={id} onClick={() => setBasketIp(id)} style={{
                  background: basketIp === id ? tokens.color.surfaceRaised : 'none',
                  border: `1px solid ${basketIp === id ? s.data : tokens.color.border}`,
                  color: basketIp === id ? tokens.color.ink : tokens.color.inkSecondary,
                  borderRadius: 4, padding: '3px 12px', font: `11px ${tokens.font.body}`, cursor: 'pointer',
                }}>{s.label}</button>
              ))}
              <span style={{ marginLeft: 12, alignSelf: 'center', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>
                top-N by 90D volume · conf ≥ 30 · monthly rebalance
              </span>
            </div>
            <BasketTable basket={basket} onSelect={setSelectedCard} />
          </section>
        )}

        {!selectedCard && tab === 'Gacha Desk' && <GachaDesk listings={gacha} onSelect={setSelectedCard} />}
      </main>
    </div>
  );
}
