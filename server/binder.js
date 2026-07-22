/**
 * Binder portfolio series — the price action of what YOU hold (Kaleb,
 * 2026-07-22: "a visual chart of the price action" — the Collectr-beater).
 *
 * Sums qty × oracle mark per day across positions. Carry-forward semantics:
 * a position keeps its last known value on days its card didn't re-mark, so
 * data gaps never fake a portfolio dip. Days before a position's first mark
 * contribute nothing (honest: we didn't know its value yet). Positions the
 * oracle can't price contribute nothing — same rule as the Binder total.
 */
export function buildBinderSeries(db, positions, { days = 90 } = {}) {
  const q = db.prepare(
    `SELECT as_of, price_cents FROM oracle_prices
     WHERE card_id = ? AND grade = ? AND as_of >= date('now', ?)
     ORDER BY as_of`);
  const baseline = db.prepare(
    `SELECT price_cents FROM oracle_prices
     WHERE card_id = ? AND grade = ? AND as_of < date('now', ?)
     ORDER BY as_of DESC LIMIT 1`);

  const perPos = [];
  const dates = new Set();
  for (const p of positions.slice(0, 200)) {
    if (!p?.card_id) continue;
    const rows = q.all(String(p.card_id), String(p.grade ?? 'raw'), `-${days} day`);
    const base = baseline.get(String(p.card_id), String(p.grade ?? 'raw'), `-${days} day`)?.price_cents ?? null;
    if (!rows.length && base == null) continue;
    for (const r of rows) dates.add(r.as_of);
    perPos.push({ qty: Math.max(1, Number(p.qty) || 1), base, byDate: new Map(rows.map(r => [r.as_of, r.price_cents])) });
  }
  const axis = [...dates].sort();
  if (!axis.length) return [];

  const carry = perPos.map(p => p.base);   // value entering the window
  return axis.map(d => {
    let value = 0, priced = 0;
    perPos.forEach((p, i) => {
      const v = p.byDate.get(d);
      if (v != null) carry[i] = v;
      if (carry[i] != null) { value += carry[i] * p.qty; priced++; }
    });
    return { as_of: d, value_cents: value, priced };
  });
}
