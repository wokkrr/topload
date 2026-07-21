import { useEffect, useMemo, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct } from '../data/client.js';

/**
 * The tape (Kaleb, 2026-07-21: "reminiscent of a trading terminal… give it
 * more life — glanced at, they all look the same"). Three fixes:
 *
 *   1. MIXED FEED — index levels lead, then movers interleaved with real
 *      SOLDS. A tape that only shows one instrument type reads as wallpaper;
 *      variety is what makes a terminal tape legible.
 *   2. FRANCHISE COLOR on every item (the series dot) + ▲▼ direction glyphs —
 *      a glance now says WHAT game and WHICH way.
 *   3. IT MOVES — continuous marquee (duplicated content, seamless loop),
 *      pauses on hover so items stay clickable; static fallback for
 *      prefers-reduced-motion.
 */
export function TickerTape({ onSelect }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    Promise.allSettled([api.indexes(7), api.movers(1), api.recentSales()])
      .then(([ix, mv, sl]) => {
        const out = [];
        // Index levels first — the market's headline, in franchise color.
        for (const d of (ix.value ?? [])) {
          if (d.published === false || !d.series?.length) continue;
          const last = d.series[d.series.length - 1].value;
          out.push({
            key: `ix-${d.index_id}`, type: 'INDEX',
            ip: d.index_id, label: `${tokens.series[d.index_id]?.label ?? d.index_id} INDEX`,
            value: last.toFixed(1), pct: +(last - 100).toFixed(1),
          });
        }
        // Movers and real solds interleaved — motion and receipts, alternating.
        const movers = (mv.value ?? []).slice(0, 10).map(m => ({
          key: `mv-${m.card_id}|${m.grade}`, type: 'MOVE',
          ip: m.ip, label: `${shortName(m.name)} ${m.grade === 'raw' ? '' : m.grade}`.trim(),
          value: fmtUsd(m.price_now), pct: m.change_pct, card_id: m.card_id,
        }));
        const solds = (sl.value ?? []).slice(0, 8).map((s, i) => ({
          key: `sl-${i}-${s.card_id}`, type: 'SOLD',
          ip: s.ip, label: `${shortName(s.name)} ${s.grade === 'raw' ? '' : s.grade}`.trim(),
          value: fmtUsd(s.price_cents), pct: null, card_id: s.card_id,
        }));
        const n = Math.max(movers.length, solds.length);
        for (let i = 0; i < n; i++) {
          if (movers[i]) out.push(movers[i]);
          if (solds[i]) out.push(solds[i]);
        }
        setItems(out);
      })
      .catch(() => setItems([]));
  }, []);

  // Loop duration scales with content so density never changes the pace.
  const duration = useMemo(() => Math.max(30, (items?.length ?? 0) * 4), [items]);

  if (!items?.length) return null;
  const renderItem = (it, dup) => (
    <span key={`${it.key}${dup ? '-b' : ''}`}
          onClick={it.card_id ? () => onSelect(it.card_id) : undefined}
          style={{
            font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary,
            cursor: it.card_id ? 'pointer' : 'default', flexShrink: 0,
            textTransform: 'uppercase', marginRight: 34,
          }}>
      <span style={{
        display: 'inline-block', width: 7, height: 7, borderRadius: 2,
        background: tokens.series[it.ip]?.data ?? tokens.color.inkMuted, marginRight: 6,
      }} />
      {it.type === 'SOLD' && <span style={{ color: tokens.color.brass, marginRight: 5 }}>SOLD</span>}
      <span style={{ color: tokens.color.ink }}>{it.label}</span>
      {' '}{it.value}
      {it.pct != null && (
        <span style={{ color: it.pct >= 0 ? tokens.color.up : tokens.color.down, marginLeft: 5 }}>
          {it.pct >= 0 ? '▲' : '▼'} {fmtPct(it.pct).replace('+', '')}
        </span>
      )}
    </span>
  );
  return (
    <div className="tl-tape" style={{
      overflow: 'hidden', whiteSpace: 'nowrap',
      padding: '7px 0', borderBottom: `1px solid ${tokens.color.border}`,
      background: tokens.color.surface,
    }}>
      <style>{`
        @keyframes tl-tape-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .tl-tape-inner { display: inline-flex; animation: tl-tape-scroll ${duration}s linear infinite; will-change: transform; }
        .tl-tape:hover .tl-tape-inner { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) {
          .tl-tape-inner { animation: none; }
          .tl-tape { overflow-x: auto; }
        }
      `}</style>
      <div className="tl-tape-inner">
        {items.map(it => renderItem(it, false))}
        {/* Second copy makes the loop seamless — the -50% keyframe lands
            exactly where copy two began. */}
        {items.map(it => renderItem(it, true))}
      </div>
    </div>
  );
}

function shortName(name) {
  return (name ?? '')
    .replace(/\s*[[(](Alt Art|Alternate Art|Alt|Manga Art|Manga|Reverse Holo|SIR)[\])]\s*/i, ' ')
    .trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
}
