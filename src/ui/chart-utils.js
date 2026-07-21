/**
 * Shared chart presentation helpers — ONE visual language across every chart
 * (Kaleb, 2026-07-21: "make sure changes to the charts carry over to the
 * card and listing charts").
 */

/**
 * Catmull-Rom → cubic bezier smoothing (presentation only — hover/tooltips
 * must keep reporting exact point values). Degrades to a segment for 2 pts.
 * @param {[number, number][]} pts
 */
export function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Nudge same-edge labels apart so close series never print on top of each
 * other (live bug 2026-07-21: PKMN + YGO endpoint values both ~100 rendered
 * as garbled overlap). Returns adjusted y per entry, original order.
 * @param {{y:number}[]} entries  @param {number} minGap  @param {[number,number]} bounds
 */
export function spreadLabels(entries, minGap = 15, bounds = null) {
  const order = entries.map((e, i) => ({ ...e, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k].y - order[k - 1].y < minGap) order[k].y = order[k - 1].y + minGap;
  }
  if (bounds) {
    // Push back up if the stack ran past the bottom bound.
    for (let k = order.length - 1; k >= 0; k--) {
      const maxY = bounds[1] - (order.length - 1 - k) * minGap;
      if (order[k].y > maxY) order[k].y = maxY;
      if (k < order.length - 1 && order[k + 1].y - order[k].y < minGap) order[k].y = order[k + 1].y - minGap;
    }
    if (order[0]?.y < bounds[0]) order[0].y = bounds[0];
  }
  const out = new Array(entries.length);
  for (const e of order) out[e.i] = e.y;
  return out;
}
