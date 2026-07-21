import { useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct, PLATFORM_LABELS } from '../data/client.js';
import { smoothPath } from './chart-utils.js';

const W = 860, H = 280, PAD = { t: 16, r: 24, b: 28, l: 56 };

const DETAIL_CSS = `
.tl-buy-link { transition: border-color .12s ease, background .12s ease; }
.tl-buy-link:hover { border-color: ${tokens.color.inkMuted}; }
.tl-back:hover { color: ${tokens.color.ink}; }
`;

/**
 * Card research page (Cards/Movers/Basket route in): thin wrapper around
 * CardResearch, which is also embedded inline by ListingDetail — one research
 * module, two homes.
 */
export function CardDetail({ cardId, onBack, onOpenCard }) {
  return (
    <section>
      <style>{DETAIL_CSS}</style>
      <button onClick={onBack} className="tl-back" style={backStyle}>← back</button>
      <CardResearch cardId={cardId} onOpenCard={onOpenCard} />
    </section>
  );
}

/**
 * Card research module: per-grade oracle chart with provenance-aware rendering
 * (solid = solds-based marks, dashed + open markers = external bootstrap),
 * stat row, per-grade table, and panels. `embedded` drops the image + title
 * (the host page already shows them); `initialGrade` preselects the listing's
 * grade so ask-vs-mark lines up.
 */
