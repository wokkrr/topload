import { useEffect, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, PLATFORM_LABELS } from '../data/client.js';
import { Chip, Thumb, BasketTable, ORACLE_HINT } from './tables.jsx';
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

/** Tiny inline price sparkline — the shape of the move, not just its size. */
function Spark({ points, up }) {
  if (!points || points.length < 2) return <span style={{ width: 44 }} />;
  const w = 44, h = 16;
  const lo = Math.min(...points), hi = Math.max(...points);
  const y = (v) => hi === lo ? h / 2 : h - 1 - ((v - lo) / (hi - lo)) * (h - 2);
  const x = (i) => (i / (points.length - 1)) * (w - 2) + 1;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join('');
  return (
    <svg width={w} height={h} style={{ flex: 'none' }} aria-hidden>
      <path d={d} fill="none" stroke={up ? tokens.color.up : tokens.color.down} strokeWidth="1.5" />
    </svg>
  );
}

/**
 * One mover — visual, but no magnitude wash. The row-width bar scaled to the
 * day's biggest move failed exactly when the list was busiest: clustered
 * moves pegged every bar at ~100% and the panel became a green wall (Kaleb,
 * 2026-07-22). Rank + sparkline + the bold Δ carry the signal; a thin left
 * accent gives direction at a glance.
 */
function MoverRow({ m, onSelect }) {
  const up = (m.change_pct ?? 0) >= 0;
  const accent = m.change_pct == null ? tokens.color.border : up ? tokens.color.up : tokens.color.down;
  return (
    <div onClick={() => onSelect?.(m.card_id)} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px 8px 9px',
      borderTop: `1px solid ${tokens.color.border}`, boxShadow: `inset 3px 0 0 ${accent}`,
      cursor: 'pointer', minWidth: 0, overflow: 'hidden',
    }}>
      <Thumb src={m.image} size={34} />
      <span style={{
        flex: 'none', width: 8, height: 8, borderRadius: 2,
        background: tokens.series[m.ip]?.data ?? tokens.color.inkMuted,
      }} title={tokens.series[m.ip]?.label ?? m.ip} />
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
        <span style={{
          display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          font: `13px ${tokens.font.body}`,
        }}>{m.name}</span>
        <span style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
          {m.grade} · {fmtUsd(m.price_then)} → {fmtUsd(m.price_now)}
        </span>
      </span>
      <Spark points={m.spark} up={up} />
      <span style={{
        flex: 'none', width: 66, textAlign: 'right', font: `600 15px ${tokens.font.mono}`,
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

/**
 * One index, one number. Game name + window return, colored; sparkline as
 * texture, not furniture. Click = the receipts (chart focus + constituents).
 * Unpublished indexes say so in plain words instead of faking a line.
 */
function IndexTile({ d, id, active, onClick }) {
  const s = tokens.series[id] ?? { label: id, data: tokens.color.ink };
  const series = d?.series ?? [];
  const ret = series.length >= 2 ? +(series[series.length - 1].value - series[0].value).toFixed(1) : null;
  const up = (ret ?? 0) >= 0;
  const publishable = d?.published !== false && ret != null;
  return (
    <button onClick={onClick}
      onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = s.data; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = tokens.color.border; }}
      style={{
        flex: '0 1 170px', minWidth: 140, textAlign: 'left', cursor: 'pointer',
        background: active ? tokens.color.surfaceRaised : 'none',
        border: `1px solid ${active ? s.data : tokens.color.border}`, borderRadius: 8,
        padding: '10px 12px', color: tokens.color.ink, transition: 'border-color .12s ease',
      }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: `11px ${tokens.font.body}`, color: tokens.color.inkSecondary }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: s.data, display: 'inline-block' }} />
        {s.label}
      </span>
      {/* One number, nothing else — the sublines read as clutter (Kaleb). */}
      {publishable ? (
        <span style={{ display: 'block', font: `600 26px ${tokens.font.mono}`, margin: '4px 0 0', color: up ? tokens.color.up : tokens.color.down }}>
          {up ? '+' : ''}{ret}%
        </span>
      ) : (
        <span style={{ display: 'block', font: `600 18px ${tokens.font.mono}`, margin: '7px 0 1px', color: tokens.color.inkMuted, textTransform: 'uppercase' }}>building</span>
      )}
    </button>
  );
}

