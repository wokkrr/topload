/**
 * Movers — biggest SEVEN-DAY oracle moves (Kaleb, 2026-07-22: 24h was too
 * quiet for a card market — cards trade weekly, not tick-by-tick; the 7D
 * window matches the asset's natural velocity). Two honesty gates:
 *
 *   1. SOLDS ONLY (Kaleb, 2026-07-22, after the −93% step-function wall):
 *      an ESTIMATE cannot be a mover — if nothing traded, the market didn't
 *      move, our estimate did. Same-source external marks still cliff when a
 *      rematch re-points a card to a better catalog product (source string
 *      unchanged → invisible to any provenance check). Solds-backed marks
 *      are computed from actual recorded sales, so their movement IS market
 *      movement. The list gets shorter and grows with sales coverage —
 *      honest and thin beats full and wrong.
 *   2. PROVENANCE-CONSISTENT DELTAS: the 7-days-ago mark must also be solds
 *      (prov_7d, precomputed in refreshLatestMarks) — a card that graduated
 *      external→solds mid-window is a data event, not a move.
 *   3. ONE ROW PER CARD: the same card in three slabs is one story, not
 *      three slots — the top-moving grade represents it.
 *
 * The ±500% sanity band stays as the outer rail. All lookbacks precomputed
 * (request-time window scans took /api/movers to 5.9s once — never again).
 */
export function getMovers(db, { limit = 20 } = {}) {
  return db.prepare(`
    WITH candidates AS (
      SELECT c.ip, c.name, c.set_name, lm.card_id, lm.grade,
             c.image AS card_image, c.image_kind AS card_kind,
             (SELECT g.image FROM gacha_listings g WHERE g.card_id = c.id AND g.image IS NOT NULL LIMIT 1) AS listing_photo,
             lm.price_cents AS price_now, lm.price_7d AS price_then,
             lm.confidence, lm.sales_7d,
             ROUND((lm.price_cents * 100.0 / lm.price_7d) - 100, 2) AS change_pct,
             ROW_NUMBER() OVER (
               PARTITION BY lm.card_id
               ORDER BY ABS((lm.price_cents * 1.0 / lm.price_7d) - 1) DESC, lm.grade
             ) AS rn
      FROM latest_marks lm
      JOIN cards c ON c.id = lm.card_id
      WHERE lm.confidence >= 0.3 AND lm.price_7d > 0
        AND lm.price_cents != lm.price_7d
        AND ABS((lm.price_cents * 1.0 / lm.price_7d) - 1) <= 5.0
        AND lm.basis = 'solds'
        AND lm.prov_7d = lm.basis || '|' || COALESCE(lm.source, '')
    )
    SELECT * FROM candidates WHERE rn = 1
    ORDER BY ABS(change_pct) DESC
    LIMIT ?`).all(limit);
}
