import { useState } from 'react';
import { tokens } from '../tokens.js';
import { fmtUsd, fmtPct, PLATFORM_LABELS } from '../data/client.js';

const th = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400, font: `11px ${tokens.font.body}`, whiteSpace: 'nowrap' };
const thL = { ...th, textAlign: 'left' };
const td = { textAlign: 'right', padding: '5px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}`, whiteSpace: 'nowrap' };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}` };

export function Chip({ active, onClick, color, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? tokens.color.surfaceRaised : 'none',
      border: `1px solid ${active ? (color ?? tokens.color.inkMuted) : tokens.color.border}`,
      color: active ? tokens.color.ink : tokens.color.inkSecondary,
      borderRadius: 4, padding: '4px 11px', font: `11px ${tokens.font.body}`, cursor: 'pointer',
      whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}

const Delta = ({ pct }) => (
  <span style={{ color: pct == null ? tokens.color.inkMuted : pct >= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(pct)}</span>
);
const IpDot = ({ ip }) => (
  <span title={tokens.series[ip]?.label ?? ip} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 8, background: tokens.series[ip]?.data ?? tokens.color.inkMuted }} />
);
const Conf = ({ c }) => (
  <span style={{ color: c >= 0.6 ? tokens.color.ink : c >= 0.4 ? tokens.color.inkSecondary : tokens.color.inkMuted }}>{(c * 100).toFixed(0)}</span>
);

// A failed image load degrades to this transparent pixel — the styled frame
// stays, the browser's broken-image icon never shows.
export const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Some Phygitals ids have no '-cropped' variant on their CDN (found live:
// raw Wailmer, 2026-07-21) — retry the plain image before giving up.
export const imgFallback = (e) => {
  const el = e.currentTarget;
  if (el.src.includes('-cropped')) { el.src = el.src.replace('-cropped', ''); return; }
  el.onerror = null;
  el.src = BLANK_IMG;
};

/**
 * Card/listing thumbnail. `badge` marks images that are NOT the actual item
 * (reference art on a listing, or a borrowed slab photo on a card page) —
 * image provenance matters as much as price provenance.
 */
export const Thumb = ({ src, size = 34, badge = null }) => {
  const w = Math.round(size * 0.72);
  if (!src) return (
    <span style={{
      display: 'inline-block', height: size, width: w, borderRadius: 3,
      marginRight: 10, verticalAlign: 'middle', background: tokens.color.surfaceRaised,
      border: `1px solid ${tokens.color.border}`, flexShrink: 0,
    }} />
  );
  return (
    <span style={{ position: 'relative', display: 'inline-block', marginRight: 10, flexShrink: 0, lineHeight: 0 }}
          title={badge ? 'Reference image — not a photo of the actual item' : undefined}>
      <img src={src} alt="" loading="lazy"
           onError={imgFallback}
           style={{
        height: size, width: w, objectFit: 'contain', borderRadius: 3,
        background: tokens.color.surfaceRaised, border: `1px solid ${tokens.color.border}`,
      }} />
      {badge && (
        <span style={{
          position: 'absolute', bottom: 1, left: 1, right: 1, textAlign: 'center',
          font: `600 6.5px ${tokens.font.body}`, letterSpacing: '0.06em',
          color: tokens.color.ink, background: tokens.color.overlay,
          borderRadius: '0 0 2px 2px', padding: '1px 0',
        }}>{badge}</span>
      )}
    </span>
  );
};

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
            {/* No thumbnail here — at table-row size the art reads as noise
                (Kaleb, 2026-07-21). A desk-style thumbnail GRID view is the
                future home for browsing the database visually. */}
            <td style={{ ...tdL, display: 'flex', alignItems: 'center' }}><IpDot ip={c.ip} /><span>{c.name} <span style={{ color: tokens.color.inkMuted }}>· {c.set_name} {c.number}</span></span></td>
            {/* One row per card: top-value grade shown; the count hints at the
                full ladder waiting on the card page. */}
            <td style={tdL}>{c.grade}{c.grades_tracked > 1 && <span style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.mono}` }}> +{c.grades_tracked - 1}</span>}</td>
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

/**
 * Marketplace chips. When `hidden`/`onToggle` are provided the chips are
 * filters: every marketplace is shown by default, click one to exclude it.
 * No chain/crypto jargon on the surface — users are buying cards, not tokens.
 */
export function PlatformStrip({ platforms, hidden, onToggle }) {
  // Only marketplaces we actually pull LISTINGS from belong on the desk's
  // toggle strip (Kaleb, 2026-07-20) — sales-only sources (Beezie) feed the
  // tape + oracle silently and return here when their listings land.
  // (Phygitals graduated to the strip 2026-07-21 when its listings shipped.)
  const shown = (platforms ?? []).filter(p => p.listings)
    .toSorted((a, b) => a.name.localeCompare(b.name));   // alphabetical (Kaleb, 2026-07-21)
  if (!shown.length) return null;
  const interactive = typeof onToggle === 'function';
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
      {shown.map(p => {
        const off = hidden?.has(p.id);
        const live = p.listings || p.sales; // any real data flowing
        const suffix = off ? ' · HIDDEN' : '';
        return (
          <button key={p.id}
                  onClick={interactive ? () => onToggle(p.id) : undefined}
                  title={interactive ? (off ? `Show ${p.name}` : `Hide ${p.name}${p.listings ? ' listings & sales' : p.sales ? ' sales (listings coming)' : ''}`) : undefined}
                  style={{
                    font: `10px ${tokens.font.mono}`, padding: '3px 9px', borderRadius: 3,
                    border: off ? `1px dashed ${tokens.color.border}` : `1px solid ${live ? tokens.color.brass : tokens.color.border}`,
                    color: off ? tokens.color.inkMuted : live ? tokens.color.ink : tokens.color.inkMuted,
                    background: !off && p.listings ? tokens.color.surfaceRaised : 'none',
                    opacity: off ? 0.55 : 1, cursor: interactive ? 'pointer' : 'default',
                  }}>
            {p.name.toUpperCase()}{suffix}
          </button>
        );
      })}
    </div>
  );
}

/** Live sales tape — what actually traded, recorded first-hand (chain-verified under the hood). */
export function SalesTape({ sales, onSelect }) {
  if (!sales?.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        Live sales · recorded first-hand from the marketplaces
      </div>
      <div style={{ display: 'flex', gap: 20, overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 4, scrollbarWidth: 'thin' }}>
        {sales.filter(s => !s.is_outlier).slice(0, 15).map((s, i) => (
          <span key={i} onClick={() => onSelect?.(s.card_id)}
                style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary, cursor: 'pointer', flexShrink: 0 }}>
            <IpDot ip={s.ip} />
            <span style={{ color: tokens.color.ink }}>{s.name}</span>
            {' '}{s.grade !== 'raw' ? s.grade : ''} <span style={{ color: tokens.color.ink }}>{fmtUsd(s.price_cents)}</span>
            <span style={{ color: tokens.color.inkMuted }}> · {timeAgo(s.sold_at)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const VIEW_KEY = 'topload-gacha-view';
const HIDDEN_KEY = 'topload-hidden-platforms';
const loadHidden = () => {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')); }
  catch { return new Set(); }
};

const GACHA_SORTS = [
  ['recent', 'Recent', (a, b) => (b.listed_at ?? '').localeCompare(a.listed_at ?? '') || b.price_cents - a.price_cents],
  ['oldest', 'Oldest', (a, b) => (a.listed_at ?? '').localeCompare(b.listed_at ?? '') || b.price_cents - a.price_cents],
  ['priceHigh', 'Price ↓', (a, b) => b.price_cents - a.price_cents],
  ['priceLow', 'Price ↑', (a, b) => a.price_cents - b.price_cents],
];

// Franchise from a listing (matched rows carry ip; unmatched fall back to the
// category string, accent-insensitively — mirrors server categoryToIp).
function listingIp(l) {
  if (l.ip) return l.ip;
  const k = (l.category ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  if (k.startsWith('pokemon')) return 'PKMN';
  if (k.startsWith('onepiece')) return 'OP';
  if (k.startsWith('yugioh')) return 'YGO';
  return null;
}

const IP_FILTERS = [['', 'All'], ['PKMN', 'Pokémon'], ['OP', 'One Piece'], ['YGO', 'Yu-Gi-Oh']];

// Listing language: the title's OWN explicit declaration wins — it's the
// seller's statement about the physical card (a "Pokemon Japanese …" title
// mis-attributed to a Korean row must still read Japanese; live bug
// 2026-07-21). Matched card's language is the fallback signal.
export function listingLanguage(l) {
  const t = l.item_name ?? '';
  if (/\b(japanese|jpn)\b/i.test(t)) return 'Japanese';
  if (/\bkorean?\b/i.test(t)) return 'Korean';
  if (/\bchinese\b/i.test(t)) return 'Chinese';
  if (l.card_language) return l.card_language;
  return /\bjp\b/i.test(t) ? 'Japanese' : 'English';
}
const LANG_FILTERS = [['', 'All'], ['English', 'English'], ['Japanese', 'Japanese']];
// BGS = Beckett Grading Services — one chip covers both spellings.
// 'Raw' chip returned 2026-07-21: Phygitals brought ~2,900 ungraded singles
// to the desk (it left 2026-07-20 when every listing was a slab or pack).
const GRADER_FILTERS = [['', 'All'], ['PSA', 'PSA'], ['BGS', 'BGS/Beckett'], ['CGC', 'CGC'], ['TAG', 'TAG'], ['raw', 'Raw'], ['sealed', 'Sealed']];

// Sealed product (packs/boxes) is its own category, not "raw" — Kaleb wants a
// dedicated section eventually; for now the chip separates it and Raw stays
// honest. Rules (v2 — a title heuristic alone swept 287 graded slabs into
// Sealed, because promo cards are NAMED AFTER sealed products: "Mega Charizard
// Tin", "Prismatic Evolutions ETB"):
//   1. A graded slab is never sealed, full stop.
//   2. MNSTR sells exactly two things — slabs and packs — so ungraded MNSTR
//      IS a pack (catches keyword-less titles like "Ascended Heroes").
//   3. Otherwise, sealed keywords on an ungraded item.
export function isSealed(l) {
  if ((l.grade ?? 'raw') !== 'raw') return false;
  if (l.platform === 'mnstr') return true;
  // 'bundle' alone is NOT sealed evidence — Iron Bundle is a Pokémon
  // (live false positive, Kaleb 2026-07-21); real products say 'booster
  // bundle', which 'booster' already catches. Same trap as the tin promos.
  return /\b(booster|packs?|box|etb|elite trainer|display|blister|tins?|case)\b/i.test(l.item_name ?? '');
}

export function GachaDesk({ listings, platforms, sales, onSelect, onOpenListing }) {
  // Thumbnails are the default — the cards ARE the product; List is the opt-in.
  const [view, setView] = useState(() => localStorage.getItem(VIEW_KEY) ?? 'grid');
  const [hidden, setHidden] = useState(loadHidden);
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState('');
  const [ipFilter, setIpFilter] = useState('');
  const [graderFilter, setGraderFilter] = useState('');
  const [langFilter, setLangFilter] = useState('');
  const pickView = (v) => { setView(v); localStorage.setItem(VIEW_KEY, v); };
  const togglePlatform = (id) => {
    setHidden(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      return next;
    });
  };
  if (!listings) return <Empty label="gacha" />;
  const shownSales = sales?.filter(s => !hidden.has(s.source));
  if (!listings.length) {
    return (
      <div>
        <PlatformStrip platforms={platforms} hidden={hidden} onToggle={togglePlatform} />
        <SalesTape sales={shownSales} onSelect={onSelect} />
        <div style={{ padding: '32px 24px', color: tokens.color.inkMuted, font: `13px ${tokens.font.body}`, lineHeight: 1.7 }}>
          <div style={{ font: `18px ${tokens.font.display}`, color: tokens.color.inkSecondary, marginBottom: 8 }}>No listings yet</div>
          Listings refresh automatically with the next scheduled data pull.
        </div>
      </div>
    );
  }
  // 'first' ≡ '1st' both ways — normalize needle AND haystacks so either
  // spelling finds 1st Edition inventory (Kaleb, 2026-07-21).
  const normSearch = (s) => (s ?? '').toLowerCase().replace(/\bfirst\b/g, '1st');
  const needle = normSearch(q.trim());
  const shown = listings
    .filter(l => !hidden.has(l.platform))
    .filter(l => !ipFilter || listingIp(l) === ipFilter)
    .filter(l => !langFilter || listingLanguage(l) === langFilter)
    .filter(l => !graderFilter
      || (graderFilter === 'sealed' ? isSealed(l)
        : graderFilter === 'raw' ? (l.grade ?? 'raw') === 'raw' && !isSealed(l)
        : (l.grade ?? '').startsWith(graderFilter)))
    .filter(l => !needle
      || normSearch(l.item_name).includes(needle)
      || normSearch(l.card_name).includes(needle))
    .sort(GACHA_SORTS.find(([id]) => id === sort)[2]);
  return (
    <div>
      <PlatformStrip platforms={platforms} hidden={hidden} onToggle={togglePlatform} />
      <SalesTape sales={shownSales} onSelect={onSelect} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search listings…"
          style={{
            background: tokens.color.surface, border: `1px solid ${tokens.color.border}`,
            color: tokens.color.ink, borderRadius: 6, padding: '6px 12px', width: 230,
            font: `12px ${tokens.font.body}`, outline: 'none',
          }}
          onFocus={e => e.target.style.borderColor = tokens.color.inkMuted}
          onBlur={e => e.target.style.borderColor = tokens.color.border}
        />
        <span style={{ display: 'flex', gap: 4 }}>
          {GACHA_SORTS.map(([id, label]) => (
            <Chip key={id} active={sort === id} onClick={() => setSort(id)}>{label}</Chip>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <Chip active={view === 'grid'} onClick={() => pickView('grid')}>
            <span title="Thumbnails" style={{ fontSize: 14, lineHeight: 1 }}>⊞</span>
          </Chip>
          <Chip active={view === 'table'} onClick={() => pickView('table')}>
            <span title="List" style={{ fontSize: 14, lineHeight: 1 }}>☰</span>
          </Chip>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 4 }}>
          {IP_FILTERS.map(([id, label]) => (
            <Chip key={id || 'all-ip'} active={ipFilter === id} onClick={() => setIpFilter(id)}
                  color={id ? tokens.series[id]?.data : undefined}>{label}</Chip>
          ))}
        </span>
        <span style={{ width: 1, height: 18, background: tokens.color.border }} />
        <span style={{ display: 'flex', gap: 4 }}>
          {GRADER_FILTERS.map(([id, label]) => (
            <Chip key={id || 'all-gr'} active={graderFilter === id} onClick={() => setGraderFilter(id)}>{label}</Chip>
          ))}
        </span>
        <span style={{ width: 1, height: 18, background: tokens.color.border }} />
        <span style={{ display: 'flex', gap: 4 }}>
          {LANG_FILTERS.map(([id, label]) => (
            <Chip key={id || 'all-lang'} active={langFilter === id} onClick={() => setLangFilter(id)}>{label}</Chip>
          ))}
        </span>
      </div>
      <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginBottom: 12 }}>
        {shown.length.toLocaleString()} card listings
      </div>
      {view === 'grid' && <GachaGrid listings={shown} onSelect={onSelect}
        onOpenListing={onOpenListing ? (l) => onOpenListing(l, shown) : undefined} />}
      {view === 'table' && <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%', tableLayout: 'fixed' }}>
        <colgroup>
          <col /><col style={{ width: 76 }} /><col style={{ width: 86 }} />
          <col style={{ width: 100 }} /><col style={{ width: 96 }} /><col style={{ width: 86 }} />
        </colgroup>
        <thead><tr>
          <th style={thL}>Listing</th><th style={thL}>Grade</th><th style={th}>Ask</th>
          <th style={th}>Oracle comp</th><th style={th}>Δ vs comp</th><th style={th}>Comp conf</th>
        </tr></thead>
        <tbody>
          {shown.slice(0, 250).map(l => (
            <tr key={`${l.platform}|${l.external_id}`}
                onClick={onOpenListing ? () => onOpenListing(l, shown)
                  : l.card_id ? () => onSelect?.(l.card_id)
                  : listingUrl(l) ? () => window.open(listingUrl(l), '_blank', 'noopener') : undefined}
                style={{ cursor: 'pointer' }}>
              <td style={{ ...tdL, display: 'flex', alignItems: 'center', minWidth: 0 }} title={l.item_name}>
                <Thumb src={l.image} size={42} badge={l.image_kind === 'art' ? 'NOT ITEM' : null} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.ip && <IpDot ip={l.ip} />}{l.item_name}
                  {l.card_name && <span style={{ color: tokens.color.inkMuted }}> → {l.card_name}</span>}
                </span>
              </td>
              <td style={tdL}>{l.grade}</td>
              <td style={td}>{fmtUsd(l.price_cents)}</td>
              <td style={td}>{l.comp_cents && !l.comp_suspect ? fmtUsd(l.comp_cents) : '—'}</td>
              <td style={td}>{l.delta_pct != null
                ? <span style={{ color: l.delta_pct <= 0 ? tokens.color.up : tokens.color.down }}>{fmtPct(l.delta_pct)}</span>
                : l.comp_suspect
                  ? <span style={{ color: tokens.color.inkMuted }} title="Comp exists but is wildly out of line with the ask — not shown until we trust it">comp suspect</span>
                  : <span style={{ color: tokens.color.inkMuted }}>no comp</span>}</td>
              <td style={td}>{l.comp_confidence != null ? <Conf c={l.comp_confidence} /> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > 250 && (
        <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, padding: '10px 12px' }}>
          showing first 250 of {shown.length.toLocaleString()} — search or filter to narrow
        </div>
      )}
      </div>}
    </div>
  );
}

/**
 * Outbound listing URL per marketplace (verified live 2026-07-20: CC's router
 * is /assets/:blockchain/:cardAddress). Research stays here; buying happens
 * on the marketplace — unmatched listings open this directly.
 */
export function listingUrl(l) {
  if (l.platform === 'collectorcrypt' && l.nft_address) {
    return `https://collectorcrypt.com/assets/solana/${l.nft_address}`;
  }
  if (l.platform === 'courtyard' && l.proof) {
    return `https://courtyard.io/asset/${l.proof}`;
  }
  if (l.platform === 'mnstr' && l.proof) {   // proof column carries the card slug
    return `https://mnstr.xyz/cards/${l.proof}`;
  }
  if (l.platform === 'phygitals' && l.proof) { // proof column carries the card slug
    return `https://www.phygitals.com/card/${l.proof}`;
  }
  return null;
}

