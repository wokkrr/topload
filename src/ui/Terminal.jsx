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
 *   1. Indexes + Movers side by side (Kaleb, 2026-07-21) — benchmarks and
 *      what's hot share the top row; Card Ladder-scale baskets (400/game)
 *      with receipts. History deepens daily (PC marks + on-chain backfills).
 *   2. Lookup   — find anything (full screener)
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

/**
 * How-this-index-works receipts (Kaleb, 2026-07-21: "we need to see more
 * information about how they're being factored in"): the weighting formula
 * in plain words + the concentration stats that formula produces.
 */
function BasketSummary({ basket }) {
  const priced = basket.filter(b => b.price_cents != null);
  const top10 = basket.slice(0, 10).reduce((a, b) => a + (b.weight || 0), 0);
  const wkVol = priced.reduce((a, b) => a + (b.price_cents ?? 0) * (b.sales_7d ?? 0), 0);
  const stat = { font: `12px ${tokens.font.mono}`, color: tokens.color.ink };
  const label = { font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.5px' };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 6 }}>
        <span><div style={label}>constituents</div><div style={stat}>{basket.length}</div></span>
        <span><div style={label}>with live marks</div><div style={stat}>{priced.length}</div></span>
        <span><div style={label}>top 10 hold</div><div style={stat}>{(top10 * 100).toFixed(1)}%</div></span>
        <span><div style={label}>basket $vol/wk</div><div style={stat}>{fmtUsd(wkVol)}</div></span>
      </div>
      <div style={{ font: `11px ${tokens.font.body}`, color: tokens.color.inkMuted }}>
        Weight = mark × weekly sales (dollar volume), capped at 10% per card, renormalized to 100%.
        Membership = the most-traded confidence-gated cards, reselected weekly; weights fixed between rebalances.
      </div>
    </div>
  );
}

export function Terminal({ indexes, days, setDays, movers, onSelect }) {
  // 'What IS this index?' answered with the actual cards. Four toggles
  // (Kaleb, 2026-07-21): Chart, then one per game showing THAT index's
  // current constituents. Three focused indexes on purpose — Card Ladder
  // fragments into dozens; we'd rather three lines with receipts.
  const [view, setView] = useState('chart');
  const [baskets, setBaskets] = useState({});
  useEffect(() => {
    if (view === 'chart' || baskets[view]) return;
    api.basket(view)
      .then(rows => setBaskets(b => ({ ...b, [view]: rows })))
      .catch(() => setBaskets(b => ({ ...b, [view]: [] })));
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const meta = (ip) => (indexes ?? []).find(d => d.index_id === ip);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ flex: '2 1 520px', minWidth: 0 }}>
      <div style={{ ...panel, height: '100%' }}>
        <SectionHead title="Indexes" hint="liquidity-weighted franchise benchmarks · base 100 · built from first-hand recorded sales (history begins Jun 2026)" />
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {RANGES.map(r => (
            <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>
          ))}
          <span style={{ flex: 1 }} />
          {[['chart', 'Chart'], ['PKMN', 'Pokémon'], ['OP', 'One Piece'], ['YGO', 'Yu-Gi-Oh']].map(([id, label]) => (
            <Chip key={id} active={view === id} onClick={() => setView(id)}
                  color={id !== 'chart' ? tokens.series[id]?.data : undefined}>{label}</Chip>
          ))}
        </div>
        {view === 'chart' ? <IndexChart data={indexes} /> : (
          <div>
            <div style={{ font: `12px ${tokens.font.mono}`, color: tokens.color.inkSecondary, margin: '4px 0 8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
              {tokens.series[view]?.label ?? view} index — current constituents
              {meta(view)?.members != null && ` · ${meta(view).members} cards`}
            </div>
            {meta(view)?.published === false && (
              <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, marginBottom: 8 }}>
                This index isn't drawn on the chart yet — it publishes at {meta(view)?.min_members ?? 8} actively-traded
                cards ({meta(view)?.members ?? 0} now). The cards below are its basket so far.
              </div>
            )}
            {baskets[view]
              ? (baskets[view].length
                  ? <>
                      <BasketSummary basket={baskets[view]} />
                      <BasketTable basket={baskets[view]} onSelect={onSelect} />
                    </>
                  : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>No constituents yet — this basket fills as sales history builds.</div>)
              : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>Loading…</div>}
          </div>
        )}
      </div>
        </div>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
      <div style={{ ...panel, height: '100%' }}>
        <SectionHead title="Movers · 24h" hint="biggest one-day moves among cards with live marks" />
        {movers?.length
          ? movers.slice(0, 8).map(m => <MoverRow key={`${m.card_id}|${m.grade}`} m={m} onSelect={onSelect} />)
          : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '8px 2px' }}>no movers yet — marks refresh with each ingest</div>}
      </div>
        </div>
      </div>

      <div style={panel}>
        <SectionHead title="Card Lookup" hint="search the full Topload Card Database — every tracked card, priced or not" />
        <Screener onSelect={onSelect} />
      </div>

    </section>
  );
}
