/**
 * Rules-based, liquidity-weighted indexes (per IP), normalized to 100.
 *
 * Basket construction (locked decision: rules-based, no editorial picks):
 *   at each rebalance date, basket = top-N (card, grade) series by trailing
 *   90D sales count, filtered to confidence ≥ minConfidence.
 *
 * Weighting: liquidity weight = oracle price × trailing weekly sales rate
 *   (i.e. proportional to dollar volume), fixed between rebalances.
 *
 * Chaining: at each rebalance the divisor is reset so the level is continuous
 *   (no jump from membership changes) — same idea as cap-weighted equity
 *   indexes, unlike price-averaged CL50 methodology.
 */

const DAY_MS = 86_400_000;

export const INDEX_DEFAULTS = {
  topN: 25,
  minConfidence: 0.3,
  rebalanceDays: 30,
  volumeLookbackDays: 90,
};

// ---------- pure math ----------

/**
 * Select the basket at a rebalance date.
 * @param {{card_id:string, grade:string, sales_90d:number, confidence:number, price_cents:number, weekly_sales:number}[]} candidates
 * @returns {{card_id:string, grade:string, weight:number}[]} weights sum to 1
 */
export function selectBasket(candidates, { topN = INDEX_DEFAULTS.topN, minConfidence = INDEX_DEFAULTS.minConfidence } = {}) {
  const eligible = candidates
    .filter(c => c.confidence >= minConfidence && c.sales_90d > 0 && c.price_cents > 0)
    .sort((a, b) => b.sales_90d - a.sales_90d || b.price_cents - a.price_cents)
    .slice(0, topN);
  const totalLiq = eligible.reduce((a, c) => a + c.price_cents * c.weekly_sales, 0);
  if (totalLiq === 0) return [];
  return eligible.map(c => ({
    card_id: c.card_id,
    grade: c.grade,
    weight: (c.price_cents * c.weekly_sales) / totalLiq,
  }));
}

/**
 * Compute a chained index series.
 * @param {string[]} dates ascending ISO dates
 * @param {(date:string) => Map<string, number>} pricesAt key `${card_id}|${grade}` -> price_cents
 * @param {(date:string) => {card_id:string, grade:string, weight:number}[]} basketAt basket in force on `date`
 * @returns {{as_of:string, value:number, raw_level:number}[]} value normalized to 100 at first date
 */
export function computeIndexSeries(dates, pricesAt, basketAt) {
  const out = [];
  let chain = 1;              // cumulative chained return
  let prevBasketKey = null;
  let basePrices = null;      // prices at last chain reset (rebalance or inception)
  let baseChain = 1;

  for (const date of dates) {
    const basket = basketAt(date);
    if (basket.length === 0) continue;
    const prices = pricesAt(date);
    const key = basket.map(b => `${b.card_id}|${b.grade}|${b.weight.toFixed(6)}`).join(',');

    if (key !== prevBasketKey) {
      // Rebalance: reset the base so the level is continuous across membership changes.
      basePrices = prices;
      baseChain = chain;
      prevBasketKey = key;
    }

    // Weighted relative level vs the rebalance base; missing marks carry weight at base (relative 1).
    let rel = 0, wsum = 0;
    for (const b of basket) {
      const k = `${b.card_id}|${b.grade}`;
      const p0 = basePrices.get(k);
      const p1 = prices.get(k) ?? p0;
      if (!p0 || p0 <= 0) continue;
      rel += b.weight * (p1 / p0);
      wsum += b.weight;
    }
    if (wsum === 0) continue;
    chain = baseChain * (rel / wsum);
    out.push({ as_of: date, raw_level: chain, value: 0 });
  }
  if (out.length === 0) return out;
  const base = out[0].raw_level;
  for (const row of out) row.value = +(100 * (row.raw_level / base)).toFixed(4);
  return out;
}

// ---------- DB plumbing ----------

function isoDaysBetween(startISO, endISO) {
  const out = [];
  for (let t = new Date(startISO).getTime(); t <= new Date(endISO).getTime(); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Rebuild basket_members + index_values for each IP over the oracle's date range. */
export function refreshIndexes(db, opts = {}) {
  const o = { ...INDEX_DEFAULTS, ...opts };
  const range = db.prepare(`SELECT MIN(as_of) lo, MAX(as_of) hi FROM oracle_prices`).get();
  if (!range?.lo) return { indexes: 0, points: 0 };
  const dates = isoDaysBetween(range.lo, range.hi);
  const ips = db.prepare(`SELECT DISTINCT ip FROM cards`).all().map(r => r.ip);

  const candStmt = db.prepare(`
    SELECT op.card_id, op.grade, op.price_cents, op.confidence,
           op.sales_30d * 3 AS sales_90d_est,   -- fallback if window shorter than 90d
           (op.sales_7d) AS weekly_sales,
           (SELECT COUNT(*) FROM sales s
             WHERE s.card_id = op.card_id AND s.grade = op.grade AND s.is_outlier = 0
               AND s.sold_at >= date(op.as_of, '-90 day') AND s.sold_at <= op.as_of) AS sales_90d
    FROM oracle_prices op
    JOIN cards c ON c.id = op.card_id
    WHERE c.ip = ? AND op.as_of = ?`);
  const priceStmt = db.prepare(`
    SELECT op.card_id, op.grade, op.price_cents
    FROM oracle_prices op JOIN cards c ON c.id = op.card_id
    WHERE c.ip = ? AND op.as_of = ?`);
  const insBasket = db.prepare(`INSERT OR REPLACE INTO basket_members (index_id, as_of, card_id, grade, weight) VALUES (?, ?, ?, ?, ?)`);
  const insValue = db.prepare(`INSERT OR REPLACE INTO index_values (index_id, as_of, value, raw_level) VALUES (?, ?, ?, ?)`);

  let points = 0;
  for (const ip of ips) {
    // Rebalance schedule: first date, then every rebalanceDays.
    const rebalanceDates = dates.filter((_, i) => i % o.rebalanceDays === 0);
    const baskets = new Map();
    for (const rd of rebalanceDates) {
      const basket = selectBasket(candStmt.all(ip, rd), o);
      if (basket.length) {
        baskets.set(rd, basket);
        for (const b of basket) insBasket.run(ip, rd, b.card_id, b.grade, b.weight);
      }
    }
    if (baskets.size === 0) continue;
    const basketAt = (date) => {
      let cur = [];
      for (const rd of rebalanceDates) {
        if (rd > date) break;
        if (baskets.has(rd)) cur = baskets.get(rd);
      }
      return cur;
    };
    const pricesAt = (date) => {
      const m = new Map();
      for (const r of priceStmt.all(ip, date)) m.set(`${r.card_id}|${r.grade}`, r.price_cents);
      return m;
    };
    const series = computeIndexSeries(dates, pricesAt, basketAt);
    for (const row of series) { insValue.run(ip, row.as_of, row.value, row.raw_level); points++; }
  }
  return { indexes: ips.length, points };
}
