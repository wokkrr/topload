/**
 * THE BINDER — portfolio tracker, major build #1 (Kaleb's name; before the
 * Buy Flow). v1 walking skeleton: positions live in the BROWSER
 * (localStorage — no accounts until the Buy Flow's sign-in arrives), the
 * server only prices what it's shown via /api/binder/marks.
 *
 * The retention loop this exists for: entry price vs live Oracle value,
 * unrealized P&L, "how's my collection doing today" — marked to the same
 * provenance-honest oracle as everything else on the terminal. No fake
 * precision: unpriced positions show '—' and stay out of value totals.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct } from '../data/client.js';
import { Chip, Thumb, langCode, ORACLE_HINT } from './tables.jsx';

const STORE_KEY = 'topload-binder-v1';
const loadPositions = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'); } catch { return []; }
};
const savePositions = (ps) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(ps)); } catch { /* SSR/private mode */ } };

const th = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400, font: `11px ${tokens.font.body}`, whiteSpace: 'nowrap' };
const thL = { ...th, textAlign: 'left' };
const td = { textAlign: 'right', padding: '6px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}`, whiteSpace: 'nowrap', textTransform: 'uppercase' };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}`, textTransform: 'none' };

const GRADES = ['raw', 'PSA10', 'PSA9', 'PSA8', 'BGS10', 'BGS9.5', 'CGC10', 'CGC9.5', 'TAG10', 'SGC10'];

const pnlColor = (v) => v == null ? tokens.color.inkMuted : v >= 0 ? tokens.color.up : tokens.color.down;

/** One position uniquely identified by card+grade; qty/cost aggregate. */
const posKey = (p) => `${p.card_id}|${p.grade}`;

export function Binder({ onSelect }) {
  const [positions, setPositions] = useState(loadPositions);
  const [marks, setMarks] = useState({});           // posKey → server row
  const [adding, setAdding] = useState(false);
  useEffect(() => { savePositions(positions); }, [positions]);

  // Price everything we hold (and refresh when holdings change).
  useEffect(() => {
    if (!positions.length) { setMarks({}); return; }
    let dead = false;
    api.binderMarks(positions.map(p => ({ card_id: p.card_id, grade: p.grade })))
      .then(rows => { if (!dead) setMarks(Object.fromEntries(rows.map(r => [`${r.card_id}|${r.grade}`, r]))); })
      .catch(() => {});
    return () => { dead = true; };
  }, [positions]);

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

  const addPosition = (pos) => {
    setPositions(prev => {
      const i = prev.findIndex(p => posKey(p) === posKey(pos));
      if (i >= 0) {   // same card+grade → aggregate qty, blend cost basis
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
      {/* ── Portfolio header: the compulsive-check numbers ── */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 18 }}>
        <Stat label="Binder value" big v={totals.priced ? fmtUsd(totals.value) : '—'} />
        <Stat label="Cost basis" v={positions.length ? fmtUsd(totals.cost) : '—'} />
        <Stat label="Unrealized P&L" v={totals.priced ? fmtUsd(totals.value - totals.cost) : '—'}
              color={pnlColor(totals.priced ? totals.value - totals.cost : null)} />
        <Stat label="Today" v={totals.priced ? fmtUsd(totals.day) : '—'} color={pnlColor(totals.priced ? totals.day : null)} />
        <span style={{ marginLeft: 'auto' }}>
          <Chip active={adding} onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add Card'}</Chip>
        </span>
      </div>

      {adding && <AddCard onAdd={addPosition} />}

      {!positions.length && !adding && (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: tokens.color.inkMuted, font: `13px ${tokens.font.body}`, lineHeight: 1.8 }}>
          <div style={{ font: `20px ${tokens.font.display}`, color: tokens.color.inkSecondary, marginBottom: 6 }}>Your Binder is empty</div>
          Add the cards you own and watch them marked to the live Oracle —
          entry price in, honest value out. Positions stay in this browser.
        </div>
      )}

      {positions.length > 0 && (
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
                  <td style={{ ...td, width: 24 }} onClick={(e) => { e.stopPropagation(); setPositions(prev => prev.filter(x => posKey(x) !== posKey(p))); }}
                      title="Remove from Binder">
                    <span style={{ color: tokens.color.inkMuted, cursor: 'pointer' }}>✕</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {positions.length > 0 && totals.priced < positions.length && (
        <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, marginTop: 10 }}>
          {positions.length - totals.priced} position{positions.length - totals.priced === 1 ? '' : 's'} without an Oracle value yet
          (grade not tracked or no data) — held at cost, excluded from Binder value.
        </div>
      )}
    </section>
  );
}

function Stat({ label, v, big = false, color }) {
  return (
    <span>
      <div style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{label}</div>
      <div style={{ font: `${big ? 30 : 18}px ${tokens.font.mono}`, color: color ?? tokens.color.ink }}>{v}</div>
    </span>
  );
}

/** Search → pick card → grade/qty/cost → add. Reuses the screener API. */
function AddCard({ onAdd }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [pick, setPick] = useState(null);            // chosen card row
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
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 16, marginBottom: 18, background: tokens.color.surface }}>
      {!pick && (
        <div>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search the card you own…" style={{ ...input, width: 320 }} />
          {results && (
            <div style={{ marginTop: 10 }}>
              {results.length === 0 && <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}` }}>No matches — try fewer words.</div>}
              {results.map(c => (
                <div key={c.card_id} onClick={() => setPick(c)}
                     style={{ padding: '6px 8px', cursor: 'pointer', borderTop: `1px solid ${tokens.color.surfaceRaised}`, font: `13px ${tokens.font.body}` }}>
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
