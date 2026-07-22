/**
 * THE BINDER — portfolio tracker, major build #1 (Kaleb's name; before the
 * Buy Flow). v2 (Kaleb, 2026-07-22: "a really nice beautiful binder of cards
 * people would enjoy looking at and organizing" — the Collectr-beater):
 * terminal panel aesthetic · portfolio price-action chart · grid/list toggle
 * where GRID is the binder — big slab thumbnails with value + P&L on each.
 *
 * Positions live in the BROWSER (localStorage — no accounts until the Buy
 * Flow's sign-in); the server only prices what it's shown. Marked to the
 * same provenance-honest oracle as the rest of the terminal: unpriced
 * positions show '—', stay out of totals, and say so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct } from '../data/client.js';
import { Chip, Thumb, langCode, ORACLE_HINT, imgFallback } from './tables.jsx';
import { smoothPath } from './chart-utils.js';

const STORE_KEY = 'topload-binder-v1';
const VIEW_KEY = 'topload-binder-view';
const loadPositions = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'); } catch { return []; }
};
const savePositions = (ps) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(ps)); } catch { /* SSR/private mode */ } };
const loadView = () => { try { return localStorage.getItem(VIEW_KEY) ?? 'grid'; } catch { return 'grid'; } };

const panel = {
  border: `1px solid ${tokens.color.border}`, borderRadius: 0,
  padding: '14px 16px', background: tokens.color.surface,
  boxSizing: 'border-box', width: '100%', overflow: 'hidden', marginBottom: 20,
};
function SectionHead({ title, hint, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' }}>
      <h2 style={{ margin: 0, font: `12px ${tokens.font.mono}`, textTransform: 'uppercase', letterSpacing: '1.5px', color: tokens.color.ink }}>{title}</h2>
      {hint && <span style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>{hint}</span>}
      {right && <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>{right}</span>}
    </div>
  );
}

const th = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400, font: `11px ${tokens.font.body}`, whiteSpace: 'nowrap' };
const thL = { ...th, textAlign: 'left' };
const td = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}`, whiteSpace: 'nowrap', textTransform: 'uppercase' };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}`, textTransform: 'none' };

const GRADES = ['raw', 'PSA10', 'PSA9', 'PSA8', 'BGS10', 'BGS9.5', 'CGC10', 'CGC9.5', 'TAG10', 'SGC10'];
const pnlColor = (v) => v == null ? tokens.color.inkMuted : v >= 0 ? tokens.color.up : tokens.color.down;
const posKey = (p) => `${p.card_id}|${p.grade}`;

