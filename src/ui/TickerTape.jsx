import { useEffect, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct } from '../data/client.js';

/**
 * Always-visible market strip — index levels + top movers, crypto-ticker style.
 * Click a mover → card page.
 */
export function TickerTape({ onSelect }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    // Index levels intentionally omitted (Kaleb: keep it simple; indexes are
    // benched for now) — the strip is movers-only and hides when empty.
    api.movers(1).then((movers) => {
      const out = [];
      for (const m of movers.slice(0, 12)) {
        out.push({
          key: `${m.card_id}|${m.grade}`,
          label: `${shortName(m.name)} ${m.grade === 'raw' ? '' : m.grade}`.trim(),
          value: fmtUsd(m.price_now),
          pct: m.change_pct,
          card_id: m.card_id,
        });
      }
      setItems(out);
    }).catch(() => setItems([]));
  }, []);

  if (!items?.length) return null;
  return (
    <div style={{
      display: 'flex', gap: 28, overflowX: 'auto', whiteSpace: 'nowrap',
      padding: '7px 28px', borderBottom: `1px solid ${tokens.color.border}`,
      background: tokens.color.surface, scrollbarWidth: 'none',
    }}>
      {items.map(it => (
        <span key={it.key}
              onClick={it.card_id ? () => onSelect(it.card_id) : undefined}
              style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary, cursor: it.card_id ? 'pointer' : 'default', flexShrink: 0 }}>
          {it.color && <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: it.color, marginRight: 6, verticalAlign: 'baseline' }} />}
          <span style={{ color: tokens.color.ink }}>{it.label}</span>
          {' '}{it.value}{' '}
          <span style={{ color: it.pct >= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(it.pct)}</span>
        </span>
      ))}
    </div>
  );
}

function shortName(name) {
  return name.replace(/\s*\((Alt Art|Alt|Manga Art|Manga|SIR)\)\s*/i, '').split(' ').slice(0, 2).join(' ').toUpperCase();
}
