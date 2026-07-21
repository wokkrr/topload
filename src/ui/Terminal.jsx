import { useEffect, useState } from 'react';
import { tokens } from '../tokens.js';
import { api } from '../data/client.js';
import { Chip, Thumb, BasketTable } from './tables.jsx';
import { Screener } from './Screener.jsx';
import { IndexChart } from './IndexChart.jsx';

/**
 * The Terminal tab — one dashboard replacing the old Cards / Movers / Basket
 * tabs. v2 after the first cut overflowed (side-by-side panels strangled
 * full-width tables): single column, essentials only (Kaleb: "figure out the
 * most important information to display and go with that to start").
 *
 *   1. Indexes  — is the market up or down (franchise benchmark chart)
 *   2. Movers   — what's hot: name · grade · mark · Δ1D, top 8, nothing else
 *   3. Lookup   — find anything (full screener)
 *
 * Basket constituents intentionally left off this first dashboard — tables
 * and API remain (tables.jsx BasketTable) for the richer dashboard later.
 */

const RANGES = [7, 30, 90];

const fmtUsd = (c) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: c >= 100000 ? 0 : 2 })}`;
const fmtPct = (p) => p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;

function SectionHead({ title, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' }}>
      <h2 style={{
        margin: 0, font: `12px ${tokens.font.mono}`, textTransform: 'uppercase',
        letterSpacing: '1.5px', color: tokens.color.ink,
      }}>{title}</h2>
      {hint && <span style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>{hint}</span>}
    </div>
  );
}

const panel = {
  border: `1px solid ${tokens.color.border}`, borderRadius: 0,
  padding: '14px 16px', background: tokens.color.surface,
  boxSizing: 'border-box', width: '100%', overflow: 'hidden',
};

/** One mover, overflow-proof: dot + name ellipsize; price + Δ pinned right. */
function MoverRow({ m, onSelect }) {
  const up = (m.change_pct ?? 0) >= 0;
  return (
    <div onClick={() => onSelect?.(m.card_id)} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px',
      borderTop: `1px solid ${tokens.color.border}`, cursor: 'pointer', minWidth: 0,
    }}>
      <Thumb src={m.image} size={30} />
      <span style={{
        flex: 'none', width: 8, height: 8, borderRadius: 2,
        background: tokens.series[m.ip]?.data ?? tokens.color.inkMuted,
      }} title={tokens.series[m.ip]?.label ?? m.ip} />
      <span style={{
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', font: `13px ${tokens.font.body}`,
      }}>
        {m.name} <span style={{ color: tokens.color.inkMuted }}>· {m.grade}</span>
      </span>
      <span style={{ flex: 'none', font: `13px ${tokens.font.mono}` }}>{fmtUsd(m.price_now)}</span>
      <span style={{
        flex: 'none', width: 62, textAlign: 'right', font: `13px ${tokens.font.mono}`,
        color: m.change_pct == null ? tokens.color.inkMuted : up ? tokens.color.up : tokens.color.down,
      }}>{fmtPct(m.change_pct)}</span>
    </div>
  );
}

export function Terminal({ indexes, days, setDays, movers, onSelect }) {
  // 'What IS this index?' answered with the actual cards (Kaleb, 2026-07-21):
  // the Cards view lists each published index's current constituents with
  // weights and marks — replaces the old numbers table.
  const [view, setView] = useState('chart');
  const [baskets, setBaskets] = useState({});
  const published = (indexes ?? []).filter(d => d.published !== false && d.series?.length);
  useEffect(() => {
    if (view !== 'cards') return;
    for (const d of published) {
      if (baskets[d.index_id]) continue;
      api.basket(d.index_id)
        .then(rows => setBaskets(b => ({ ...b, [d.index_id]: rows })))
        .catch(() => setBaskets(b => ({ ...b, [d.index_id]: [] })));
    }
  }, [view, indexes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      <div style={panel}>
        <SectionHead title="Indexes" hint="liquidity-weighted franchise benchmarks · base 100 · built from first-hand recorded sales (history begins Jun 2026)" />
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>
          ))}
          <span style={{ flex: 1 }} />
          <Chip active={view === 'chart'} onClick={() => setView('chart')}>Chart</Chip>
          <Chip active={view === 'cards'} onClick={() => setView('cards')}>Cards in index</Chip>
        </div>
        {view === 'chart' ? <IndexChart data={indexes} /> : (
          published.length ? published.map(d => (
            <div key={d.index_id} style={{ marginBottom: 22 }}>
              <div style={{ font: `12px ${tokens.font.mono}`, color: tokens.color.inkSecondary, margin: '4px 0 8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                {tokens.series[d.index_id]?.label ?? d.index_id} — current constituents
              </div>
              {baskets[d.index_id]
                ? <BasketTable basket={baskets[d.index_id]} onSelect={onSelect} />
                : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>Loading…</div>}
            </div>
          )) : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '8px 2px' }}>No published indexes yet.</div>
        )}
      </div>

      <div style={panel}>
        <SectionHead title="Movers · 24h" hint="biggest one-day moves among cards with live marks" />
        {movers?.length
          ? movers.slice(0, 8).map(m => <MoverRow key={`${m.card_id}|${m.grade}`} m={m} onSelect={onSelect} />)
          : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '8px 2px' }}>no movers yet — marks refresh with each ingest</div>}
      </div>

      <div style={panel}>
        <SectionHead title="Card Lookup" hint="search the full Topload Card Database — every tracked card, priced or not" />
        <Screener onSelect={onSelect} />
      </div>

    </section>
  );
}
