/**
 * Movers — biggest one-day oracle moves, with two honesty gates (Kaleb,
 * 2026-07-22: "make any changes you think would make it more accurate"):
 *
 *   1. PROVENANCE-CONSISTENT DELTAS: a move only qualifies if yesterday's
 *      mark came from the SAME basis+source as today's. When a new data
 *      source lands (TCGplayer import re-marking stale cards) or a card
 *      graduates external→solds, the day-over-day delta is a DATA EVENT,
 *      not a market move — the +483% Snorlax wall, live 2026-07-22.
 *   2. ONE ROW PER CARD: the same card in three slabs is one story, not
 *      three slots — the top-moving grade represents it, freeing the
 *      leaderboard for eight different cards.
 *
 * The ±500% sanity band stays as the outer rail for same-source repricings.
 */
export function getMovers(db, { limit = 20 } = {}) {
  return db.prepare(`
    WITH candidates AS (
      SELECT c.ip, c.name, c.set_name, lm.card_id, lm.grade,
             c.image AS card_image, c.image_kind AS card_kind,
             (SELECT g.image FROM gacha_listings g WHERE g.card_id = c.id AND g.image IS NOT NULL LIMIT 1) AS listing_photo,
             lm.price_cents AS price_now, lm.price_1d AS price_then,
             lm.confidence, lm.sales_7d,
             ROUND((lm.price_cents * 100.0 / lm.price_1d) - 100, 2) AS change_pct,
             ROW_NUMBER() OVER (
               PARTITION BY lm.card_id
               ORDER BY ABS((lm.price_cents * 1.0 / lm.price_1d) - 1) DESC, lm.grade
             ) AS rn
      FROM latest_marks lm
      JOIN cards c ON c.id = lm.card_id
      WHERE lm.confidence >= 0.3 AND lm.price_1d > 0
        AND lm.price_cents != lm.price_1d
        AND ABS((lm.price_cents * 1.0 / lm.price_1d) - 1) <= 5.0
        AND (SELECT op.basis || '|' || COALESCE(op.source, '')
             FROM oracle_prices op
             WHERE op.card_id = lm.card_id AND op.grade = lm.grade AND op.as_of < lm.as_of
             ORDER BY op.as_of DESC LIMIT 1)
            = lm.basis || '|' || COALESCE(lm.source, '')
    )
    SELECT * FROM candidates WHERE rn = 1
    ORDER BY ABS(change_pct) DESC
    LIMIT ?`).all(limit);
}
