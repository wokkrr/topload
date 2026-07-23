/**
 * PriceCharting HISTORY harvest (2026-07-23, Kaleb: "let's try to get that
 * past price history that we can feed to the platform however we can.
 * Without it our numbers and charts look very weak.")
 *
 * Probe verdict (probe-pc-history.js, live): every PC product page embeds
 * VGPC.chart_data — MONTHLY price points Jan-2021 → present (~67 points)
 * across six condition buckets, the EXACT fields we already map daily from
 * their CSV:  used→raw · graded→PSA9 · manualonly→PSA10 · boxonly→G9.5 ·
 * new→BGS10 · cib→CGC10.
 *
 * Posture (protect the Legendary subscription — the CSV is the spine's
 * bloodstream): (1) email PC for a sanctioned bulk export — front door
 * first; (2) PASSIVE harvest — the nightly art pass already downloads these
 * pages, so extracting history from the same response bytes costs PC zero
 * extra requests; (3) the dedicated backfill walker (pc-history-backfill)
 * is gentle by construction: value-sorted, hard limit, ≥1.5s delay, robots-
 * honoring — and stays modest unless/until PC answers the email.
 *
 * Storage: external_marks (source 'pricecharting', monthly as_of) — the
 * same rows the daily CSV writes, just backward in time. The card page's
 * MARKET line reads them directly.
 */

// PC chart bucket → our grade ladder (mirrors CSV_GRADE_FIELDS exactly).
export const CHART_GRADE_FIELDS = {
  used: 'raw',
  graded: 'PSA9',
  manualonly: 'PSA10',
  boxonly: 'G9.5',
  new: 'BGS10',
  cib: 'CGC10',
};

/** Extract VGPC.chart_data from a product page. → {bucket: [[ms, cents], …]} or null. */
export function extractChartData(html) {
  const m = /VGPC\.chart_data\s*=\s*(\{[\s\S]*?\});/.exec(html ?? '');
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return Object.keys(CHART_GRADE_FIELDS).some(k => Array.isArray(data[k]) && data[k].length) ? data : null;
  } catch { return null; }
}

/**
 * Write one card's harvested history into external_marks. Idempotent
 * (INSERT OR IGNORE — the daily CSV's today-rows always win over a monthly
 * point on the same date). Returns points written.
 */
export function storeChartHistory(db, cardId, chartData) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO external_marks (source, card_id, grade, as_of, price_cents)
     VALUES ('pricecharting', ?, ?, ?, ?)`);
  let written = 0;
  for (const [bucket, grade] of Object.entries(CHART_GRADE_FIELDS)) {
    for (const p of chartData[bucket] ?? []) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const [ms, cents] = p;
      if (!Number.isFinite(ms) || !Number.isFinite(cents) || cents <= 0) continue;
      written += Number(ins.run(cardId, grade, new Date(ms).toISOString().slice(0, 10), Math.round(cents)).changes);
    }
  }
  return written;
}