export function Binder({ onSelect }) {
  const [positions, setPositions] = useState(loadPositions);
  const [marks, setMarks] = useState({});
  const [series, setSeries] = useState(null);
  const [days, setDays] = useState(30);
  const [view, setView] = useState(loadView);
  const [adding, setAdding] = useState(false);
  useEffect(() => { savePositions(positions); }, [positions]);
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  useEffect(() => {
    if (!positions.length) { setMarks({}); setSeries([]); return; }
    let dead = false;
    const req = positions.map(p => ({ card_id: p.card_id, grade: p.grade, qty: p.qty }));
    api.binderMarks(req)
      .then(rows => { if (!dead) setMarks(Object.fromEntries(rows.map(r => [`${r.card_id}|${r.grade}`, r]))); })
      .catch(() => {});
    api.binderSeries(req, days).then(s => { if (!dead) setSeries(s); }).catch(() => setSeries([]));
    return () => { dead = true; };
  }, [positions, days]);

  const totals = useMemo(() => {
    let cost = 0, value = 0, day = 0, priced = 0;
    for (const p of positions) {
      cost += (p.cost_cents ?? 0) * p.qty;
      const m = marks[posKey(p)];
      if (m?.price_cents != null) {
        priced++;
        value += m.price_cents * p.qty;
        if (m.price_1d != null) day += (m.price_cents - m.price_1d) * p.qty;
      }
    }
    return { cost, value, day, priced };
  }, [positions, marks]);

  const removePos = (p) => setPositions(prev => prev.filter(x => posKey(x) !== posKey(p)));
  const addPosition = (pos) => {
    setPositions(prev => {
      const i = prev.findIndex(p => posKey(p) === posKey(pos));
      if (i >= 0) {
        const cur = prev[i];
        const qty = cur.qty + pos.qty;
        const cost_cents = Math.round(((cur.cost_cents ?? 0) * cur.qty + (pos.cost_cents ?? 0) * pos.qty) / qty);
        return prev.map((p, j) => j === i ? { ...cur, qty, cost_cents } : p);
      }
      return [...prev, pos];
    });
    setAdding(false);
  };

  return (
    <section>
      {/* ── Value panel: the compulsive-check numbers + the price action ── */}
      <div style={panel}>
        <SectionHead title="The Binder" hint="your cards, marked to the live Oracle"
          right={<>
            {[7, 30, 90].map(r => <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>)}
          </>} />
        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 6 }}>
          <Stat label="Binder value" big v={totals.priced ? fmtUsd(totals.value) : '—'} />
          <Stat label="Cost basis" v={positions.length ? fmtUsd(totals.cost) : '—'} />
          <Stat label="Unrealized P&L" v={totals.priced ? fmtUsd(totals.value - totals.cost) : '—'}
                color={pnlColor(totals.priced ? totals.value - totals.cost : null)} />
          <Stat label="Today" v={totals.priced ? fmtUsd(totals.day) : '—'} color={pnlColor(totals.priced ? totals.day : null)} />
          <Stat label="Cards" v={String(positions.reduce((a, p) => a + p.qty, 0) || '—')} />
        </div>
        <BinderChart series={series} costCents={totals.cost} />
      </div>

      {/* ── Holdings: the binder itself ── */}
      <div style={panel}>
        <SectionHead title="Holdings" hint={view === 'grid' ? 'the binder — click a card to research it' : 'the ledger — every position, marked'}
          right={<>
            <Chip active={adding} onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add Card'}</Chip>
            <span style={{ width: 1, height: 18, background: tokens.color.border, margin: '0 4px' }} />
            <Chip active={view === 'grid'} onClick={() => pickView('grid')}><span title="Binder view" style={{ fontSize: 14, lineHeight: 1 }}>⊞</span></Chip>
            <Chip active={view === 'list'} onClick={() => pickView('list')}><span title="Ledger view" style={{ fontSize: 14, lineHeight: 1 }}>☰</span></Chip>
          </>} />

        {adding && <AddCard onAdd={addPosition} />}

        {!positions.length && !adding && (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: tokens.color.inkMuted, font: `13px ${tokens.font.body}`, lineHeight: 1.8 }}>
            <div style={{ font: `20px ${tokens.font.display}`, color: tokens.color.inkSecondary, marginBottom: 6 }}>Your Binder is empty</div>
            Add the cards you own and watch them marked to the live Oracle —
            entry price in, honest value out. Positions stay in this browser.
          </div>
        )}

        {positions.length > 0 && view === 'grid' && (
          <BinderGrid positions={positions} marks={marks} onSelect={onSelect} onRemove={removePos} />
        )}
        {positions.length > 0 && view === 'list' && (
          <BinderTable positions={positions} marks={marks} onSelect={onSelect} onRemove={removePos} />
        )}

        {positions.length > 0 && totals.priced < positions.length && (
          <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginTop: 10 }}>
            {positions.length - totals.priced} position{positions.length - totals.priced === 1 ? '' : 's'} without an Oracle value yet
            (grade not tracked or no data) — held at cost, excluded from Binder value.
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, v, big = false, color }) {
  return (
    <span>
      <div style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{label}</div>
      <div style={{ font: `${big ? 32 : 18}px ${tokens.font.mono}`, color: color ?? tokens.color.ink }}>{v}</div>
    </span>
  );
}

/**
 * Portfolio price action — same visual language as the Market chart
 * (smooth curve, soft area fill, endpoint glow) plus a dashed cost-basis
 * line: above the line you're winning, below you're under water.
 */
