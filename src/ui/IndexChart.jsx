import { useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';

const W = 860, H = 320, PAD = { t: 16, r: 96, b: 28, l: 48 };

/**
 * Two-series indexed line chart (base = 100 at window start).
 * Crosshair + tooltip, direct end-labels + legend, table toggle.
 */
export function IndexChart({ data }) {
  const [hover, setHover] = useState(null); // {i, x}
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef(null);

  const model = useMemo(() => {
    if (!data?.length) return null;
    const dates = data[0].series.map(p => p.as_of);
    const all = data.flatMap(d => d.series.map(p => p.value));
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 1;
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
    const x = (i) => PAD.l + (W - PAD.l - PAD.r) * (dates.length < 2 ? 0 : i / (dates.length - 1));
    const gridVals = [lo, (lo + hi) / 2, hi].map(v => +v.toFixed(1));
    return { dates, x, y, gridVals };
  }, [data]);

  if (!model) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>No index data — run `npm run ingest`.</div>;
  const { dates, x, y, gridVals } = model;

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.l) / (W - PAD.l - PAD.r);
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(frac * (dates.length - 1))));
    setHover({ i, x: x(i) });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
        {data.map(d => {
          const s = tokens.series[d.index_id] ?? { label: d.index_id, data: tokens.color.ink };
          return (
            <span key={d.index_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: `12px ${tokens.font.body}`, color: tokens.color.inkSecondary }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.data, display: 'inline-block' }} />
              {s.label}
            </span>
          );
        })}
        <button onClick={() => setShowTable(t => !t)} style={btnStyle}>{showTable ? 'Chart' : 'Table'}</button>
      </div>

      {showTable ? <IndexTable data={data} dates={dates} /> : (
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Index performance, base 100">
          {gridVals.map(v => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={tokens.color.border} strokeWidth="1" />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fill={tokens.color.inkMuted} style={{ font: `10px ${tokens.font.mono}` }}>{v}</text>
            </g>
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(100)} y2={y(100)} stroke={tokens.color.inkMuted} strokeWidth="1" strokeDasharray="2 4" />

          {[dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]].map((d, k) => (
            <text key={k} x={x(k === 0 ? 0 : k === 1 ? Math.floor(dates.length / 2) : dates.length - 1)} y={H - 8}
                  textAnchor={k === 0 ? 'start' : k === 1 ? 'middle' : 'end'} fill={tokens.color.inkMuted}
                  style={{ font: `10px ${tokens.font.mono}` }}>{d.slice(5)}</text>
          ))}

          {data.map(d => {
            const s = tokens.series[d.index_id] ?? { data: tokens.color.ink };
            const path = d.series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
            const last = d.series[d.series.length - 1];
            return (
              <g key={d.index_id}>
                <path d={path} fill="none" stroke={s.data} strokeWidth="2" strokeLinejoin="round" />
                <text x={W - PAD.r + 8} y={y(last.value) + 4} fill={s.data} style={{ font: `11px ${tokens.font.mono}` }}>
                  {(tokens.series[d.index_id]?.label ?? d.index_id)} {last.value.toFixed(1)}
                </text>
              </g>
            );
          })}

          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={PAD.t} y2={H - PAD.b} stroke={tokens.color.inkSecondary} strokeWidth="1" strokeDasharray="3 3" />
              {data.map(d => (
                <circle key={d.index_id} cx={hover.x} cy={y(d.series[hover.i].value)} r="4"
                        fill={(tokens.series[d.index_id] ?? {}).data} stroke={tokens.color.bg} strokeWidth="2" />
              ))}
              <Tooltip x={hover.x} date={dates[hover.i]} rows={data.map(d => ({
                label: tokens.series[d.index_id]?.label ?? d.index_id,
                color: (tokens.series[d.index_id] ?? {}).data,
                value: d.series[hover.i].value.toFixed(2),
              }))} />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function Tooltip({ x, date, rows }) {
  const w = 148, h = 22 + rows.length * 18;
  const tx = x + w + 16 > W - PAD.r ? x - w - 12 : x + 12;
  return (
    <g transform={`translate(${tx},${PAD.t + 4})`}>
      <rect width={w} height={h} rx="4" fill={tokens.color.surfaceRaised} stroke={tokens.color.border} />
      <text x="10" y="16" fill={tokens.color.inkSecondary} style={{ font: `10px ${tokens.font.mono}` }}>{date}</text>
      {rows.map((r, i) => (
        <g key={r.label} transform={`translate(10,${30 + i * 18})`}>
          <rect width="8" height="8" y="-8" rx="2" fill={r.color} />
          <text x="14" fill={tokens.color.ink} style={{ font: `11px ${tokens.font.mono}` }}>{r.label} {r.value}</text>
        </g>
      ))}
    </g>
  );
}

function IndexTable({ data, dates }) {
  const step = Math.max(1, Math.floor(dates.length / 12));
  const rows = dates.filter((_, i) => i % step === 0 || i === dates.length - 1);
  return (
    <table style={{ borderCollapse: 'collapse', font: `12px ${tokens.font.mono}`, color: tokens.color.ink }}>
      <thead>
        <tr>
          <th style={thStyle}>Date</th>
          {data.map(d => <th key={d.index_id} style={thStyle}>{tokens.series[d.index_id]?.label ?? d.index_id}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(date => {
          const i = dates.indexOf(date);
          return (
            <tr key={date}>
              <td style={tdStyle}>{date}</td>
              {data.map(d => <td key={d.index_id} style={{ ...tdStyle, textAlign: 'right' }}>{d.series[i].value.toFixed(2)}</td>)}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const btnStyle = {
  marginLeft: 'auto', background: 'none', border: `1px solid ${tokens.color.border}`,
  color: tokens.color.inkSecondary, borderRadius: 4, padding: '3px 10px',
  font: `11px ${tokens.font.body}`, cursor: 'pointer',
};
const thStyle = { textAlign: 'left', padding: '4px 12px', borderBottom: `1px solid ${tokens.color.border}`, color: tokens.color.inkSecondary, fontWeight: 400 };
const tdStyle = { padding: '3px 12px', borderBottom: `1px solid ${tokens.color.surface}` };
