/**
 * Topload price oracle.
 *
 * Non-negotiables (from spec):
 *  - solds-based, never asking prices (enforced upstream: only `sales` feed this)
 *  - outlier-filtered: drop sales >2σ from the trailing median
 *  - liquidity-aware: confidence score reflects sale count, dispersion, recency
 *  - per (card, grade) granularity
 *
 * Pure math lives at the top (unit-tested); DB plumbing at the bottom.
 */

const DAY_MS = 86_400_000;

export const ORACLE_DEFAULTS = {
  outlierWindow: 20,      // trailing sales used to judge a new sale
  outlierSigma: 2,        // drop if |price - trailing median| > 2σ
  markWindowDays: 14,     // trailing window for the daily mark
  markWindowExpandDays: 30, // widen to this if too few sales in 14d
  minSalesForMark: 3,
};

// ---------- pure math ----------

export function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stddev(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
}

/**
 * Flag outliers in a chronologically sorted list of sale prices.
 * A sale is an outlier if it deviates from the trailing-window median by
 * more than `sigma` trailing standard deviations. The first few sales
 * (before a window exists) are never flagged.
 * @param {{price_cents:number}[]} sales sorted by sold_at ascending
 * @returns {boolean[]} outlier flag per sale
 */
export function flagOutliers(sales, { window = ORACLE_DEFAULTS.outlierWindow, sigma = ORACLE_DEFAULTS.outlierSigma } = {}) {
  const flags = new Array(sales.length).fill(false);
  const trailing = []; // non-outlier prices only, so one bad print doesn't poison the window
  for (let i = 0; i < sales.length; i++) {
    const p = sales[i].price_cents;
    if (trailing.length >= 5) {
      const win = trailing.slice(-window);
      const med = median(win);
      const sd = stddev(win);
      // Floor σ at 5% of median so ultra-stable series still admit normal variance.
      const bound = sigma * Math.max(sd, 0.05 * med);
      if (Math.abs(p - med) > bound) {
        flags[i] = true;
        continue;
      }
    }
    trailing.push(p);
  }
  return flags;
}

/**
 * Confidence score in [0,1] for a mark.
 * liquidity: saturates at ~10 sales in window.
 * dispersion: coefficient of variation penalty (noisy comps -> less trust).
 * recency: fraction of window-sales that occurred in the most recent half.
 */
export function confidenceScore({ n, cv, recentShare }) {
  if (n === 0) return 0;
  const liquidity = Math.min(1, n / 10);
  const tightness = 1 - 0.5 * Math.min(1, cv);
  const recency = 0.5 + 0.5 * Math.min(1, recentShare * 2); // 0.5 floor; full credit at ≥50% recent
  return +(liquidity * tightness * recency).toFixed(4);
}

/**
 * Compute the daily mark for one (card, grade) on `asOf` from non-outlier sales.
 * @param {{price_cents:number, sold_at:string}[]} sales non-outlier, any order
 * @param {Date|string} asOf
 * @returns {{price_cents:number, confidence:number, n:number}|null}
 */
export function computeMark(sales, asOf, opts = {}) {
  const { markWindowDays, markWindowExpandDays, minSalesForMark } = { ...ORACLE_DEFAULTS, ...opts };
  const end = new Date(asOf).getTime() + DAY_MS; // include asOf day
  const inWindow = (days) => sales.filter(s => {
    const t = new Date(s.sold_at).getTime();
    return t < end && t >= end - days * DAY_MS;
  });
  let windowDays = markWindowDays;
  let win = inWindow(windowDays);
  if (win.length < minSalesForMark) {
    windowDays = markWindowExpandDays;
    win = inWindow(windowDays);
  }
  if (win.length < minSalesForMark) return null;

  const prices = win.map(s => s.price_cents);
  const med = median(prices);
  const cv = med > 0 ? stddev(prices) / med : 0;
  const half = end - (windowDays / 2) * DAY_MS;
  const recentShare = win.filter(s => new Date(s.sold_at).getTime() >= half).length / win.length;
  return {
    price_cents: Math.round(med),
    confidence: confidenceScore({ n: win.length, cv, recentShare }),
    n: win.length,
  };
}

// ---------- DB plumbing ----------