function BinderChart({ series, costCents }) {
  const W = 1180, H = 160, PAD = { t: 12, r: 74, b: 20, l: 10 };
  if (!series) return <div style={{ height: H, display: 'flex', alignItems: 'center', color: tokens.color.inkMuted, font: `12px ${tokens.font.body}` }}>Loading price action…</div>;
  if (series.length < 2) {
    return <div style={{ height: 44, display: 'flex', alignItems: 'center', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>
      {series.length === 0 ? 'The chart draws as your cards accrue Oracle history.' : 'One day of history so far — the line starts tomorrow.'}
    </div>;
  }
  const vals = series.map(s => s.value_cents);
  const lo = Math.min(...vals, costCents || Infinity), hi = Math.max(...vals, costCents || 0);
  const span = Math.max(1, hi - lo);
  const x = (i) => PAD.l + (i / (series.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
  const pts = series.map((s, i) => [x(i), y(s.value_cents)]);
  const d = smoothPath(pts);
  const up = vals[vals.length - 1] >= vals[0];
  const col = up ? tokens.color.up : tokens.color.down;
  const [ex, ey] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id="binder-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.16" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      {costCents > 0 && costCents >= lo && costCents <= hi && (
        <g>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(costCents)} y2={y(costCents)} stroke={tokens.color.inkMuted} strokeWidth="1" strokeDasharray="4 5" opacity="0.6" />
          <text x={W - PAD.r + 6} y={y(costCents) + 3} fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>COST</text>
        </g>
      )}
      <path d={`${d} L ${ex.toFixed(1)} ${H - PAD.b} L ${pts[0][0].toFixed(1)} ${H - PAD.b} Z`} fill="url(#binder-fill)" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.8" />
      <circle cx={ex} cy={ey} r="3" fill={col} />
      <circle cx={ex} cy={ey} r="6" fill={col} opacity="0.25" />
      <text x={ex + 9} y={ey + 3} fill={col} style={{ font: `11px ${tokens.font.mono}` }}>{fmtUsd(vals[vals.length - 1])}</text>
      <text x={PAD.l} y={H - 6} fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>{series[0].as_of}</text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>{series[series.length - 1].as_of}</text>
    </svg>
  );
}

/** The binder itself — slabs in sleeves. Same hover-lift language as the desk grid. */
const GRID_CSS = `
.tl-binder-card { transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; position: relative; }
.tl-binder-card:hover { transform: translateY(-2px); border-color: ${tokens.color.inkMuted}; box-shadow: 0 4px 14px rgba(0,0,0,0.12); }
.tl-binder-card .tl-remove { opacity: 0; transition: opacity .12s ease; }
.tl-binder-card:hover .tl-remove { opacity: 1; }
`;

function BinderGrid({ positions, marks, onSelect, onRemove }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 22 }}>
      <style>{GRID_CSS}</style>
      {positions.map(p => {
        const m = marks[posKey(p)];
        const val = m?.price_cents != null ? m.price_cents * p.qty : null;
        const pnlPct = val != null && p.cost_cents > 0 ? ((val / (p.cost_cents * p.qty)) - 1) * 100 : null;
        return (
          <div key={posKey(p)} className="tl-binder-card" onClick={() => onSelect?.(p.card_id)}
               title={m?.name ?? p.name}
               style={{
                 border: `1px solid ${tokens.color.border}`, borderRadius: 8, overflow: 'hidden',
                 background: tokens.color.surface, cursor: 'pointer', display: 'flex', flexDirection: 'column',
               }}>
            <div style={{ position: 'relative', aspectRatio: '3/4', background: tokens.color.surfaceRaised }}>
              {m?.image
                ? <img src={m.image} alt="" loading="lazy" onError={imgFallback}
                       style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', padding: 10, boxSizing: 'border-box' }} />
                : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: tokens.color.inkMuted, font: `10px ${tokens.font.body}` }}>no image</div>}
              <span style={{
                position: 'absolute', top: 6, left: 6, font: `10px ${tokens.font.mono}`, textTransform: 'uppercase',
                color: tokens.color.ink, background: tokens.color.overlay, borderRadius: 3, padding: '2px 6px',
              }}>{p.grade}{p.qty > 1 ? ` ×${p.qty}` : ''}{langCode(m?.language ?? p.language) !== 'EN' ? ` · ${langCode(m?.language ?? p.language)}` : ''}</span>
              <span className="tl-remove" onClick={(e) => { e.stopPropagation(); onRemove(p); }}
                    title="Remove from Binder"
                    style={{
                      position: 'absolute', top: 6, right: 6, font: `11px ${tokens.font.mono}`,
                      color: tokens.color.ink, background: tokens.color.overlay, borderRadius: 3,
                      padding: '2px 7px', cursor: 'pointer',
                    }}>✕</span>
            </div>
            <div style={{ padding: '8px 10px 9px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ font: `13px ${tokens.font.mono}`, color: tokens.color.ink }}>{fmtUsd(val)}</span>
                {pnlPct != null && (
                  <span style={{ font: `10px ${tokens.font.mono}`, color: pnlColor(pnlPct) }}>{fmtPct(pnlPct)}</span>
                )}
              </div>
              <div style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m?.name ?? p.name}
              </div>
              <div style={{ font: `9px ${tokens.font.body}`, color: tokens.color.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m?.set_name ?? p.set_name} {m?.number ?? p.number} · paid {fmtUsd((p.cost_cents ?? 0) * p.qty)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BinderTable({ positions, marks, onSelect, onRemove }) {
  return (
    <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
      <thead><tr>
        <th style={thL}>Card</th><th style={thL}>Lang</th><th style={thL}>Grade</th>
        <th style={th}>Qty</th><th style={th}>Cost/ea</th>
        <th style={th} title={ORACLE_HINT}>Oracle/ea</th>
        <th style={th}>Value</th><th style={th}>P&L</th><th style={th}>P&L%</th><th style={th}>Δ1D</th>
        <th style={th} />
      </tr></thead>
      <tbody>
        {positions.map(p => {
          const m = marks[posKey(p)];
          const val = m?.price_cents != null ? m.price_cents * p.qty : null;
          const pnl = val != null && p.cost_cents != null ? val - p.cost_cents * p.qty : null;
          const pnlPct = pnl != null && p.cost_cents > 0 ? (pnl / (p.cost_cents * p.qty)) * 100 : null;
          const d1 = m?.price_cents != null && m?.price_1d ? ((m.price_cents / m.price_1d) - 1) * 100 : null;
          return (
            <tr key={posKey(p)} style={{ cursor: 'pointer' }} onClick={() => onSelect?.(p.card_id)}>
              <td style={{ ...tdL, display: 'flex', alignItems: 'center' }}>
                <Thumb src={m?.image} size={34} />
                <span>{m?.name ?? p.name} <span style={{ color: tokens.color.inkMuted }}>· {m?.set_name ?? p.set_name} {m?.number ?? p.number}</span></span>
              </td>
              <td style={{ ...td, textAlign: 'left' }}>
                <span style={{ color: langCode(m?.language ?? p.language) === 'EN' ? tokens.color.inkMuted : tokens.color.ink }}>{langCode(m?.language ?? p.language)}</span>
              </td>
              <td style={tdL}>{p.grade}</td>
              <td style={td}>{p.qty}</td>
              <td style={td}>{fmtUsd(p.cost_cents)}</td>
              <td style={td} title={m?.basis ? (m.basis === 'solds' ? 'Value from real sales' : 'Estimated value') : 'No Oracle value for this grade yet'}>
                {fmtUsd(m?.price_cents)}
              </td>
              <td style={td}>{fmtUsd(val)}</td>
              <td style={{ ...td, color: pnlColor(pnl) }}>{fmtUsd(pnl)}</td>
              <td style={{ ...td, color: pnlColor(pnl) }}>{fmtPct(pnlPct)}</td>
              <td style={{ ...td, color: pnlColor(d1) }}>{fmtPct(d1)}</td>
              <td style={{ ...td, width: 24 }} onClick={(e) => { e.stopPropagation(); onRemove(p); }} title="Remove from Binder">
                <span style={{ color: tokens.color.inkMuted, cursor: 'pointer' }}>✕</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Search → pick card → grade/qty/cost → add. Reuses the screener API. */
function AddCard({ onAdd }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [pick, setPick] = useState(null);
  const [grade, setGrade] = useState('raw');
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const debounce = useRef(null);

  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.cards({ q, limit: 8 }).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(debounce.current);
  }, [q]);

  const input = {
    background: tokens.color.surface, border: `1px solid ${tokens.color.border}`,
    color: tokens.color.ink, borderRadius: 6, padding: '7px 12px',
    font: `13px ${tokens.font.body}`, outline: 'none',
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 16, marginBottom: 18, background: tokens.color.surfaceRaised }}>
      {!pick && (
        <div>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search the card you own…" style={{ ...input, width: 320 }} />
          {results && (
            <div style={{ marginTop: 10 }}>
              {results.length === 0 && <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}` }}>No matches — try fewer words.</div>}
              {results.map(c => (
                <div key={c.card_id} onClick={() => setPick(c)}
                     style={{ padding: '6px 8px', cursor: 'pointer', borderTop: `1px solid ${tokens.color.surface}`, font: `13px ${tokens.font.body}` }}>
                  {c.name} <span style={{ color: tokens.color.inkMuted }}>· {c.set_name} {c.number} · {langCode(c.language)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {pick && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <span style={{ font: `13px ${tokens.font.body}`, color: tokens.color.ink, paddingBottom: 8 }}>
            {pick.name} <span style={{ color: tokens.color.inkMuted }}>· {pick.set_name} {pick.number}</span>
          </span>
          <Field label="Grade">
            <select value={grade} onChange={e => setGrade(e.target.value)} style={{ ...input, padding: '6px 8px', textTransform: 'uppercase', font: `12px ${tokens.font.mono}` }}>
              {GRADES.map(g => <option key={g} value={g}>{g.toUpperCase()}</option>)}
            </select>
          </Field>
          <Field label="Qty"><input value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} style={{ ...input, width: 52 }} /></Field>
          <Field label="Cost each ($)"><input value={cost} onChange={e => setCost(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" style={{ ...input, width: 100 }} /></Field>
          <Chip active onClick={() => {
            const nQty = Math.max(1, parseInt(qty || '1', 10));
            onAdd({
              card_id: pick.card_id, grade, qty: nQty,
              cost_cents: Math.round(parseFloat(cost || '0') * 100),
              added_at: new Date().toISOString().slice(0, 10),
              name: pick.name, set_name: pick.set_name, number: pick.number, ip: pick.ip, language: pick.language,
            });
          }}>Add To Binder</Chip>
          <Chip onClick={() => setPick(null)}>Back</Chip>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <span>
      <div style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
      {children}
    </span>
  );
}
