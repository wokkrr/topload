import { tokens } from '../tokens.js';
import { fmtUsd, fmtPct } from '../data/client.js';

const th = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400, font: `11px ${tokens.font.body}`, whiteSpace: 'nowrap' };
const thL = { ...th, textAlign: 'left' };
const td = { textAlign: 'right', padding: '5px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}`, whiteSpace: 'nowrap' };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}` };

const Delta = ({ pct }) => (
  <span style={{ color: pct == null ? tokens.color.inkMuted : pct >= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(pct)}</span>
);
const IpDot = ({ ip }) => (
  <span title={tokens.series[ip]?.label ?? ip} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 8, background: tokens.series[ip]?.data ?? tokens.color.inkMuted }} />
);
const Conf = ({ c }) => (
  <span style={{ color: c >= 0.6 ? tokens.color.ink : c >= 0.4 ? tokens.color.inkSecondary : tokens.color.inkMuted }}>{(c * 100).toFixed(0)}</span>
);

export function MoversTable({ movers, onSelect }) {
  if (!movers?.length) return <Empty label="movers" />;
  return (
    <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
      <thead><tr>
        <th style={thL}>Card</th><th style={thL}>Grade</th><th style={th}>Mark</th>
        <th style={th}>Δ1D</th><th style={th}>Sales/7D</th><th style={th}>Conf</th>
      </tr></thead>
      <tbody>
        {movers.map(m => (
          <tr key={`${m.card_id}|${m.grade}`} onClick={() => onSelect?.(m.card_id)} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <td style={tdL}><IpDot ip={m.ip} />{m.name} <span style={{ color: tokens.color.inkMuted }}>· {m.set_name}</span></td>
            <td style={tdL}>{m.grade}</td>
            <td style={td}>{fmtUsd(m.price_now)}</td>
            <td style={td}><Delta pct={m.change_pct} /></td>
            <td style={td}>{m.sales_7d}</td>
            <td style={td}><Conf c={m.confidence} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BasketTable({ basket, onSelect }) {
  if (!basket?.length) return <Empty label="basket" />;
  return (
    <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
      <thead><tr>
        <th style={thL}>Card</th><th style={thL}>Grade</th><th style={th}>Weight</th><th style={th}>Mark</th>
        <th style={th}>Δ1D</th><th style={th}>Δ30D</th><th style={th}>Sales/7D</th><th style={th}>Conf</th>
      </tr></thead>
      <tbody>
        {basket.map(b => (
          <tr key={`${b.card_id}|${b.grade}`} onClick={() => onSelect?.(b.card_id)} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <td style={tdL}>{b.name} <span style={{ color: tokens.color.inkMuted }}>· {b.set_name} {b.number}</span></td>
            <td style={tdL}>{b.grade}</td>
            <td style={td}>{(b.weight * 100).toFixed(1)}%</td>
            <td style={td}>{fmtUsd(b.price_cents)}</td>
            <td style={td}><Delta pct={b.change_1d_pct} /></td>
            <td style={td}><Delta pct={b.change_30d_pct} /></td>
            <td style={td}>{b.sales_7d ?? '—'}</td>
            <td style={td}><Conf c={b.confidence ?? 0} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CardsTable({ cards, onSelect }) {
  if (!cards?.length) return <Empty label="card" />;
  return (
    <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
      <thead><tr>
        <th style={thL}>Card</th><th style={thL}>Grade</th><th style={th}>Mark</th>
        <th style={th}>Δ1D</th><th style={th}>Δ30D</th><th style={th}>Conf</th><th style={thL}>Basis</th>
      </tr></thead>
      <tbody>
        {cards.map(c => (
          <tr key={`${c.card_id}|${c.grade}`} onClick={() => onSelect?.(c.card_id)} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <td style={tdL}><IpDot ip={c.ip} />{c.name} <span style={{ color: tokens.color.inkMuted }}>· {c.set_name} {c.number}</span></td>
            <td style={tdL}>{c.grade}</td>
            <td style={td}>{fmtUsd(c.price_cents)}</td>
            <td style={td}><Delta pct={c.change_1d_pct} /></td>
            <td style={td}><Delta pct={c.change_30d_pct} /></td>
            <td style={td}><Conf c={c.confidence} /></td>
            <td style={{ ...tdL, color: c.basis === 'solds' ? tokens.color.up : tokens.color.inkSecondary, font: `11px ${tokens.font.mono}` }}>
              {c.basis === 'solds' ? 'solds' : `ext·${(c.source ?? '?').slice(0, 4)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlatformStrip({ platforms }) {
  if (!platforms?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {platforms.map(p => (
        <span key={p.id} title={`${p.chain} — ${p.access}`} style={{
          font: `10px ${tokens.font.mono}`, padding: '3px 9px', borderRadius: 3,
          border: `1px solid ${p.status === 'live' ? tokens.color.brass : tokens.color.border}`,
          color: p.status === 'live' ? tokens.color.ink : tokens.color.inkMuted,
          background: p.status === 'live' ? tokens.color.surfaceRaised : 'none',
        }}>
          {p.name.toUpperCase()} <span style={{ opacity: 0.7 }}>· {p.chain.split(' ')[0]}</span>
          {p.status === 'live' ? ' ● LIVE' : p.status === 'next' ? ' · NEXT' : ' · RECON'}
        </span>
      ))}
    </div>
  );
}

export function GachaDesk({ listings, platforms, onSelect }) {
  if (!listings) return <Empty label="gacha" />;
  if (!listings.length) {
    return (
      <div>
        <PlatformStrip platforms={platforms} />
        <div style={{ padding: '32px 24px', color: tokens.color.inkMuted, font: `13px ${tokens.font.body}`, lineHeight: 1.7 }}>
          <div style={{ font: `18px ${tokens.font.display}`, color: tokens.color.inkSecondary, marginBottom: 8 }}>No gacha listings yet</div>
          Run `npm run ingest` — live mode pulls current Collector Crypt listings (Pokémon + One Piece slabs).
        </div>
      </div>
    );
  }
  const matched = listings.filter(l => l.delta_pct != null);
  return (
    <div>
      <PlatformStrip platforms={platforms} />
      <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginBottom: 12 }}>
        {listings.length} live listings · {matched.length} with grade-matched oracle comps ·
        asking prices, never oracle input
      </div>
      <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
        <thead><tr>
          <th style={thL}>Listing</th><th style={thL}>Grade</th><th style={th}>Ask</th>
          <th style={th}>Oracle comp</th><th style={th}>Δ vs comp</th><th style={th}>Comp conf</th>
        </tr></thead>
        <tbody>
          {listings.map(l => (
            <tr key={`${l.platform}|${l.external_id}`}
                onClick={l.card_id ? () => onSelect?.(l.card_id) : undefined}
                style={{ cursor: l.card_id ? 'pointer' : 'default' }}>
              <td style={tdL}>
                {l.ip && <IpDot ip={l.ip} />}{l.item_name}
                {l.card_name && <span style={{ color: tokens.color.inkMuted }}> → {l.card_name}</span>}
              </td>
              <td style={tdL}>{l.grade}</td>
              <td style={td}>{fmtUsd(l.price_cents)}</td>
              <td style={td}>{l.comp_cents ? fmtUsd(l.comp_cents) : '—'}</td>
              <td style={td}>{l.delta_pct != null
                ? <span style={{ color: l.delta_pct <= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(l.delta_pct)}</span>
                : <span style={{ color: tokens.color.inkMuted }}>no comp</span>}</td>
              <td style={td}>{l.comp_confidence != null ? <Conf c={l.comp_confidence} /> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ label }) {
  return <div style={{ color: tokens.color.inkMuted, padding: 24, font: `13px ${tokens.font.body}` }}>No {label} data — run `npm run ingest` and start the API.</div>;
}