export function Terminal({ indexes, days, setDays, movers, onSelect, onOpenListing }) {
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
        <SectionHead title="The Market" />

        {/* ── Apple pass (Kaleb, 2026-07-21: "small and clunky… simple is
            always better"): three tiles, one number each. The window return
            IS the story; everything else lives a click deeper. ── */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {['PKMN', 'OP', 'YGO'].map(id => (
            <IndexTile key={id} d={meta(id)} id={id}
                       active={view === id} onClick={() => setView(v => v === id ? 'chart' : id)} />
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
            {RANGES.map(r => (
              <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>
            ))}
          </span>
        </div>

        {/* Locked frame: the panel never grows on tile click — the content
            below the tiles scrolls inside instead (Kaleb, 2026-07-21). */}
        <div style={{ maxHeight: 460, overflowY: 'auto' }}>
          <IndexChart data={view === 'chart' ? indexes : (indexes ?? []).filter(d => d.index_id === view)} />

          {/* Constituents live BEHIND the tile click — receipts on demand. */}
          {view !== 'chart' && (
            <div style={{ marginTop: 14 }}>
              <div style={{ font: `12px ${tokens.font.mono}`, color: tokens.color.inkSecondary, margin: '4px 0 8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                The {meta(view)?.members ?? ''} cards behind this number
              </div>
              {meta(view)?.published === false && (
                <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, marginBottom: 8 }}>
                  This index publishes at {meta(view)?.min_members ?? 8} actively-traded cards ({meta(view)?.members ?? 0} now) — the basket below is filling as history builds.
                </div>
              )}
              {baskets[view]
                ? (baskets[view].length
                    ? <>
                        <BasketSummary basket={baskets[view]} />
                        <BasketTable basket={baskets[view]} onSelect={onSelect} maxHeight={null} />
                      </>
                    : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>No constituents yet — this basket fills as sales history builds.</div>)
                : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>Loading…</div>}
            </div>
          )}
        </div>
      </div>
        </div>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
      <div style={{ ...panel, height: '100%' }}>
        {/* 7D window + solds-only (Kaleb, 2026-07-22): cards trade weekly,
            and only real sales can move a market — estimates never chart. */}
        <SectionHead title="Movers · 7D" hint="biggest seven-day moves among cards priced from real sales" />
        {movers?.length
          ? movers.slice(0, 8).map(m => <MoverRow key={`${m.card_id}|${m.grade}`} m={m} onSelect={onSelect} />)
          : <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '8px 2px' }}>no movers yet — marks refresh with each ingest</div>}
      </div>
        </div>
      </div>

      <div style={panel}>
        <SectionHead title="Value Pulse"
          hint="experimental value driven insight - live asks sitting under the price oracle mark" />
        <DealsPanel onOpenListing={onOpenListing} onSelect={onSelect} />
      </div>

    </section>
  );
}

/**
 * Value Pulse (Kaleb, 2026-07-21: "let's test out something like that") —
 * ask-vs-mark discounts with liquidity context beside every one: a discount
 * without an exit is a trap, so sales/30D rides along.
 */
function DealsPanel({ onOpenListing, onSelect }) {
  const [deals, setDeals] = useState(null);
  useEffect(() => { api.deals(15).then(setDeals).catch(() => setDeals([])); }, []);
  if (!deals) return <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>Scanning the desks…</div>;
  if (!deals.length) {
    return <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, padding: '6px 2px' }}>
      No qualifying deals right now — the radar only fires on grade-matched marks with real confidence, so quiet is honest.
    </div>;
  }
  return (
    <div>
      {/* No magnitude wash (same fix as Movers, Kaleb 2026-07-22): clustered
          discounts pegged every row-bar at ~full width. Rank + the bold −%
          carry it; solds-backed rows get the green accent, estimates stay
          neutral — the accent now encodes mark QUALITY, not size. */}
      {deals.map((d, i) => (
        <div key={`${d.platform}|${d.external_id}`}
             onClick={() => onOpenListing ? onOpenListing({ platform: d.platform, external_id: d.external_id }) : onSelect?.(d.card_id)}
             style={{
               display: 'flex', alignItems: 'center', gap: 12, padding: '8px 6px 8px 9px',
               borderTop: `1px solid ${tokens.color.border}`,
               boxShadow: `inset 3px 0 0 ${d.basis === 'solds' ? tokens.color.up : tokens.color.border}`,
               cursor: 'pointer', minWidth: 0, overflow: 'hidden',
             }}>
          <span style={{ flex: 'none', width: 18, textAlign: 'right', color: tokens.color.inkMuted, font: `11px ${tokens.font.mono}` }}>{i + 1}</span>
          <Thumb src={d.image} size={34} />
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `13px ${tokens.font.body}` }}>
              {d.card_name} <span style={{ color: tokens.color.inkMuted }}>· {d.set_name} {d.number}</span>
            </span>
            <span style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
              {d.grade} · {PLATFORM_LABELS[d.platform] ?? d.platform}
              {d.sales_30d > 0
                ? ` · ${d.sales_30d} sale${d.sales_30d === 1 ? '' : 's'}/30D`
                : ' · thin trading'}
              {/* Mark provenance in plain words (Kaleb, 2026-07-22: "solds-
                  backed mark" was terminal-user-hostile): a discount against
                  real sales is a different animal than one vs an estimate. */}
              <span style={{ color: d.basis === 'solds' ? tokens.color.up : tokens.color.inkMuted }}>
                {d.basis === 'solds' ? ' · value from real sales' : ' · estimated value'}
              </span>
            </span>
          </span>
          <span style={{ flex: 'none', textAlign: 'right', font: `12px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
            <span style={{ display: 'block', color: tokens.color.ink }}>{fmtUsd(d.ask_cents)} ask</span>
            <span style={{ color: tokens.color.inkMuted }} title={ORACLE_HINT}>{fmtUsd(d.mark_cents)} value</span>
          </span>
          <span style={{
            flex: 'none', width: 74, textAlign: 'right',
            font: `600 16px ${tokens.font.mono}`, color: tokens.color.up,
          }}>−{d.discount_pct}%</span>
        </div>
      ))}
    </div>
  );
}

/** CARDS tab — the Topload Card Database gets its own home (nav restructure). */
export function CardsPage({ onSelect }) {
  return (
    <section>
      <div style={panel}>
        <SectionHead title="Card Database" hint="search every tracked card across Pokémon, One Piece, and Yu-Gi-Oh — priced or not" />
        <Screener onSelect={onSelect} />
      </div>
    </section>
  );
}
