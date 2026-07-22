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
// Default = SHOWCASE (Kaleb, 2026-07-22: art first and foremost). A stored
// 'binder' pref (the retired wall view) migrates to showcase.
const loadView = () => {
  try {
    const v = localStorage.getItem(VIEW_KEY) ?? 'showcase';
    return v === 'binder' ? 'showcase' : v;
  } catch { return 'showcase'; }
};

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
  const [movers, setMovers] = useState([]);
  const [days, setDays] = useState(30);
  // Benchmark overlay (Kaleb, 2026-07-22: make the chart "more interesting"):
  // your binder vs the market for what you hold — published franchise indexes
  // blended by your binder's franchise value mix.
  const [vsMarket, setVsMarket] = useState(false);
  const [indexes, setIndexes] = useState(null);
  const [view, setView] = useState(loadView);
  const [adding, setAdding] = useState(false);
  // Card pop-out (Kaleb, 2026-07-22, inspired by pokemon.com's gallery):
  // clicking a card lifts it out of the page with YOUR numbers beside it;
  // the full research page is one more click, not the default jump.
  const [inspect, setInspect] = useState(null);
  const [lastAdded, setLastAdded] = useState(null);
  useEffect(() => {
    if (!lastAdded) return;
    const t = setTimeout(() => setLastAdded(null), 2600);
    return () => clearTimeout(t);
  }, [lastAdded]);
  useEffect(() => { savePositions(positions); }, [positions]);
  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  useEffect(() => {
    if (!positions.length) { setMarks({}); setSeries([]); return; }
    let dead = false;
    const req = positions.map(p => ({ card_id: p.card_id, grade: p.grade, qty: p.qty }));
    api.binderMarks(req)
      .then(rows => { if (!dead) setMarks(Object.fromEntries(rows.map(r => [`${r.card_id}|${r.grade}`, r]))); })
      .catch(() => {});
    api.binderSeries(req, days).then(s => {
      if (dead) return;
      // {series, movers} since 2026-07-22; tolerate the old bare-array shape
      // during a mixed deploy.
      setSeries(Array.isArray(s) ? s : s?.series ?? []);
      setMovers(Array.isArray(s) ? [] : s?.movers ?? []);
    }).catch(() => { setSeries([]); setMovers([]); });
    api.indexes(days).then(ix => { if (!dead) setIndexes(ix); }).catch(() => setIndexes([]));
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

  // "What moved" — the per-position movement behind the chart's change,
  // joined with names/franchises from the marks. Impact = window Δ × qty.
  const moversView = useMemo(() => {
    const rows = [];
    for (const mv of movers) {
      const key = `${mv.card_id}|${mv.grade}`;
      const pos = positions.find(p => posKey(p) === key);
      const impact = (mv.end_cents - mv.start_cents) * mv.qty;
      if (!impact || !pos) continue;
      const m = marks[key];
      rows.push({
        key, pos, impact,
        name: m?.name ?? mv.card_id, ip: m?.ip ?? pos.ip,
        grade: mv.grade !== 'raw' ? mv.grade : '',
        pct: mv.start_cents > 0 ? (mv.end_cents - mv.start_cents) / mv.start_cents : null,
      });
    }
    rows.sort((a, b) => b.impact - a.impact);
    return rows;
  }, [movers, marks, positions]);

  // Market benchmark: published franchise indexes blended by the binder's
  // franchise value mix, scaled to the window's starting binder value. An
  // honest "the market for what you hold" — never shown when nothing
  // published overlaps the window.
  const benchmark = useMemo(() => {
    if (!series || series.length < 2 || !indexes?.length) return null;
    const shareByIp = new Map();
    let total = 0;
    for (const p of positions) {
      const m = marks[posKey(p)];
      if (m?.price_cents != null) {
        const ip = m.ip ?? p.ip;
        shareByIp.set(ip, (shareByIp.get(ip) ?? 0) + m.price_cents * p.qty);
        total += m.price_cents * p.qty;
      }
    }
    if (!total) return null;
    const d0 = series[0].as_of;
    const kept = [];
    for (const ix of indexes) {
      const w = (shareByIp.get(ix.index_id) ?? 0) / total;
      if (!ix.published || !ix.series?.length || w <= 0) continue;
      const arr = ix.series;
      const at = (d) => { let v = null; for (const r of arr) { if (r.as_of <= d) v = r.value; else break; } return v; };
      const b = at(d0);
      if (b > 0) kept.push({ w, at, b });
    }
    const wSum = kept.reduce((a, k) => a + k.w, 0);
    if (!kept.length || wSum <= 0) return null;
    const start = series[0].value_cents;
    let last = start;
    return series.map(s => {
      let acc = 0, ws = 0;
      for (const k of kept) {
        const v = k.at(s.as_of);
        if (v != null) { acc += (k.w / wSum) * (v / k.b); ws += k.w / wSum; }
      }
      if (ws > 0) last = start * (acc / ws);
      return last;                       // carry-forward through index gaps
    });
  }, [series, indexes, positions, marks]);

  const removePos = (p) => setPositions(prev => prev.filter(x => posKey(x) !== posKey(p)));
  const toggleFav = (p) => {
    setPositions(prev => prev.map(x => posKey(x) === posKey(p) ? { ...x, fav: !x.fav } : x));
    setInspect(cur => cur && posKey(cur) === posKey(p) ? { ...cur, fav: !cur.fav } : cur);
  };

  // ── Binder pages (Kaleb, 2026-07-22): FAVORITES up front — "I liked
  // organizing them to show off my favorite cards at the front of the
  // binder" — then one page per FRANCHISE (set-level headers were "a bit
  // too much"). Richest franchise first; filter chips narrow the view.
  const [ipFilter, setIpFilter] = useState('');
  const shown = useMemo(() =>
    positions.filter(p => !ipFilter || (marks[posKey(p)]?.ip ?? p.ip) === ipFilter),
    [positions, marks, ipFilter]);
  const pages = useMemo(() => {
    const val = (ps) => ps.reduce((a, p) => a + (marks[posKey(p)]?.price_cents ?? 0) * p.qty, 0);
    const favs = shown.filter(p => p.fav);
    const rest = shown.filter(p => !p.fav);
    const byIp = new Map();
    for (const p of rest) {
      const ip = marks[posKey(p)]?.ip ?? p.ip ?? '?';
      (byIp.get(ip) ?? byIp.set(ip, []).get(ip)).push(p);
    }
    const out = [];
    if (favs.length) out.push({ key: 'fav', label: 'Favorites', star: true, ps: favs, subtotal: val(favs) });
    out.push(...[...byIp.entries()]
      .map(([ip, ps]) => ({ key: ip, label: tokens.series[ip]?.label ?? ip, color: tokens.series[ip]?.data, ps, subtotal: val(ps) }))
      .sort((a, b) => b.subtotal - a.subtotal));
    return out;
  }, [shown, marks]);
  // Flat binder order — the pop-out's ‹ › / arrow keys page through it.
  const flat = useMemo(() => pages.flatMap(pg => pg.ps), [pages]);
  const navInspect = (dir) => setInspect(cur => {
    if (!cur || !flat.length) return cur;
    const i = flat.findIndex(x => posKey(x) === posKey(cur));
    return flat[(i + dir + flat.length) % flat.length] ?? cur;
  });
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
    // Stay in the add flow (entering a collection is many cards) and let the
    // grid pulse the newcomer so you see it land.
    setLastAdded(posKey(pos));
  };

  return (
    <section>
      {/* ── Value panel: the compulsive-check numbers + the price action ── */}
      <div style={panel}>
        <SectionHead title="The Binder" hint="your cards, marked to the live Oracle"
          right={<>
            {[7, 30, 90].map(r => <Chip key={r} active={days === r} onClick={() => setDays(r)}>{r}D</Chip>)}
            {benchmark && <>
              <span style={{ width: 1, height: 18, background: tokens.color.border, margin: '0 4px' }} />
              <Chip active={vsMarket} onClick={() => setVsMarket(v => !v)}>VS Market</Chip>
            </>}
          </>} />
        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 6 }}>
          <Stat label="Binder value" big v={totals.priced ? fmtUsd(totals.value) : '—'} />
          <Stat label="Cost basis" v={positions.length ? fmtUsd(totals.cost) : '—'} />
          <Stat label="Unrealized P&L" v={totals.priced ? fmtUsd(totals.value - totals.cost) : '—'}
                color={pnlColor(totals.priced ? totals.value - totals.cost : null)} />
          <Stat label="Today" v={totals.priced ? fmtUsd(totals.day) : '—'} color={pnlColor(totals.priced ? totals.day : null)} />
          <Stat label="Cards" v={String(positions.reduce((a, p) => a + p.qty, 0) || '—')} />
        </div>
        <BinderChart series={series} costCents={totals.cost} benchmark={vsMarket ? benchmark : null} />
        <WhatMoved rows={moversView} days={days} onPick={(pos) => setInspect(pos)} />
      </div>

      {/* ── Holdings: the binder itself ── */}
      <div style={panel}>
        <SectionHead title="Holdings" hint={view === 'showcase' ? 'your collection — art first' : view === 'grid' ? 'thumbnails — click a card to inspect it' : 'the ledger — every position, marked'}
          right={<>
            <Chip active={adding} onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add Card'}</Chip>
            <span style={{ width: 1, height: 18, background: tokens.color.border, margin: '0 4px' }} />
            <Chip active={view === 'showcase'} onClick={() => pickView('showcase')}><span title="Showcase — art first" style={{ fontSize: 14, lineHeight: 1 }}>☐</span></Chip>
            <Chip active={view === 'grid'} onClick={() => pickView('grid')}><span title="Thumbnails" style={{ fontSize: 14, lineHeight: 1 }}>⊞</span></Chip>
            <Chip active={view === 'list'} onClick={() => pickView('list')}><span title="Ledger" style={{ fontSize: 14, lineHeight: 1 }}>☰</span></Chip>
          </>} />

        {positions.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
            {[['', 'All'], ['PKMN', 'Pokémon'], ['OP', 'One Piece'], ['YGO', 'Yu-Gi-Oh']].map(([val, label]) => (
              <Chip key={val || 'all'} active={ipFilter === val} onClick={() => setIpFilter(val)}
                    color={val ? tokens.series[val]?.data : undefined}>{label}</Chip>
            ))}
          </div>
        )}

        {adding && <AddCard onAdd={addPosition} />}

        {!positions.length && !adding && (
          <div onClick={() => setAdding(true)}
               style={{ padding: '40px 24px 48px', textAlign: 'center', color: tokens.color.inkMuted, font: `13px ${tokens.font.body}`, lineHeight: 1.8, cursor: 'pointer' }}>
            {/* Empty sleeves waiting for their first card — the whole state is the add button. */}
            <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginBottom: 22 }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{
                  width: 96, height: 128, borderRadius: 8,
                  border: `1.5px dashed ${tokens.color.border}`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  color: i === 1 ? tokens.color.brass : tokens.color.border,
                  font: `300 ${i === 1 ? 30 : 20}px ${tokens.font.body}`,
                }}>{i === 1 ? '+' : ''}</span>
              ))}
            </div>
            <div style={{ font: `20px ${tokens.font.display}`, color: tokens.color.inkSecondary, marginBottom: 6 }}>Your Binder is empty</div>
            Add the cards you own and watch them marked to the live Oracle —
            entry price in, honest value out. Positions stay in this browser.
          </div>
        )}

        {positions.length > 0 && view === 'showcase' && (
          <BinderShowcase flat={flat} marks={marks} onSelect={setInspect} lastAdded={lastAdded} />
        )}
        {positions.length > 0 && view === 'grid' && (
          <BinderGrid pages={pages} marks={marks} onSelect={setInspect} lastAdded={lastAdded} />
        )}
        {positions.length > 0 && view === 'list' && (
          <BinderTable positions={[...shown].sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0))} marks={marks} onSelect={setInspect} />
        )}

        {inspect && (
          <BinderCardModal
            p={inspect} m={marks[posKey(inspect)]}
            idx={flat.findIndex(x => posKey(x) === posKey(inspect))} total={flat.length}
            onNav={navInspect}
            onClose={() => setInspect(null)}
            onFull={() => { const id = inspect.card_id; setInspect(null); onSelect?.(id); }}
            onFav={() => toggleFav(inspect)}
            onRemove={() => { removePos(inspect); setInspect(null); }}
          />
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

/**
 * The card pop-out (Kaleb, 2026-07-22, pokemon.com-gallery inspired): the
 * card lifts out of the binder over a dimmed page, YOUR numbers beside it.
 * Esc/backdrop closes; FULL RESEARCH is the deliberate second click.
 */
const MODAL_CSS = `
@keyframes tl-pop { from { transform: scale(.94) translateY(8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
.tl-binder-pop { animation: tl-pop .22s ease-out; }
`;

function BinderCardModal({ p, m, idx = 0, total = 1, onNav, onClose, onFull, onRemove, onFav }) {
  // Two-step remove (Kaleb, 2026-07-22: "too easy to remove a card
  // accidentally") — REMOVE arms a red confirm that disarms itself.
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setConfirmRemove(false); }, [p]);
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onNav?.(1);
      if (e.key === 'ArrowLeft') onNav?.(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNav]);

  const val = m?.price_cents != null ? m.price_cents * p.qty : null;
  const pnl = val != null && p.cost_cents != null ? val - p.cost_cents * p.qty : null;
  const pnlPct = pnl != null && p.cost_cents > 0 ? (pnl / (p.cost_cents * p.qty)) * 100 : null;
  const d1 = m?.price_cents != null && m?.price_1d ? ((m.price_cents / m.price_1d) - 1) * 100 : null;
  const row = { display: 'flex', justifyContent: 'space-between', gap: 18, padding: '7px 0', borderBottom: `1px solid ${tokens.color.border}` };
  const k = { font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.06em', alignSelf: 'center' };
  const v = { font: `13px ${tokens.font.mono}`, color: tokens.color.ink, textTransform: 'uppercase' };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(20,16,10,0.62)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, backdropFilter: 'blur(2px)',
    }}>
      <style>{MODAL_CSS}</style>
      <div className="tl-binder-pop" onClick={e => e.stopPropagation()} style={{
        display: 'flex', gap: 26, maxWidth: 860, width: '100%', maxHeight: '86vh',
        background: tokens.color.surface, border: `1px solid ${tokens.color.brass}`,
        borderRadius: 10, padding: 22, boxSizing: 'border-box', boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
      }}>
        {/* The card itself, as big as the room allows. */}
        <div style={{ flex: '1 1 46%', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: tokens.color.surfaceRaised, borderRadius: 8 }}>
          {m?.image
            ? <img src={m.image} alt="" onError={imgFallback}
                   style={{ maxWidth: '100%', maxHeight: '78vh', objectFit: 'contain', display: 'block', padding: 12, boxSizing: 'border-box',
                            filter: 'drop-shadow(0 12px 26px rgba(30,22,10,0.30))' }} />
            : <div style={{ color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, padding: 40 }}>no image yet</div>}
        </div>

        {/* Your numbers. */}
        <div style={{ flex: '1 1 54%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <div style={{ font: `19px ${tokens.font.display}`, color: tokens.color.ink, display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.name ?? p.name}</span>
              <span onClick={onFav} title={p.fav ? 'Remove from Favorites' : 'Pin to the front of your Binder'}
                    style={{ cursor: 'pointer', fontSize: 16, color: p.fav ? tokens.color.brass : tokens.color.inkMuted, flexShrink: 0 }}>
                {p.fav ? '★' : '☆'}
              </span>
            </div>
            <span style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexShrink: 0 }}>
              {total > 1 && (
                <span style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.inkMuted, textTransform: 'uppercase' }}>
                  <span onClick={() => onNav?.(-1)} title="Previous card (←)" style={{ cursor: 'pointer', padding: '0 4px' }}>‹</span>
                  {idx + 1} / {total}
                  <span onClick={() => onNav?.(1)} title="Next card (→)" style={{ cursor: 'pointer', padding: '0 4px' }}>›</span>
                </span>
              )}
              <span onClick={onClose} title="Close (Esc)" style={{ cursor: 'pointer', color: tokens.color.inkMuted, font: `13px ${tokens.font.mono}` }}>✕</span>
            </span>
          </div>
          <div style={{ font: `11px ${tokens.font.body}`, color: tokens.color.inkMuted, marginBottom: 14 }}>
            {m?.set_name ?? p.set_name} {m?.number ?? p.number}{langCode(m?.language ?? p.language) !== 'EN' ? ` · ${langCode(m?.language ?? p.language)}` : ''}
          </div>

          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', marginBottom: 14 }}>
            <Stat label="Position value" big v={fmtUsd(val)} />
            {pnlPct != null && <Stat label="P&L" v={`${fmtUsd(pnl)} · ${fmtPct(pnlPct)}`} color={pnlColor(pnl)} />}
          </div>

          <div style={row}><span style={k}>Grade · Qty</span><span style={v}>{p.grade}{p.qty > 1 ? ` × ${p.qty}` : ''}</span></div>
          <div style={row}><span style={k}>Paid (each)</span><span style={v}>{fmtUsd(p.cost_cents)}</span></div>
          <div style={row} title={m?.basis ? (m.basis === 'solds' ? 'Value from real sales' : 'Estimated value') : undefined}>
            <span style={k}>Oracle (each)</span><span style={v}>{fmtUsd(m?.price_cents)}{m?.basis ? ` · ${m.basis === 'solds' ? 'real sales' : 'estimate'}` : ''}</span>
          </div>
          <div style={row}><span style={k}>Today</span><span style={{ ...v, color: pnlColor(d1) }}>{fmtPct(d1)}</span></div>
          <div style={row}><span style={k}>Added</span><span style={v}>{p.added_at ?? '—'}</span></div>

          <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip active onClick={onFull}>Full Research →</Chip>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {!confirmRemove ? (
                <Chip onClick={() => setConfirmRemove(true)}>Remove…</Chip>
              ) : (
                <>
                  <span style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted }}>take it out of the binder?</span>
                  <Chip active color={tokens.color.down} onClick={onRemove}>Yes, Remove</Chip>
                  <Chip onClick={() => setConfirmRemove(false)}>Keep</Chip>
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
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
/**
 * The movement behind the chart (Kaleb, 2026-07-22): which cards actually
 * drove the window's change. Tape-style single strip — up to three gainers
 * and three decliners by dollar impact (Δ × qty); click lifts the card into
 * the pop-out. Renders nothing when nothing moved.
 */
