/**
 * Value Pulse (Kaleb, 2026-07-21: "I'm curious what you are seeing for the
 * deals view, let's test out something like that") — the terminal's sharpest
 * question answered as a feed: WHICH LIVE ASKS SIT UNDER THE ORACLE MARK?
 *
 * Honesty rails, because a "deal" that isn't one poisons trust faster than
 * no feature:
 *   - only grade-matched marks (listing's own grade, never a proxy grade)
 *   - confidence gate (default ≥0.5 — external bootstrap marks qualify only
 *     from the trusted tier up)
 *   - discount band 5%–80%: under 5% is noise/fees; over 80% is almost
 *     always a bad match, a stale mark, or a troll listing — excluded, not
 *     celebrated
 *   - cross-marketplace mirrors deduped (host listing wins, phyg: provenance
 *     loses — same rule as the desk)
 *   - liquidity shown next to every discount (sales_30d): a 30% discount on
 *     something that never trades is not an exit
 */

/** Same-mint dedupe: host listing outranks the Phygitals mirror; earliest wins ties. */
export function dedupeByMint(rows) {
  const byMint = new Map();
  for (const r of rows) {
    if (!r.nft_address) continue;
    (byMint.get(r.nft_address) ?? byMint.set(r.nft_address, []).get(r.nft_address)).push(r);
  }
  const drop = new Set();
  for (const group of byMint.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) =>
      (String(a.external_id ?? '').startsWith('phyg:') - String(b.external_id ?? '').startsWith('phyg:'))
      || String(a.listed_at ?? '9999').localeCompare(String(b.listed_at ?? '9999'))
    )[0];
    for (const g of group) if (g !== keep) drop.add(g);
  }
  return rows.filter(r => !drop.has(r));
}

/**
 * Append today's surfaced deals to pulse_log — the outcome ledger. Judgment
 * comes later by disposition: join a past day's log against current listings
 * and sales (sold near mark? delisted? still sitting? price cut?). First
 * write per (day, listing) wins; re-runs are no-ops.
 */
export function logPulse(db, deals, asOf) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO pulse_log
    (as_of, platform, external_id, card_id, grade, ask_cents, mark_cents, discount, basis, confidence, sales_30d)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const d of deals) {
    n += ins.run(asOf, d.platform, d.external_id, d.card_id, d.grade,
                 d.ask_cents, d.mark_cents, d.discount, d.basis ?? null,
                 d.confidence ?? null, d.sales_30d ?? null).changes;
  }
  return n;
}

export function getDeals(db, {
  limit = 15, minConfidence = 0.5, minDiscount = 0.05, maxDiscount = 0.80, minAskCents = 500,
} = {}) {
  const rows = db.prepare(`
    SELECT g.platform, g.external_id, g.item_name, g.grade, g.price_cents AS ask_cents,
           g.image, g.nft_address, g.listed_at, g.card_id,
           c.name AS card_name, c.set_name, c.number, c.ip,
           lm.price_cents AS mark_cents, lm.confidence, lm.basis, lm.source,
           lm.sales_7d, lm.sales_30d
    FROM gacha_listings g
    JOIN cards c ON c.id = g.card_id
    JOIN latest_marks lm ON lm.card_id = g.card_id AND lm.grade = g.grade
    WHERE g.price_cents >= ? AND lm.price_cents > 0 AND lm.confidence >= ?`)
    .all(minAskCents, minConfidence);
  return dedupeByMint(rows)
    .map(r => ({ ...r, discount: +(1 - r.ask_cents / r.mark_cents).toFixed(4) }))
    .filter(r => r.discount >= minDiscount && r.discount <= maxDiscount)
    .sort((a, b) => b.discount - a.discount)
    .slice(0, limit);
}
