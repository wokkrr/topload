/**
 * MNSTR intake monitor (Kaleb, 2026-07-23). Inquiry-stage listings
 * (canBeSold:false) never reach the desk — "they add another layer to the
 * buy flow which isn't ideal… I don't really care to have the listings up
 * if they aren't instant buy now listings." But we keep watching: each
 * ingest cycle records new intake serials and stamps graduations, so the
 * log can answer how MNSTR's pipeline works — days in intake, price at
 * graduation vs the intake placeholder, share of inventory in the pipe.
 *
 * Query later, e.g.:
 *   SELECT COUNT(*) FROM mnstr_intake_log WHERE graduated_at IS NULL;   -- in the pipe
 *   SELECT AVG(julianday(graduated_at) - julianday(first_seen)) FROM mnstr_intake_log WHERE graduated_at IS NOT NULL;
 */
export function recordIntakeTransitions(db, listings, asOf) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO mnstr_intake_log (serial, first_seen, intake_price_cents, intake_fmv_cents)
     VALUES (?, ?, ?, ?)`);
  const grad = db.prepare(
    `UPDATE mnstr_intake_log SET graduated_at = ?, buy_price_cents = ?
     WHERE serial = ? AND graduated_at IS NULL`);
  let intake = 0, graduated = 0;
  for (const l of listings) {
    if (l.platform !== 'mnstr' || !l.nft_address) continue;
    if (l.listing_type === 'inquiry') {
      if (ins.run(l.nft_address, asOf, l.price_cents ?? null,
                  l.fmv_usd != null ? Math.round(l.fmv_usd * 100) : null).changes) intake++;
    } else if (grad.run(asOf, l.price_cents ?? null, l.nft_address).changes) {
      graduated++;
    }
  }
  return { intake, graduated };
}