/** Thumbnail grid — slabs as visual merchandise. Hover lift via injected CSS
 *  (inline styles can't express :hover); colors ride the theme CSS vars. */
const GRID_CSS = `
.tl-gacha-card { transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
.tl-gacha-card:hover { transform: translateY(-2px); border-color: ${tokens.color.inkMuted}; box-shadow: 0 4px 14px rgba(0,0,0,0.12); }
`;

const GRID_PAGE = 120;

function GachaGrid({ listings, onSelect, onOpenListing }) {
  // Render in pages — 1,800+ cards at once makes every refresh feel slow
  // regardless of API speed. Count resets when the filtered list changes.
  const [shown, setShown] = useState(GRID_PAGE);
  const visible = listings.slice(0, shown);
  return (
    <div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
      <style>{GRID_CSS}</style>
      {visible.map(l => {
        const url = listingUrl(l);
        return (
        <div key={`${l.platform}|${l.external_id}`}
             className="tl-gacha-card"
             onClick={onOpenListing ? () => onOpenListing(l)
               : l.card_id ? () => onSelect?.(l.card_id)
               : url ? () => window.open(url, '_blank', 'noopener') : undefined}
             title={l.item_name}
             style={{
               border: `1px solid ${tokens.color.border}`, borderRadius: 8, overflow: 'hidden',
               background: tokens.color.surface, cursor: onOpenListing || l.card_id || url ? 'pointer' : 'default',
               display: 'flex', flexDirection: 'column',
             }}>
          <div style={{ position: 'relative', aspectRatio: '3/4', background: tokens.color.surfaceRaised }}>
            {l.image
              ? <img src={l.image} alt="" loading="lazy" onError={imgFallback} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.color.inkMuted, font: `10px ${tokens.font.body}` }}>no photo</div>}
            {l.image && l.image_kind === 'art' && (
              <span style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
                font: `600 8px ${tokens.font.body}`, letterSpacing: '0.06em',
                color: tokens.color.ink, background: tokens.color.overlay, padding: '2px 0',
              }}>NOT ITEM · REFERENCE ART</span>
            )}
            <span style={{
              position: 'absolute', top: 6, left: 6, font: `10px ${tokens.font.mono}`,
              color: tokens.color.ink, background: tokens.color.overlay,
              borderRadius: 3, padding: '2px 6px',
            }}>{((l.grade ?? 'raw') === 'raw' && isSealed(l) ? 'sealed' : l.grade) + (listingLanguage(l) === 'Japanese' ? ' · JP' : '')}</span>
          </div>
          <div style={{ padding: '8px 10px 9px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ font: `13px ${tokens.font.mono}`, color: tokens.color.ink }}>{fmtUsd(l.price_cents)}</span>
              {l.delta_pct != null && (
                <span style={{ font: `10px ${tokens.font.mono}`, color: l.delta_pct <= 0 ? tokens.color.up : tokens.color.down }}>
                  {fmtPct(l.delta_pct)}
                </span>
              )}
            </div>
            <div style={{
              font: `10px ${tokens.font.body}`, color: tokens.color.inkSecondary,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{l.card_name ?? l.item_name}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, marginTop: 'auto' }}>
              <span>{l.comp_cents && !l.comp_suspect ? `comp ${fmtUsd(l.comp_cents)}` : l.comp_suspect ? 'comp suspect' : 'no comp'}</span>
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer"
                   onClick={e => e.stopPropagation()}
                   title={`View this listing on ${PLATFORM_LABELS[l.platform] ?? l.platform}`}
                   style={{ whiteSpace: 'nowrap', color: tokens.color.inkMuted, textDecoration: 'none' }}>
                  {PLATFORM_LABELS[l.platform] ?? l.platform} ↗
                </a>
              ) : (
                <span style={{ whiteSpace: 'nowrap' }}>{PLATFORM_LABELS[l.platform] ?? l.platform}</span>
              )}
            </div>
          </div>
        </div>
        );
      })}
    </div>
    {listings.length > shown && (
      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <button onClick={() => setShown(s => s + GRID_PAGE)} style={{
          background: tokens.color.surfaceRaised, border: `1px solid ${tokens.color.inkMuted}`,
          color: tokens.color.ink, borderRadius: 4, padding: '9px 26px',
          font: `12px ${tokens.font.body}`, cursor: 'pointer',
        }}>Show more · {Math.min(GRID_PAGE, listings.length - shown)} of {(listings.length - shown).toLocaleString()} remaining</button>
      </div>
    )}
    </div>
  );
}

function Empty({ label }) {
  return <div style={{ color: tokens.color.inkMuted, padding: 24, font: `13px ${tokens.font.body}` }}>No {label} data — run `npm run ingest` and start the API.</div>;
}