/** Re-run outlier detection for every (card, grade) series and persist flags. */
export function refreshOutlierFlags(db, opts = {}) {
  const series = db.prepare(
    `SELECT DISTINCT card_id, grade FROM sales`
  ).all();
  const upd = db.prepare(`UPDATE sales SET is_outlier = ?, outlier_reason = ? WHERE id = ?`);
  let flagged = 0;
  for (const { card_id, grade } of series) {
    const rows = db.prepare(
      `SELECT id, price_cents FROM sales WHERE card_id = ? AND grade = ? ORDER BY sold_at, id`
    ).all(card_id, grade);
    const flags = flagOutliers(rows, opts);
    for (let i = 0; i < rows.length; i++) {
      upd.run(flags[i] ? 1 : 0, flags[i] ? `>${opts.sigma ?? ORACLE_DEFAULTS.outlierSigma}σ from trailing median` : null, rows[i].id);
      if (flags[i]) flagged++;
    }
  }
  return { series: series.length, flagged };
}

/**
 * External source registry. Lower priority number wins when multiple sources
 * cover the same (card, grade, date). Discounts reflect how close each source
 * is to real solds:
 *  - pricecharting: derived from actual sold listings, per-grade → 0.7
 *  - tcgplayer: pokemontcg.io's bundled TCGplayer *market price* snapshot —
 *    asking-adjacent, raw only → 0.5 (free bootstrap tier)
 */
export const EXTERNAL_SOURCES = {
  pricecharting: { discount: 0.7, priority: 1 },
  tcgplayer: { discount: 0.5, priority: 2 },
};
/** Back-compat: default discount (pricecharting tier). */
export const EXTERNAL_CONFIDENCE_DISCOUNT = 0.7;

/**
 * Compute and persist oracle marks for every (card, grade) on each date in `dates`.
 * Priority per (card, grade, date):
 *   1. 'solds'    — computed from raw non-outlier sales when enough exist
 *   2. 'external' — best-priority external observation within 7 days,
 *                   confidence = per-source discount × staleness decay
 */
export function refreshOracle(db, dates, opts = {}) {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let written = 0, externalUsed = 0;

  // Pass 1: first-class marks from raw solds.
  const soldsSeries = db.prepare(`SELECT DISTINCT card_id, grade FROM sales WHERE is_outlier = 0`).all();
  const marked = new Set();
  for (const { card_id, grade } of soldsSeries) {
    const sales = db.prepare(
      `SELECT price_cents, sold_at FROM sales WHERE card_id = ? AND grade = ? AND is_outlier = 0 ORDER BY sold_at`
    ).all(card_id, grade);
    for (const asOf of dates) {
      const mark = computeMark(sales, asOf, opts);
      if (!mark) continue;
      const end = new Date(asOf).getTime() + DAY_MS;
      const count = (days) => sales.filter(s => {
        const t = new Date(s.sold_at).getTime();
        return t < end && t >= end - days * DAY_MS;
      }).length;
      ins.run(card_id, grade, asOf, mark.price_cents, count(7), count(30), mark.confidence, 'solds', null);
      marked.add(`${card_id}|${grade}|${asOf}`);
      written++;
    }
  }

  // Pass 2: external bootstrap where no solds mark exists — best source wins.
  const extSeries = db.prepare(`SELECT DISTINCT card_id, grade FROM external_marks`).all();
  for (const { card_id, grade } of extSeries) {
    const obs = db.prepare(
      `SELECT source, price_cents, as_of FROM external_marks WHERE card_id = ? AND grade = ? ORDER BY as_of`
    ).all(card_id, grade);
    for (const asOf of dates) {
      if (marked.has(`${card_id}|${grade}|${asOf}`)) continue;
      // Freshest observation per source at or before asOf, no older than 7 days.
      const bySource = new Map();
      for (const o of obs) { if (o.as_of <= asOf) bySource.set(o.source, o); }
      let best = null, bestMeta = null;
      for (const [source, o] of bySource) {
        const meta = EXTERNAL_SOURCES[source] ?? { discount: 0.4, priority: 99 };
        const staleDays = Math.round((new Date(asOf) - new Date(o.as_of)) / DAY_MS);
        if (staleDays > 7) continue;
        if (!best || meta.priority < bestMeta.priority) { best = { ...o, staleDays }; bestMeta = meta; }
      }
      if (!best) continue;
      const confidence = +(bestMeta.discount * (1 - best.staleDays / 14)).toFixed(4);
      ins.run(card_id, grade, asOf, best.price_cents, 0, 0, confidence, 'external', best.source);
      externalUsed++;
      written++;
    }
  }

  return { series: soldsSeries.length + extSeries.length, marks: written, externalMarks: externalUsed };
}
