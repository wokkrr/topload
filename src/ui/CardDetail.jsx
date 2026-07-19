import { useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { api, fmtUsd, fmtPct } from '../data/client.js';

const W = 860, H = 280, PAD = { t: 16, r: 24, b: 28, l: 56 };

/**
 * Card research view: per-grade oracle chart with provenance-aware rendering
 * (solid = solds-based marks, dashed + open markers = external bootstrap),
 * stat row, and a per-grade table. Single series → no legend (title names it).
 */
export function CardDetail({ cardId, onBack }) {
  const [card, setCard] = useState(null);
  const [grade, setGrade] = useState(null);
  const [days, setDays] = useState(90);
  const [series, setSeries] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.card(cardId).then(c => {
      setCard(c);
      setGrade(g => g && c.grades.some(x => x.grade === g) ? g : (c.grades[0]?.grade ?? 'raw'));
    }).catch(e => setErr(String(e)));
  }, [cardId]);

  useEffect(() => {
    if (!grade) return;
    api.cardSeries(cardId, grade, days).then(setSeries).catch(e => setErr(String(e)));
  }, [cardId, grade, days]);

  if (err) return <div style={{ color: tokens.color.down, font: `12px ${tokens.font.mono}` }}>{err}</div>;
  if (!card) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>Loading…</div>;

  const cur = card.grades.find(g => g.grade === grade);
  const seriesColor = tokens.series[card.ip]?.data ?? tokens.color.ink;

  return (
    <section>
      <button onClick={onBack} style={backStyle}>← back</button>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '12px 0 2px' }}>
        <h2 style={{ font: `20px ${tokens.font.display}`, margin: 0 }}>{card.name}</h2>
        <span style={{ color: tokens.color.inkSecondary, font: `12px ${tokens.font.body}` }}>
          {card.set_name} {card.number} · {tokens.series[card.ip]?.label ?? card.ip}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 4, margin: '12px 0 16px', flexWrap: 'wrap' }}>
        {card.grades.map(g => (
          <button key={g.grade} onClick={() => setGrade(g.grade)} style={{
            background: grade === g.grade ? tokens.color.surfaceRaised : 'none',
            border: `1px solid ${grade === g.grade ? seriesColor : tokens.color.border}`,
            color: grade === g.grade ? tokens.color.ink : tokens.color.inkSecondary,
            borderRadius: 4, padding: '3px 12px', font: `11px ${tokens.font.mono}`, cursor: 'pointer',
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

      {cur && (
        <div style={{ display: 'flex', gap: 28, marginBottom: 16, flexWrap: 'wrap' }}>
          <Stat label={`Oracle mark · ${grade}`} value={fmtUsd(cur.price_cents)} big />
          <Stat label="Δ1D" value={fmtPct(cur.change_1d_pct)} color={deltaColor(cur.change_1d_pct)} />
          <Stat label="Δ30D" value={fmtPct(cur.change_30d_pct)} color={deltaColor(cur.change_30d_pct)} />
          <Stat label="Sales 7D / 30D" value={`${cur.sales_7d} / ${cur.sales_30d}`} />
          <Stat label="Confidence" value={`${(cur.confidence * 100).toFixed(0)}`} />
          <Stat label="Basis" value={cur.basis === 'solds' ? 'raw solds' : 'external (PC)'}
                color={cur.basis === 'solds' ? tokens.color.up : tokens.color.inkSecondary} />
        </div>
      )}

      <MarkChart series={series} color={seriesColor} />

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
              <td style={{ ...tdL, color: g.basis === 'solds' ? tokens.color.up : tokens.color.inkSecondary, font: `11px ${tokens.font.mono}` }}>
                {g.basis === 'solds' ? 'solds' : 'ext'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function MarkChart({ series, color }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const model = useMemo(() => {
    if (!series?.length) return null;
    const vals = series.map(p => p.price_cents);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || lo * 0.05 || 1;
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
    const x = (i) => PAD.l + (W - PAD.l - PAD.r) * (series.length < 2 ? 0 : i / (series.length - 1));
    return { y, x, gridVals: [lo, (lo + hi) / 2, hi] };
  }, [series]);

  if (!series) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>Loading…</div>;
  if (!series.length) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>No oracle marks for this grade yet.</div>;
  const { x, y, gridVals } = model;

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

      {segs.map((s, k) => (
        <path key={k}
              d={s.pts.map((i, j) => `${j ? 'L' : 'M'}${x(i).toFixed(1)},${y(series[i].price_cents).toFixed(1)}`).join('')}
              fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round"
              strokeDasharray={s.basis === 'external' ? '5 4' : undefined}
              opacity={s.basis === 'external' ? 0.85 : 1} />
      ))}

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
      <text x="10" y="50" fill={tokens.color.inkMuted} style={{ font: `10px ${tokens.font.mono}` }}>
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
const td = { textAlign: 'right', padding: '5px 12px', borderBottom: `1px solid ${tokens.color.surface}`, font: `12px ${tokens.font.mono}` };
const tdL = { ...td, textAlign: 'left', font: `12px ${tokens.font.body}` };
