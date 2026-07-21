import { useMemo, useRef, useState } from 'react';
import { tokens } from '../tokens.js';
import { smoothPath, spreadLabels } from './chart-utils.js';

const W = 860, H = 320, PAD = { t: 16, r: 96, b: 28, l: 48 };


/**
 * Two-series indexed line chart (base = 100 at window start).
 * Crosshair + tooltip, direct end-labels + legend, table toggle.
 */
export function IndexChart({ data }) {
  const [hover, setHover] = useState(null); // {i, x}
  const svgRef = useRef(null);

  // Defensive: the API can return an index with a missing or empty series
  // (no points in the window). One malformed entry must degrade, never blank
  // the page (live crash, 2026-07-20). Uneven series lengths are also real —
  // hover indexes are guarded below.
  // Only PUBLISHED indexes draw (basket has enough genuinely-traded members —
  // a 2-card flat line pretending to be a market told Kaleb "nothing", 2026-07-21).
  // Unpublished ones are listed honestly below the legend instead.
  const rows = useMemo(() => (data ?? []).filter(d => Array.isArray(d?.series) && d.series.length > 0 && d.published !== false), [data]);
  const building = useMemo(() => (data ?? []).filter(d => d.published === false), [data]);
  const model = useMemo(() => {
    if (!rows.length) return null;
    // DATE-aligned axis (live bug 2026-07-21: YGO's shorter history plotted
    // by array INDEX — its whole line squeezed to the left edge, endpoint dot
    // parked on top of Pokémon's start while its value label sat orphaned at
    // the right). The axis is the union of all dates; every series maps its
    // points to their true date position, so newer indexes start mid-chart
    // and END at the right edge like everything else.
    const dates = [...new Set(rows.flatMap(d => d.series.map(p => p.as_of)))].sort();
    const dateIx = new Map(dates.map((dt, i) => [dt, i]));
    // Per row: [ {i: axis position, value} ] in date order.
    const aligned = new Map(rows.map(d => [d.index_id,
      d.series.filter(p => dateIx.has(p.as_of)).map(p => ({ i: dateIx.get(p.as_of), value: p.value }))]));
    const all = rows.flatMap(d => d.series.map(p => p.value));
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 1;
    const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad)));
    const x = (i) => PAD.l + (W - PAD.l - PAD.r) * (dates.length < 2 ? 0 : i / (dates.length - 1));
    const gridVals = [lo, (lo + hi) / 2, hi].map(v => +v.toFixed(1));
    return { dates, dateIx, aligned, x, y, gridVals };
  }, [rows]);

  if (!model) return <div style={{ color: tokens.color.inkMuted, padding: 24 }}>No index data — run `npm run ingest`.</div>;
  const { dates, aligned, x, y, gridVals } = model;

  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.l) / (W - PAD.l - PAD.r);
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(frac * (dates.length - 1))));
    setHover({ i, x: x(i) });
  };

  return (
    <div>
      {/* Legend, decluttered (Kaleb, 2026-07-21: small text = clutter): dot,
          name, window Δ. The receipts live behind the tiles. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
        {rows.map(d => {
          const s = tokens.series[d.index_id] ?? { label: d.index_id, data: tokens.color.ink };
          return (
            <span key={d.index_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: `12px ${tokens.font.body}`, color: tokens.color.inkSecondary }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.data, display: 'inline-block' }} />
              {s.label}
            </span>
          );
        })}
      </div>
      {building.length > 0 && (
        <div style={{ font: `11px ${tokens.font.body}`, color: tokens.color.inkMuted, margin: '0 0 10px' }}>
          {building.map(d => {
            const label = tokens.series[d.index_id]?.label ?? d.index_id;
            return `${label} index publishes at ${d.min_members ?? 8} actively-traded cards (now ${d.members ?? 0}) — building sales history`;
          }).join(' · ')}
        </div>
      )}

      {(
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

          {(() => {
            // Endpoint labels get collision-spread so near-equal indexes never
            // print on top of each other (live "funky numbers", 2026-07-21).
            const lasts = rows.map(d => aligned.get(d.index_id).at(-1));
            const labelYs = spreadLabels(
              lasts.map(p => ({ y: p ? y(p.value) : H / 2 })),
              15, [PAD.t + 8, H - PAD.b - 4]);
            return rows.map((d, ri) => {
              const s = tokens.series[d.index_id] ?? { data: tokens.color.ink };
              // Smooth curve + soft gradient fill beneath — presentation only;
              // tooltip still reports the true point values.
              const seq = aligned.get(d.index_id);
              if (!seq.length) return null;
              const pts = seq.map(p => [x(p.i), y(p.value)]);
              const line = smoothPath(pts);
              const last = lasts[ri];
              const lastX = x(last.i);
              const gid = `grad-${d.index_id}`;
              return (
                <g key={d.index_id}>
                  <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.data} stopOpacity="0.22" />
                      <stop offset="100%" stopColor={s.data} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {pts.length > 1 && (
                    <path d={`${line} L${lastX.toFixed(1)},${H - PAD.b} L${pts[0][0].toFixed(1)},${H - PAD.b} Z`}
                          fill={`url(#${gid})`} stroke="none" />
                  )}
                  <path d={line} fill="none" stroke={s.data} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                  <circle cx={lastX} cy={y(last.value)} r="3.5" fill={s.data} />
                  <circle cx={lastX} cy={y(last.value)} r="7" fill={s.data} opacity="0.2" />
                  <text x={W - PAD.r + 10} y={labelYs[ri] + 4} fill={s.data} style={{ font: `600 12px ${tokens.font.mono}` }}>
                    {last.value.toFixed(1)}
                  </text>
                </g>
              );
            });
          })()}

          {hover && (() => {
            // Date-aligned hover: each series answers for the axis DATE, not
            // its own array position (short series were reporting wrong days).
            const at = rows
              .map(d => ({ d, p: aligned.get(d.index_id).find(p => p.i === hover.i) }))
              .filter(e => e.p != null);
            return (
              <g pointerEvents="none">
                <line x1={hover.x} x2={hover.x} y1={PAD.t} y2={H - PAD.b} stroke={tokens.color.inkSecondary} strokeWidth="1" strokeDasharray="3 3" />
                {at.map(({ d, p }) => (
                  <circle key={d.index_id} cx={hover.x} cy={y(p.value)} r="4"
                          fill={(tokens.series[d.index_id] ?? {}).data} stroke={tokens.color.bg} strokeWidth="2" />
                ))}
                <Tooltip x={hover.x} date={dates[hover.i]} rows={at.map(({ d, p }) => ({
                  label: tokens.series[d.index_id]?.label ?? d.index_id,
                  color: (tokens.series[d.index_id] ?? {}).data,
                  value: p.value.toFixed(2),
                }))} />
              </g>
            );
          })()}
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
          <text x="14" fill={tokens.color.ink} style={{ font: `11px ${tokens.font.mono}`, textTransform: 'uppercase' }}>{r.label} {r.value}</text>
        </g>
      ))}
    </g>
  );
}

/** 'is Pokémon down from a week ago / the window start?' at a glance
 *  (Kaleb, 2026-07-21). Series is window-renormalized to 100 at start. */

export function IndexTable({ data, dates }) {
  const step = Math.max(1, Math.floor(dates.length / 12));
  const rows = dates.filter((_, i) => i % step === 0 || i === dates.length - 1);
  // Series lengths are UNEVEN (dates come from the longest index; positional
  // indexing read past the end of a shorter one and blanked the page — live
  // crash, 2026-07-21). Look up by DATE; dash where an index has no point.
  const byDate = data.map(d => new Map(d.series.map(pt => [pt.as_of, pt.value])));
  return (
    <table style={{ borderCollapse: 'collapse', font: `12px ${tokens.font.mono}`, color: tokens.color.ink, textTransform: 'uppercase' }}>
      <thead>
        <tr>
          <th style={thStyle}>Date</th>
          {data.map(d => <th key={d.index_id} style={thStyle}>{tokens.series[d.index_id]?.label ?? d.index_id}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(date => (
          <tr key={date}>
            <td style={tdStyle}>{date}</td>
            {data.map((d, di) => {
              const v = byDate[di].get(date);
              return <td key={d.index_id} style={{ ...tdStyle, textAlign: 'right' }}>{v != null ? v.toFixed(2) : '—'}</td>;
            })}
          </tr>
        ))}
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