export function CardResearch({ cardId, initialGrade = null, embedded = false, onOpenCard = null }) {
  const [card, setCard] = useState(null);
  const [grade, setGrade] = useState(null);
  const [days, setDays] = useState(90);
  const [series, setSeries] = useState(null);
  const [sales, setSales] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api.cardSales(cardId).then(setSales).catch(() => setSales([])); }, [cardId]);

  useEffect(() => {
    api.card(cardId).then(c => {
      setCard(c);
      setGrade(g => {
        if (g && c.grades.some(x => x.grade === g)) return g;
        if (initialGrade && c.grades.some(x => x.grade === initialGrade)) return initialGrade;
        return c.grades[0]?.grade ?? 'raw';
      });
    }).catch(e => setErr(String(e)));
  }, [cardId, initialGrade]);

  useEffect(() => {
    if (!grade) return;
    api.cardSeries(cardId, grade, days).then(setSeries).catch(e => setErr(String(e)));
  }, [cardId, grade, days]);

  if (err) return <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}`, textTransform: 'uppercase' }}>{err}</div>;
  if (!card) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>Loading…</div>;

  const cur = card.grades.find(g => g.grade === grade);
  const seriesColor = tokens.series[card.ip]?.data ?? tokens.color.ink;

  // Range stats from the loaded window (token-page style).
  const range = series?.length ? {
    hi: Math.max(...series.map(p => p.price_cents)),
    lo: Math.min(...series.map(p => p.price_cents)),
    d7: series.length > 7 ? +((series[series.length - 1].price_cents / series[series.length - 8].price_cents - 1) * 100).toFixed(2) : null,
    window: +((series[series.length - 1].price_cents / series[0].price_cents - 1) * 100).toFixed(2),
  } : null;

  return (
    <div>
      {/* ── Hero: large art LEFT · identity + price + chart RIGHT (Kaleb,
          2026-07-21: the card is the product — let it lead, chart beside it).
          Embedded mode has no image, so the right column takes full width. ── */}
      <div style={{ display: 'flex', gap: 28, margin: '14px 0 4px', flexWrap: 'wrap' }}>
        {!embedded && card.image && (
          <span style={{ position: 'relative', alignSelf: 'flex-start', lineHeight: 0 }}
                title={card.image_kind === 'listing' ? 'Sample slab photo from a marketplace listing — not a specific item for sale'
                     : card.image_kind === 'borrowed' ? "Artwork of the base printing — this variant's finish (foil, holo pattern) is not shown"
                     : undefined}>
            <img src={card.image} alt={card.name}
                 onError={e => { e.currentTarget.onerror = null; e.currentTarget.style.display = 'none'; }}
                 style={{
              height: 480, maxWidth: '100%', borderRadius: 10, border: `1px solid ${tokens.color.border}`,
              background: tokens.color.surfaceRaised,
            }} />
            {(card.image_kind === 'listing' || card.image_kind === 'borrowed') && (
              <span style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
                font: `600 9px ${tokens.font.body}`, letterSpacing: '0.06em',
                color: tokens.color.inkSecondary, background: tokens.color.overlay,
                borderRadius: '0 0 8px 8px', padding: '4px 2px',
              }}>{card.image_kind === 'listing' ? 'SAMPLE PHOTO' : 'BASE PRINTING ART'}</span>
            )}
          </span>
        )}
        <div style={{ flex: '1 1 460px', minWidth: 0 }}>
          {!embedded && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ font: `24px ${tokens.font.display}`, margin: 0 }}>{card.name}</h2>
              <span style={{ color: tokens.color.inkSecondary, font: `12px ${tokens.font.body}` }}>
                {card.set_name} {card.number} · {tokens.series[card.ip]?.label ?? card.ip}
              </span>
            </div>
          )}
          {embedded && (
            <div style={{ color: tokens.color.inkSecondary, font: `12px ${tokens.font.body}` }}>
              Tracked as <span style={{ color: tokens.color.ink }}>{card.name}</span> · {card.set_name} {card.number} — oracle mark by grade:
            </div>
          )}
          {cur && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ font: `34px ${tokens.font.mono}`, color: tokens.color.ink }}>{fmtUsd(cur.price_cents)}</span>
              <DeltaChip label="1D" pct={cur.change_1d_pct} />
              <DeltaChip label="7D" pct={range?.d7} />
              <DeltaChip label="30D" pct={cur.change_30d_pct} />
              <span style={{ font: `10px ${tokens.font.mono}`, color: cur.basis === 'solds' ? tokens.color.up : tokens.color.inkSecondary,
                             border: `1px solid ${tokens.color.border}`, borderRadius: 3, padding: '2px 7px' }}>
                {cur.basis === 'solds' ? 'RAW SOLDS' : `EXT · ${(cur.source ?? 'src').toUpperCase().slice(0, 8)}`} · CONF {(cur.confidence * 100).toFixed(0)}
              </span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 24, marginTop: 12, flexWrap: 'wrap' }}>
            {range && <Stat label={`${days}D high`} value={fmtUsd(range.hi)} />}
            {range && <Stat label={`${days}D low`} value={fmtUsd(range.lo)} />}
            {cur && <Stat label="Sales 7D / 30D" value={`${cur.sales_7d} / ${cur.sales_30d}`} />}
            {range && <Stat label={`${days}D return`} value={fmtPct(range.window)} color={deltaColor(range.window)} />}
          </div>

          {/* ── TCGplayer reference (daily snapshot): their market number +
              today's cheapest ask. Floors are asks, not sales — display only. ── */}
          {card.tcgplayer?.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12, flexWrap: 'wrap', font: `11px ${tokens.font.mono}` }}>
              <span style={{ color: tokens.color.inkMuted, letterSpacing: '0.06em' }}>TCGPLAYER</span>
              {card.tcgplayer.map(t => (
                <span key={t.subtype} style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 4, padding: '3px 10px', color: tokens.color.inkSecondary, textTransform: 'uppercase' }}>
                  {card.tcgplayer.length > 1 && <span style={{ color: tokens.color.inkMuted }}>{t.subtype} · </span>}
                  market <span style={{ color: tokens.color.ink }}>{fmtUsd(t.market_cents)}</span>
                  {t.low_cents != null && <> · lowest ask <span style={{ color: tokens.color.ink }}>{fmtUsd(t.low_cents)}</span></>}
                </span>
              ))}
              {card.tcgplayer[0]?.product_url && (
                <a href={card.tcgplayer[0].product_url} target="_blank" rel="noopener noreferrer" className="tl-buy-link"
                   style={{ color: tokens.color.inkSecondary, border: `1px solid ${tokens.color.border}`, borderRadius: 4, padding: '3px 10px', textDecoration: 'none' }}>
                  VIEW ↗
                </a>
              )}
              <span style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.body}` }}>raw · as of {card.tcgplayer[0]?.as_of}</span>
            </div>
          )}

          {/* ── Same card, other language printings (EN ↔ JP spread at a glance;
              chips jump to the sibling's research page). ── */}
          {card.other_languages?.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <span style={{ font: `10px ${tokens.font.mono}`, color: tokens.color.inkMuted, letterSpacing: '0.06em' }}>
                ALSO PRINTED IN
              </span>
              {card.other_languages.map(s => (
                <button key={s.id} onClick={onOpenCard ? () => onOpenCard(s.id) : undefined}
                        className={onOpenCard ? 'tl-buy-link' : undefined}
                        title={`${s.name} · ${s.set_name ?? ''} ${s.number ?? ''}`.trim()}
                        style={{
                          display: 'inline-flex', alignItems: 'baseline', gap: 8,
                          background: 'none', border: `1px solid ${tokens.color.border}`, borderRadius: 4,
                          padding: '3px 10px', font: `11px ${tokens.font.mono}`, textTransform: 'uppercase',
                          color: tokens.color.ink, cursor: onOpenCard ? 'pointer' : 'default',
                        }}>
                  <span>{s.language}</span>
                  {s.price_cents != null
                    ? <span style={{ color: tokens.color.inkSecondary }}>{s.grade} {fmtUsd(s.price_cents)}</span>
                    : <span style={{ color: tokens.color.inkMuted }}>tracked · no mark yet</span>}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, margin: '14px 0 16px', flexWrap: 'wrap' }}>
            {card.grades.map(g => (
              <button key={g.grade} onClick={() => setGrade(g.grade)} style={{
                background: grade === g.grade ? tokens.color.surfaceRaised : 'none',
                border: `1px solid ${grade === g.grade ? seriesColor : tokens.color.border}`,
                color: grade === g.grade ? tokens.color.ink : tokens.color.inkSecondary,
                borderRadius: 4, padding: '3px 12px', font: `11px ${tokens.font.mono}`, cursor: 'pointer', textTransform: 'uppercase',
              }}>{g.grade}</button>
            ))}
            <span style={{ flex: 1 }} />
            {[30, 90, 180].map(r => (
              <button key={r} onClick={() => setDays(r)} style={{
                background: days === r ? tokens.color.surfaceRaised : 'none',
                border: `1px solid ${days === r ? tokens.color.inkMuted : tokens.color.border}`,
                color: days === r ? tokens.color.ink : tokens.color.inkSecondary,
                borderRadius: 4, padding: '3px 10px', font: `11px ${tokens.font.mono}`, cursor: 'pointer',
              }}>{r}D</button>
            ))}
          </div>

          <MarkChart series={series} color={seriesColor}
                     dots={sales?.filter(s => s.grade === grade)} />
        </div>
      </div>

      <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%', marginTop: 24 }}>
        <thead><tr>
          <th style={thL}>Grade</th><th style={th}>Mark</th><th style={th}>Δ1D</th><th style={th}>Δ30D</th>
          <th style={th}>Sales/7D</th><th style={th}>Conf</th><th style={thL}>Basis</th>
        </tr></thead>
        <tbody>
          {card.grades.map(g => (
            <tr key={g.grade} onClick={() => setGrade(g.grade)} style={{ cursor: 'pointer', background: g.grade === grade ? tokens.color.surface : 'none' }}>
              <td style={tdL}>{g.grade}</td>
              <td style={td}>{fmtUsd(g.price_cents)}</td>
              <td style={{ ...td, color: deltaColor(g.change_1d_pct) }}>{fmtPct(g.change_1d_pct)}</td>
              <td style={{ ...td, color: deltaColor(g.change_30d_pct) }}>{fmtPct(g.change_30d_pct)}</td>
              <td style={td}>{g.sales_7d}</td>
              <td style={td}>{(g.confidence * 100).toFixed(0)}</td>
              <td style={{ ...tdL, color: g.basis === 'solds' ? tokens.color.up : tokens.color.inkSecondary, font: `11px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
                {g.basis === 'solds' ? 'solds' : `ext·${(g.source ?? '?').slice(0, 4)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Breakdown / sales / listings / catalysts ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 20, marginTop: 28 }}>
        <Panel title="Recent sales">
          {!sales?.length ? (
            <div style={placeholderStyle}>
              No recorded sales for this card yet — sales land here first-hand
              as our indexers walk the marketplaces' history.
            </div>
          ) : (
            <div>
              {sales.slice(0, 8).map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', font: `11px ${tokens.font.mono}`, textTransform: 'uppercase', opacity: s.is_outlier ? 0.45 : 1 }}
                     title={s.is_outlier ? 'Flagged as outlier — excluded from oracle marks' : undefined}>
                  <span style={{ color: tokens.color.inkMuted, minWidth: 62 }}>{s.sold_at?.slice(0, 10)}</span>
                  <span style={{ color: tokens.color.inkSecondary, minWidth: 46 }}>{s.grade}</span>
                  <span style={{ color: tokens.color.inkMuted, font: `9px ${tokens.font.body}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {PLATFORM_LABELS[s.source] ?? s.source}
                  </span>
                  <span style={{ color: tokens.color.ink, marginLeft: 'auto' }}>{fmtUsd(s.price_cents)}</span>
                  {s.is_outlier ? <span style={{ color: tokens.color.down, fontSize: 9 }}>⚑</span> : null}
                </div>
              ))}
              <div style={{ font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, marginTop: 6 }}>
                first-hand solds, straight from the marketplaces
              </div>
            </div>
          )}
        </Panel>
        <Panel title="About this card">
          <Row k="IP" v={tokens.series[card.ip]?.label ?? card.ip} />
          <Row k="Set" v={card.set_name ?? '—'} />
          <Row k="Number" v={card.number ?? '—'} />
          <Row k="Rarity / variant" v={card.variant || '—'} />
          <Row k="Grades tracked" v={card.grades.map(g => g.grade).join(', ')} />
          <Row k="Marked as of" v={cur?.as_of ?? '—'} />
        </Panel>
        <Panel title="Where to buy">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {marketLinks(card).map(l => (
              <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer" className="tl-buy-link" style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                border: `1px solid ${tokens.color.border}`, borderRadius: 6, padding: '8px 12px',
                color: tokens.color.ink, textDecoration: 'none', font: `12px ${tokens.font.body}`,
                background: tokens.color.surfaceRaised,
              }}>
                <span>{l.label}</span>
                <span style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.mono}`, textTransform: 'uppercase' }}>{l.note} ↗</span>
              </a>
            ))}
            <div style={{ ...placeholderStyle, fontSize: 10, marginTop: 2 }}>
              Search links routed by exact card + set + number. In-app gacha
              listings appear on the Gacha Desk when this card is live there.
            </div>
          </div>
        </Panel>
        {!embedded && (
          <Panel title="News & catalysts">
            <div style={placeholderStyle}>
              Reprints, set rotations, tournament results, grading-pop changes —
              the "why it moved" column. Data source TBD; on the backlog after
              live pricing.
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function DeltaChip({ label, pct }) {
  const c = pct == null ? tokens.color.inkMuted : pct >= 0 ? tokens.color.up : tokens.color.down;
  return (
    <span style={{ font: `12px ${tokens.font.mono}`, color: c }}>
      <span style={{ color: tokens.color.inkMuted, fontSize: 10 }}>{label} </span>{fmtPct(pct)}
    </span>
  );
}

/** Section-heading style — the uppercase letterspaced label treatment
 *  (matches the sales-tape header; Kaleb 2026-07-20). */
export const headingStyle = {
  font: `11px ${tokens.font.body}`, color: tokens.color.inkSecondary,
  textTransform: 'uppercase', letterSpacing: '0.08em',
};

function Panel({ title, children }) {
  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, background: tokens.color.surface, padding: '14px 16px' }}>
      <div style={{ ...headingStyle, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', font: `12px ${tokens.font.body}` }}>
      <span style={{ color: tokens.color.inkMuted }}>{k}</span>
      <span style={{ color: tokens.color.ink, font: `12px ${tokens.font.mono}`, textAlign: 'right', textTransform: 'uppercase' }}>{v}</span>
    </div>
  );
}

const placeholderStyle = { color: tokens.color.inkMuted, font: `12px ${tokens.font.body}`, lineHeight: 1.6 };

/**
 * Outbound buy-routing — the FOMO model: research here, execute anywhere.
 * Plain search deep links for now; affiliate params (TCGplayer partner,
 * eBay EPN campid) wrap these URLs once those accounts are approved.
 */
const TCG_LINES = { PKMN: 'pokemon', OP: 'one-piece-card-game', YGO: 'yugioh' };
function marketLinks(card) {
  const num = (card.number ?? '').split('/')[0];
  const q = encodeURIComponent(`${card.name} ${num}`.trim());
  const qFull = encodeURIComponent(`${card.name} ${card.set_name ?? ''} ${num}`.trim());
  const line = TCG_LINES[card.ip] ?? 'all';
  return [
    { label: 'TCGplayer', note: 'live listings', url: `https://www.tcgplayer.com/search/${line}/product?q=${q}&view=grid` },
    { label: 'eBay', note: 'live listings', url: `https://www.ebay.com/sch/i.html?_nkw=${qFull}` },
    { label: 'eBay · sold', note: 'recent comps', url: `https://www.ebay.com/sch/i.html?_nkw=${qFull}&LH_Sold=1&LH_Complete=1` },
  ];
}

function MarkChart({ series, color, dots }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const model = useMemo(() => {
    if (!series?.length) return null;
    // Individual sales plotted as dots — with sparse mark history (external
    // marks accrue one point/day) the raw trades ARE the texture of the chart.
    const byDate = new Map(series.map((p, i) => [p.as_of, i]));
    const pts = (dots ?? [])
      .map(s => ({ i: byDate.get((s.sold_at ?? '').slice(0, 10)), price: s.price_cents, outlier: !!s.is_outlier }))
      .filter(p => p.i != null);
    const vals = series.map(p => p.price_cents).concat(pts.filter(p => !p.outlier).map(p => p.price));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || lo * 0.05 || 1;
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
    const x = (i) => PAD.l + (W - PAD.l - PAD.r) * (series.length < 2 ? 0.5 : i / (series.length - 1));
    return { y, x, gridVals: [lo, (lo + hi) / 2, hi], pts };
  }, [series, dots]);

  if (!series) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>Loading…</div>;
  if (!series.length) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>No oracle marks for this grade yet.</div>;
  const { x, y, gridVals, pts } = model;

  // Split into provenance runs so external stretches render dashed.
  const segs = [];
  let run = null;
  for (let i = 0; i < series.length; i++) {
    const b = series[i].basis ?? 'solds';
    if (!run || run.basis !== b) {
      // Bridge segments: start the new run at the previous point for continuity.
      run = { basis: b, pts: i > 0 ? [i - 1] : [] };
      segs.push(run);
    }
    run.pts.push(i);
  }

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.l) / (W - PAD.l - PAD.r);
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(frac * (series.length - 1)))));
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
         onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Oracle mark history">
      {gridVals.map(v => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={tokens.color.border} strokeWidth="1" />
          <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fill={tokens.color.inkMuted} style={{ font: `10px ${tokens.font.mono}` }}>
            {fmtUsd(Math.round(v))}
          </text>
        </g>
      ))}
      {[0, Math.floor(series.length / 2), series.length - 1].map(i => (
        <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}
              fill={tokens.color.inkMuted} style={{ font: `10px ${tokens.font.mono}` }}>{series[i].as_of.slice(5)}</text>
      ))}

      {/* Area fill under the whole series — the token-chart read. Kept very
          light so the provenance-dashed line stays the protagonist. */}
      <defs>
        <linearGradient id="tl-mark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <path d={
        smoothPath(series.map((p, i) => [x(i), y(p.price_cents)]))
        + `L${x(series.length - 1).toFixed(1)},${H - PAD.b}L${x(0).toFixed(1)},${H - PAD.b}Z`
      } fill="url(#tl-mark-fill)" stroke="none" />

      {/* Shared chart language (chart-utils): smoothed curves; provenance
          dashing preserved — solds solid, external dashed. */}
      {segs.map((s, k) => (
        <path key={k}
              d={smoothPath(s.pts.map(i => [x(i), y(series[i].price_cents)]))}
              fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
              strokeDasharray={s.basis === 'external' ? '5 4' : undefined}
              opacity={s.basis === 'external' ? 0.85 : 1} />
      ))}
      {series.length > 0 && (
        <g>
          <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].price_cents)} r="3.5" fill={color} />
          <circle cx={x(series.length - 1)} cy={y(series[series.length - 1].price_cents)} r="7" fill={color} opacity="0.2" />
        </g>
      )}

      {/* Individual sales — jittered slightly so same-day trades don't stack
          into one dot; outliers faded (they're excluded from marks). */}
      {pts.map((p, k) => (
        <circle key={`d${k}`}
                cx={x(p.i) + ((k % 5) - 2) * 2.2} cy={y(p.price)} r="2.6"
                fill={color} opacity={p.outlier ? 0.18 : 0.45}
                stroke={tokens.color.bg} strokeWidth="0.6" />
      ))}
      {pts.length > 0 && (
        <text x={W - PAD.r} y={PAD.t - 2} textAnchor="end" fill={tokens.color.inkMuted}
              style={{ font: `9px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
          ● individual sales · — oracle mark
        </text>
      )}

      {hover != null && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke={tokens.color.inkSecondary} strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={x(hover)} cy={y(series[hover].price_cents)} r="4"
                  fill={series[hover].basis === 'external' ? tokens.color.bg : color}
                  stroke={series[hover].basis === 'external' ? color : tokens.color.bg} strokeWidth="2" />
          <HoverBox x={x(hover)} p={series[hover]} />
        </g>
      )}
    </svg>
  );
}

function HoverBox({ x, p }) {
  const w = 170, h = 62;
  const tx = x + w + 16 > W - PAD.r ? x - w - 12 : x + 12;
  return (
    <g transform={`translate(${tx},${PAD.t + 4})`}>
      <rect width={w} height={h} rx="4" fill={tokens.color.surfaceRaised} stroke={tokens.color.border} />
      <text x="10" y="16" fill={tokens.color.inkSecondary} style={{ font: `10px ${tokens.font.mono}` }}>{p.as_of}</text>
      <text x="10" y="34" fill={tokens.color.ink} style={{ font: `12px ${tokens.font.mono}` }}>{fmtUsd(p.price_cents)}</text>
      <text x="10" y="50" fill={tokens.color.inkMuted} style={{ font: `10px ${tokens.font.mono}`, textTransform: 'uppercase' }}>
        conf {(p.confidence * 100).toFixed(0)} · {p.basis === 'external' ? 'external' : `solds · ${p.sales_7d}/wk`}
      </text>
    </g>
  );
}

function Stat({ label, value, big = false, color = tokens.color.ink }) {
  return (
    <div>
      <div style={{ color: tokens.color.inkMuted, font: `10px ${tokens.font.body}`, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>{label}</div>
      <div style={{ color, font: `${big ? 22 : 15}px ${tokens.font.mono}` }}>{value}</div>
    </div>
  );
}

const deltaColor = (p) => p == null ? tokens.color.inkMuted : p >= 0 ? tokens.color.up : tokens.color.down;
const backStyle = { background: 'none', border: 'none', color: tokens.color.inkSecondary, font: `12px ${tokens.font.body}`, cursor: 'pointer', padding: 0 };
const th = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400, font: `11px ${tokens.font.body}` };
const thL = { ...th, textAlign: 'left' };
const td = { textAlign: 'right', padding: '5px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}`, textTransform: 'uppercase' };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}` };