function WhatMoved({ rows, days, onPick }) {
  if (!rows?.length) return null;
  const gainers = rows.filter(r => r.impact > 0).slice(0, 3);
  const losers = rows.filter(r => r.impact < 0).slice(-3).reverse();
  if (!gainers.length && !losers.length) return null;
  const fmtPct = (p) => p == null ? '' : ` (${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%)`;
  const entry = (r, up) => (
    <span key={r.key} onClick={() => onPick?.(r.pos)} title={`${r.name} — open`}
          style={{ font: `11px ${tokens.font.mono}`, cursor: 'pointer', flexShrink: 0, textTransform: 'uppercase', color: tokens.color.inkSecondary }}>
      <span style={{ color: up ? tokens.color.up : tokens.color.down }}>{up ? '▲' : '▼'}</span>{' '}
      <span style={{ color: tokens.color.ink }}>{r.name}</span>
      {r.grade ? ` ${r.grade}` : ''}{' '}
      <span style={{ color: up ? tokens.color.up : tokens.color.down }}>
        {r.impact > 0 ? '+' : '−'}{fmtUsd(Math.abs(r.impact))}{fmtPct(r.pct)}
      </span>
    </span>
  );
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${tokens.color.border}` }}>
      <span style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 14 }}>
        What moved · {days}D
      </span>
      <span style={{ display: 'inline-flex', gap: 18, flexWrap: 'wrap', verticalAlign: 'middle' }}>
        {gainers.map(r => entry(r, true))}
        {losers.map(r => entry(r, false))}
      </span>
    </div>
  );
}

function BinderChart({ series, costCents, benchmark }) {
  const W = 1180, H = 160, PAD = { t: 12, r: 74, b: 20, l: 10 };
  if (!series) return <div style={{ height: H, display: 'flex', alignItems: 'center', color: tokens.color.inkMuted, font: `12px ${tokens.font.body}` }}>Loading price action…</div>;
  if (series.length < 2) {
    return <div style={{ height: 44, display: 'flex', alignItems: 'center', color: tokens.color.inkMuted, font: `11px ${tokens.font.body}` }}>
      {series.length === 0 ? 'The chart draws as your cards accrue Oracle history.' : 'One day of history so far — the line starts tomorrow.'}
    </div>;
  }
  const vals = series.map(s => s.value_cents);
  const bench = benchmark?.length === series.length ? benchmark : null;
  const lo = Math.min(...vals, ...(bench ?? []), costCents || Infinity);
  const hi = Math.max(...vals, ...(bench ?? []), costCents || 0);
  const span = Math.max(1, hi - lo);
  const x = (i) => PAD.l + (i / (series.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
  const pts = series.map((s, i) => [x(i), y(s.value_cents)]);
  const d = smoothPath(pts);
  const benchPts = bench ? bench.map((v, i) => [x(i), y(v)]) : null;
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
      {benchPts && (
        <g>
          {/* the market for what you hold — franchise indexes blended by your mix */}
          <path d={smoothPath(benchPts)} fill="none" stroke={tokens.color.inkMuted} strokeWidth="1.3" strokeDasharray="5 4" opacity="0.85" />
          <text x={benchPts[benchPts.length - 1][0] + 9} y={benchPts[benchPts.length - 1][1] + 12}
                fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>MARKET</text>
        </g>
      )}
      <path d={d} fill="none" stroke={col} strokeWidth="1.8" />
      <circle cx={ex} cy={ey} r="3" fill={col} />
      <circle cx={ex} cy={ey} r="6" fill={col} opacity="0.25" />
      <text x={ex + 9} y={ey + 3} fill={col} style={{ font: `11px ${tokens.font.mono}` }}>{fmtUsd(vals[vals.length - 1])}</text>
      <text x={PAD.l} y={H - 6} fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>{series[0].as_of}</text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" fill={tokens.color.inkMuted} style={{ font: `9px ${tokens.font.mono}` }}>{series[series.length - 1].as_of}</text>
    </svg>
  );
}

/** The binder itself — slabs in sleeves. Same hover-lift language as the
 *  desk grid, plus the collector's touch: a holo shimmer sweeping the card
 *  on hover (the exact glint of tilting a foil, kept subtle). */
const GRID_CSS = `
.tl-binder-card { transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; position: relative; }
.tl-binder-card:hover { transform: translateY(-2px); border-color: ${tokens.color.inkMuted}; box-shadow: 0 4px 14px rgba(0,0,0,0.12); }
.tl-showcase-card { transition: transform .12s ease; }
.tl-showcase-card:hover { transform: translateY(-3px); }
@keyframes tl-added-pulse { 0% { box-shadow: 0 0 0 0 rgba(212,175,55,0.55); } 100% { box-shadow: 0 0 0 16px rgba(212,175,55,0); } }
.tl-just-added { border-color: ${tokens.color.brass}; animation: tl-added-pulse 1.4s ease-out; }
`;

/**
 * Binder pages: FAVORITES up front (the flex page), then one page per
 * franchise. Headers wear the star / franchise color dot.
 */
function BinderGrid({ pages, marks, onSelect, lastAdded }) {
  return (
    <div>
      <style>{GRID_CSS}</style>
      {pages.map(({ key, label, star, color, ps, subtotal }) => (
        <div key={key} style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '2px 0 10px', borderBottom: `1px solid ${tokens.color.border}`, paddingBottom: 6 }}>
            {star && <span style={{ color: tokens.color.brass, fontSize: 12 }}>★</span>}
            {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color, alignSelf: 'center' }} />}
            <span style={{ font: `11px ${tokens.font.mono}`, textTransform: 'uppercase', letterSpacing: '1px', color: tokens.color.ink }}>{label}</span>
            <span style={{ font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted }}>
              {ps.reduce((a, p) => a + p.qty, 0)} card{ps.reduce((a, p) => a + p.qty, 0) === 1 ? '' : 's'}
            </span>
            <span style={{ marginLeft: 'auto', font: `11px ${tokens.font.mono}`, color: tokens.color.inkSecondary, textTransform: 'uppercase' }}>
              {subtotal > 0 ? fmtUsd(subtotal) : ''}
            </span>
          </div>
          <PageGrid ps={ps} marks={marks} onSelect={onSelect} lastAdded={lastAdded} />
        </div>
      ))}
    </div>
  );
}

function PageGrid({ ps, marks, onSelect, lastAdded }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 22 }}>
      {ps.map(p => {
        const m = marks[posKey(p)];
        const val = m?.price_cents != null ? m.price_cents * p.qty : null;
        const pnlPct = val != null && p.cost_cents > 0 ? ((val / (p.cost_cents * p.qty)) - 1) * 100 : null;
        return (
          <div key={posKey(p)} className={`tl-binder-card${posKey(p) === lastAdded ? ' tl-just-added' : ''}`} onClick={() => onSelect?.(p)}
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
              {p.fav && (
                <span style={{
                  position: 'absolute', top: 6, right: 6, font: `12px ${tokens.font.mono}`,
                  color: tokens.color.brass, background: tokens.color.overlay, borderRadius: 3, padding: '1px 6px',
                }}>★</span>
              )}
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

/**
 * SHOWCASE — the DEFAULT view (Kaleb, 2026-07-22 v3: "the beautiful
 * collector art first binder view… really just larger card art, rows of 3-6
 * cards… maybe slight indication of tcg/name/value but really it's art first
 * and foremost"). Big art, no box around the card — the printed card carries
 * its own frame; a soft shadow lifts it off the surface like the pop-out.
 * One quiet caption line: franchise dot · name · value. Binder order
 * (favorites first), no section headers — pure flow.
 */
function BinderShowcase({ flat, marks, onSelect, lastAdded }) {
  if (!flat.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(225px, 1fr))', gap: '26px 22px', paddingTop: 4 }}>
      <style>{GRID_CSS}</style>
      {flat.map(p => {
        const m = marks[posKey(p)];
        const ip = m?.ip ?? p.ip;
        const dot = tokens.series[ip]?.data;
        return (
          <div key={posKey(p)} onClick={() => onSelect?.(p)}
               className={`tl-showcase-card${lastAdded === posKey(p) ? ' tl-just-added' : ''}`}
               style={{ cursor: 'pointer', position: 'relative' }}>
            {m?.image
              ? <img src={m.image} alt="" loading="lazy" onError={imgFallback}
                     style={{
                       width: '100%', aspectRatio: '3/4', objectFit: 'contain', display: 'block',
                       filter: 'drop-shadow(0 6px 16px rgba(30,22,10,0.22))',
                     }} />
              : <div style={{
                  width: '100%', aspectRatio: '3/4', borderRadius: 10, boxSizing: 'border-box',
                  border: `1.5px dashed ${tokens.color.border}`, background: tokens.color.surfaceRaised,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: tokens.color.inkMuted, font: `11px ${tokens.font.body}`, textAlign: 'center', padding: 12,
                }}>{m?.name ?? p.name ?? ''}</div>}
            {p.fav && (
              <span style={{ position: 'absolute', top: 6, right: 8, color: tokens.color.brass, fontSize: 13, textShadow: '0 1px 3px rgba(0,0,0,0.35)' }}>★</span>
            )}
            {/* the one quiet line — art stays the headline */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8, padding: '0 2px' }}>
              {dot && <span style={{ width: 6, height: 6, borderRadius: 2, background: dot, alignSelf: 'center', flexShrink: 0 }} />}
              <span style={{ font: `11px ${tokens.font.body}`, color: tokens.color.inkSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m?.name ?? p.name}{p.grade !== 'raw' ? ` · ${p.grade}` : ''}{p.qty > 1 ? ` ×${p.qty}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', font: `11px ${tokens.font.mono}`, color: tokens.color.ink, flexShrink: 0 }}>
                {m?.price_cents != null ? fmtUsd(m.price_cents * p.qty) : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BinderTable({ positions, marks, onSelect }) {
  return (
    <table style={{ borderCollapse: 'collapse', color: tokens.color.ink, width: '100%' }}>
      <thead><tr>
        <th style={thL}>Card</th><th style={thL}>Lang</th><th style={thL}>Grade</th>
        <th style={th}>Qty</th><th style={th}>Cost/ea</th>
        <th style={th} title={ORACLE_HINT}>Oracle/ea</th>
        <th style={th}>Value</th><th style={th}>P&L</th><th style={th}>P&L%</th><th style={th}>Δ1D</th>
      </tr></thead>
      <tbody>
        {positions.map(p => {
          const m = marks[posKey(p)];
          const val = m?.price_cents != null ? m.price_cents * p.qty : null;
          const pnl = val != null && p.cost_cents != null ? val - p.cost_cents * p.qty : null;
          const pnlPct = pnl != null && p.cost_cents > 0 ? (pnl / (p.cost_cents * p.qty)) * 100 : null;
          const d1 = m?.price_cents != null && m?.price_1d ? ((m.price_cents / m.price_1d) - 1) * 100 : null;
          return (
            <tr key={posKey(p)} style={{ cursor: 'pointer' }} onClick={() => onSelect?.(p)}>
              <td style={{ ...tdL, display: 'flex', alignItems: 'center' }}>
                <Thumb src={m?.image} size={34} />
                <span>{p.fav && <span style={{ color: tokens.color.brass }}>★ </span>}{m?.name ?? p.name} <span style={{ color: tokens.color.inkMuted }}>· {m?.set_name ?? p.set_name} {m?.number ?? p.number}</span></span>
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
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Search → SEE the card (thumbnails — many cards share a name across sets;
 * you pick by sight) → grade dropdown with LIVE Oracle values per tracked
 * grade → qty/cost → add. (Kaleb, 2026-07-22: "more intuitive when searching
 * exactly which card to add".)
 */
function AddCard({ onAdd }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [pick, setPick] = useState(null);
  const [ladder, setLadder] = useState(null);        // tracked grades w/ live values
  const [grade, setGrade] = useState('raw');
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const [justAdded, setJustAdded] = useState(null);  // "Added ✓ …" toast
  const debounce = useRef(null);
  useEffect(() => {
    if (!justAdded) return;
    const t = setTimeout(() => setJustAdded(null), 2600);
    return () => clearTimeout(t);
  }, [justAdded]);

  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.cards({ q, limit: 12 }).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(debounce.current);
  }, [q]);

  // On pick: pull the card's full grade ladder so the dropdown can say
  // "PSA10 — $5,260" instead of making the user guess what we track.
  useEffect(() => {
    if (!pick) { setLadder(null); return; }
    let dead = false;
    api.card(pick.card_id)
      .then(c => { if (!dead) setLadder(c?.grades ?? []); })
      .catch(() => { if (!dead) setLadder([]); });
    return () => { dead = true; };
  }, [pick]);

  const gradeOptions = useMemo(() => {
    const tracked = new Map((ladder ?? []).map(g => [g.grade, g.price_cents]));
    const rest = GRADES.filter(g => !tracked.has(g));
    return [
      ...[...tracked.entries()].map(([g, cents]) => ({ g, label: `${g.toUpperCase()} — ${fmtUsd(cents)}` })),
      ...rest.map(g => ({ g, label: g.toUpperCase() })),
    ];
  }, [ladder]);

  const input = {
    background: tokens.color.surface, border: `1px solid ${tokens.color.border}`,
    color: tokens.color.ink, borderRadius: 6, padding: '7px 12px',
    font: `13px ${tokens.font.body}`, outline: 'none',
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 16, marginBottom: 18, background: tokens.color.surfaceRaised }}>
      {!pick && (
        <div>
          <span style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                   placeholder="Search the card you own — name, set, or number…" style={{ ...input, width: 360 }} />
            {justAdded && (
              <span style={{ font: `11px ${tokens.font.mono}`, color: tokens.color.up, textTransform: 'uppercase' }}>
                ✓ added {justAdded}
              </span>
            )}
          </span>
          {results && (
            <div style={{ marginTop: 12 }}>
              {results.length === 0 && <div style={{ color: tokens.color.inkMuted, font: `12px ${tokens.font.body}` }}>No matches — try fewer words.</div>}
              {/* Visual picker: thumbnails, because "Charizard" is forty cards. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                {results.map(c => (
                  <div key={c.card_id} onClick={() => { setPick(c); setGrade(c.grade ?? 'raw'); }}
                       onMouseEnter={e => e.currentTarget.style.borderColor = tokens.color.brass}
                       onMouseLeave={e => e.currentTarget.style.borderColor = tokens.color.border}
                       style={{
                         display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer',
                         border: `1px solid ${tokens.color.border}`, borderRadius: 6, background: tokens.color.surface,
                         transition: 'border-color .12s ease',
                       }}>
                    <Thumb src={c.image} size={46} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', font: `13px ${tokens.font.body}`, color: tokens.color.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      <span style={{ display: 'block', font: `10px ${tokens.font.body}`, color: tokens.color.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.set_name} {c.number}{langCode(c.language) !== 'EN' ? ` · ${langCode(c.language)}` : ''}
                      </span>
                      {c.price_cents != null && (
                        <span style={{ display: 'block', font: `10px ${tokens.font.mono}`, color: tokens.color.inkSecondary, textTransform: 'uppercase' }}>
                          {c.grade} {fmtUsd(c.price_cents)}{c.grades_tracked > 1 ? ` · +${c.grades_tracked - 1} grades` : ''}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {pick && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* The card you're adding, big enough to be sure it's the right one. */}
          <Thumb src={pick.image} size={92} />
          <div style={{ flex: '1 1 auto', minWidth: 260 }}>
            <div style={{ font: `15px ${tokens.font.body}`, color: tokens.color.ink, marginBottom: 2 }}>{pick.name}</div>
            <div style={{ font: `11px ${tokens.font.body}`, color: tokens.color.inkMuted, marginBottom: 12 }}>
              {pick.set_name} {pick.number}{langCode(pick.language) !== 'EN' ? ` · ${langCode(pick.language)}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label={ladder === null ? 'Grade (loading values…)' : 'Grade'}>
                <select value={grade} onChange={e => setGrade(e.target.value)}
                        style={{ ...input, padding: '6px 8px', textTransform: 'uppercase', font: `12px ${tokens.font.mono}` }}>
                  {gradeOptions.map(o => <option key={o.g} value={o.g}>{o.label}</option>)}
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
                // Reset for the NEXT card — collections are added in runs.
                setJustAdded(pick.name);
                setPick(null); setQ(''); setResults(null);
                setGrade('raw'); setQty('1'); setCost('');
              }}>Add To Binder</Chip>
              <Chip onClick={() => setPick(null)}>Back</Chip>
            </div>
          </div>
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
