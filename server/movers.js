/**
 * Movers — biggest SEVEN-DAY oracle moves (Kaleb, 2026-07-22: 24h was too
 * quiet for a card market — cards trade weekly, not tick-by-tick; the 7D
 * window matches the asset's natural velocity). Two honesty gates:
 *
 *   1. PROVENANCE-CONSISTENT DELTAS: a move only qualifies if the 7-days-ago
 *      mark came from the SAME basis+source as today's (prov_7d, precomputed
 *      in refreshLatestMarks). When a new data source lands or a card
 *      graduates external→solds, the delta is a DATA EVENT, not a market
 *      move — the +483% Snorlax wall, live 2026-07-22.
 *   2. ONE ROW PER CARD: the same card in three slabs is one story, not
 *      three slots — the top-moving grade represents it.
 *
 * The ±500% sanity band stays as the outer rail for same-source repricings.
 * All lookbacks precomputed (request-time window scans took /api/movers to
 * 5.9s on the droplet once before — never again).
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
        AND lm.prov_7d = lm.basis || '|' || COALESCE(lm.source, '')
    )
    SELECT * FROM candidates WHERE rn = 1
    ORDER BY ABS(change_pct) DESC
    LIMIT ?`).all(limit);
}
