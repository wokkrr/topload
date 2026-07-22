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
  db.exec('BEGIN');
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
  db.exec('COMMIT');
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
  db.exec('BEGIN');

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
  // Set-based (one statement per date): per-series loops don't scale to a
  // full-catalog import (183k series × query ≈ 40 min; this ≈ 1 s).
  const priCase = Object.entries(EXTERNAL_SOURCES)
    .map(([s, m]) => `WHEN '${s}' THEN ${m.priority}`).join(' ');
  const discCase = Object.entries(EXTERNAL_SOURCES)
    .map(([s, m]) => `WHEN '${s}' THEN ${m.discount}`).join(' ');
  const extStmt = db.prepare(`
    WITH latest AS (
      SELECT card_id, grade, source, MAX(as_of) AS obs_date
      FROM external_marks WHERE as_of <= :asOf
      GROUP BY card_id, grade, source
    ),
    fresh AS (
      SELECT l.*, CAST(julianday(:asOf) - julianday(l.obs_date) AS INTEGER) AS stale,
             CASE l.source ${priCase} ELSE 99 END AS pri,
             CASE l.source ${discCase} ELSE 0.4 END AS disc
      FROM latest l
      WHERE julianday(:asOf) - julianday(l.obs_date) <= 7
    ),
    best AS (
      SELECT f.* FROM fresh f
      WHERE NOT EXISTS (SELECT 1 FROM fresh f2 WHERE f2.card_id = f.card_id AND f2.grade = f.grade AND f2.pri < f.pri)
        AND NOT EXISTS (SELECT 1 FROM oracle_prices op
                        WHERE op.card_id = f.card_id AND op.grade = f.grade AND op.as_of = :asOf AND op.basis = 'solds')
    )
    INSERT OR REPLACE INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis, source)
    SELECT b.card_id, b.grade, :asOf, em.price_cents, 0, 0,
           ROUND(b.disc * (1 - b.stale / 14.0), 4), 'external', b.source
    FROM best b
    JOIN external_marks em
      ON em.card_id = b.card_id AND em.grade = b.grade AND em.source = b.source AND em.as_of = b.obs_date`);
  for (const asOf of dates) {
    const r = extStmt.run({ asOf });
    externalUsed += Number(r.changes);
    written += Number(r.changes);
  }

  db.exec('COMMIT');
  refreshLatestMarks(db);
  return { series: soldsSeries.length, marks: written, externalMarks: externalUsed };
}

/**
 * Rebuild the materialized latest_marks table: one row per (card, grade) with
 * the newest mark plus 1D/30D lookbacks. Costs a few seconds ONCE per data
 * change; saves the API from scanning/grouping oracle_prices (millions of
 * rows) on every request — /api/movers was 5.9s, /api/cards 1.3s without it.
 * Runs at the end of refreshOracle, so ingest AND every backfill keep it hot.
 */
export function refreshLatestMarks(db) {
  db.exec('BEGIN');
  db.exec('DELETE FROM latest_marks');
  db.exec(`
    INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, source,
                              sales_7d, sales_30d, price_1d, price_7d, prov_7d, price_30d)
    SELECT o.card_id, o.grade, o.as_of, o.price_cents, o.confidence, o.basis, o.source,
           o.sales_7d, o.sales_30d,
           (SELECT p.price_cents FROM oracle_prices p
             WHERE p.card_id = o.card_id AND p.grade = o.grade AND p.as_of = date(o.as_of, '-1 day')),
           -- 7D lookback = NEAREST mark at-or-before 7 days ago (daily rows can
           -- have gaps); prov_7d carries that mark's basis|source so movers can
           -- refuse cross-stream deltas (data events, not market moves).
           (SELECT p.price_cents FROM oracle_prices p
             WHERE p.card_id = o.card_id AND p.grade = o.grade AND p.as_of <= date(o.as_of, '-7 day')
             ORDER BY p.as_of DESC LIMIT 1),
           (SELECT p.basis || '|' || COALESCE(p.source, '') FROM oracle_prices p
             WHERE p.card_id = o.card_id AND p.grade = o.grade AND p.as_of <= date(o.as_of, '-7 day')
             ORDER BY p.as_of DESC LIMIT 1),
           (SELECT p.price_cents FROM oracle_prices p
             WHERE p.card_id = o.card_id AND p.grade = o.grade AND p.as_of = date(o.as_of, '-30 day'))
    FROM oracle_prices o
    JOIN (SELECT card_id, grade, MAX(as_of) d FROM oracle_prices GROUP BY card_id, grade) m
      ON m.card_id = o.card_id AND m.grade = o.grade AND m.d = o.as_of`);
  markTopGrades(db);
  db.exec('COMMIT');
  return db.prepare(`SELECT COUNT(*) n FROM latest_marks`).get().n;
}

/**
 * Precompute per-card lookup flags: is_top marks each card's highest-value
 * grade row; grades_tracked counts the ladder. Window functions at REQUEST
 * time over ~277k rows took /api/cards to 12s on the droplet (live,
 * 2026-07-21) — this runs once per rebuild instead.
 */
export function markTopGrades(db) {
  db.exec(`
    UPDATE latest_marks SET is_top = (r.rn = 1), grades_tracked = r.gt
    FROM (SELECT rowid AS rid,
                 ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY price_cents DESC) AS rn,
                 COUNT(*) OVER (PARTITION BY card_id) AS gt
          FROM latest_marks) r
    WHERE latest_marks.rowid = r.rid`);
}
