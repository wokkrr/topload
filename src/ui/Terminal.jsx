import { tokens } from '../tokens.js';
import { MoversTable, BasketTable, Chip } from './tables.jsx';
import { Screener } from './Screener.jsx';
import { IndexChart } from './IndexChart.jsx';

/**
 * The Terminal tab — one dashboard replacing the old Cards / Movers / Basket
 * tabs (Kaleb, 2026-07-20: "combine them into one singular tab… keep things
 * simple"). Three stacked sections, each with a one-line explanation so the
 * surface reads instantly: franchise indexes (chart), market pulse (movers +
 * basket constituents side by side), and the card lookup (full screener).
 */

const RANGES = [7, 30, 90];

function SectionHead({ title, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '0 0 10px' }}>
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
  flex: '1 1 420px', minWidth: 0,
};

export function Terminal({
  indexes, days, setDays,
  movers, basket, basketIp, setBasketIp,
  onSelect,
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>

      {/* 1. Franchise indexes — the market at a glance. */}
      <div style={{ ...panel, flex: 'none' }}>
        <SectionHead title="Indexes" hint="liquidity-weighted franchise benchmarks · base 100" />
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {RANGES.map(r => (
            <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>
          ))}
        </div>
        <IndexChart data={indexes} />
      </div>

      {/* 2. Market pulse — movers and basket constituents side by side. */}
      <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={panel}>
          <SectionHead title="Movers · 24h" hint="biggest one-day moves among cards with live marks" />
          <MoversTable movers={movers?.slice(0, 10)} onSelect={onSelect} />
        </div>
        <div style={panel}>
          <SectionHead title="Basket" hint="index constituents · top by 90D volume, monthly rebalance" />
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {Object.entries(tokens.series).map(([id, s]) => (
              <Chip key={id} active={basketIp === id} onClick={() => setBasketIp(id)} color={s.data}>{s.label}</Chip>
            ))}
          </div>
          <BasketTable basket={basket?.slice(0, 10)} onSelect={onSelect} />
        </div>
      </div>

      {/* 3. Card lookup — the full screener over the whole universe. */}
      <div style={{ ...panel, flex: 'none' }}>
        <SectionHead title="Card Lookup" hint="search the full Topload Card Database — every tracked card, priced or not" />
        <Screener onSelect={onSelect} />
      </div>

    </section>
  );
}
