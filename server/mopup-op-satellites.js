/**
 * JA-3: One Piece satellite mop-up — light up Japanese OP comps.
 *
 * ~6.5k Japanese (and leftover English) 'op-pc*' PriceCharting satellites hold
 * the OP price history, while the canonical rows (op-<code> / op-<code>-ja)
 * hold the identity. This migrates each satellite's PriceCharting id, marks,
 * sales, and listing/registry pointers onto its canonical match — via the
 * language-routed matcher, so 'One Piece Japanese …' satellites land on -ja
 * rows — then retires the satellite. Unmatched satellites are KEPT (still
 * priced, still tagged; never guess).
 *
 *   node server/mopup-op-satellites.js --dry   # report + samples, no writes
 *   node server/mopup-op-satellites.js         # migrate
 *
 * FK-safety: sales re-pointed before any delete; satellites with remaining
 * sales are never deleted. external_marks moves use UPDATE OR IGNORE (PK
 * source+card+grade+as_of) with leftover satellite marks deleted — canonical
 * targets start markless, so real conflicts ≈ none.
 *
 * AFTER a live run: `npm run oracle:refresh` so latest_marks/oracle rebuild
 * onto the canonical ids — that is the moment JP OP comps appear.
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';

export function mopupOpSatellites(db, { dry = false } = {}) {
  const canonical = db.prepare(
    `SELECT id, name, number, set_name, language FROM cards
     WHERE ip='OP' AND (json_extract(external_ids, '$.punkrecords') IS NOT NULL
                     OR json_extract(external_ids, '$.punkrecords_ja') IS NOT NULL)`
  ).all();
  const sats = db.prepare(
    `SELECT id, name, number, set_name, language, external_ids FROM cards
     WHERE ip='OP' AND id LIKE 'op-pc%'`
  ).all();

  const res = { satellites: sats.length, matched: 0, marksMoved: 0, marksDroppedDup: 0, salesMoved: 0, listingsRepointed: 0, registryRepointed: 0, retired: 0, keptUnmatched: 0, keptVariant: 0, samples: [] };
  if (!dry) db.exec('BEGIN');

  const moveMarks = db.prepare(`UPDATE OR IGNORE external_marks SET card_id = ? WHERE card_id = ?`);
  const dropLeftoverMarks = db.prepare(`DELETE FROM external_marks WHERE card_id = ?`);
  const moveSales = db.prepare(`UPDATE sales SET card_id = ? WHERE card_id = ?`);
  const moveListings = db.prepare(`UPDATE gacha_listings SET card_id = ? WHERE card_id = ?`);
  const moveRegistry = db.prepare(`UPDATE nft_registry SET card_id = ? WHERE card_id = ?`);
  const attachPc = db.prepare(
    `UPDATE cards SET external_ids = json_set(external_ids, '$.pricecharting',
       COALESCE(json_extract(external_ids, '$.pricecharting'), ?)) WHERE id = ?`
  );
  const dropSat = db.prepare(`DELETE FROM cards WHERE id = ? AND id NOT IN (SELECT DISTINCT card_id FROM sales)`);
  const dropDerived = [
    db.prepare(`DELETE FROM oracle_prices WHERE card_id = ?`),
    db.prepare(`DELETE FROM latest_marks  WHERE card_id = ?`),
    db.prepare(`DELETE FROM basket_members WHERE card_id = ?`),
  ];

  // Variant-tagged satellites ([Alternate Art], [SP Foil], [Manga], [Winner],
  // [Magazine], …) are PC's SEPARATE products for parallel printings that
  // trade at multiples of the base card. PC's label can't tell us WHICH
  // parallel row they belong to, so merging them into the base would pollute
  // base comps with alt-art prices — the exact mis-comp sin the oracle exists
  // to prevent (caught in the live dry run, 2026-07-21). They stay satellites.
  const VARIANT_RE = /\[|\]|\balternate art\b|\bparallel\b|\bmanga\b/i;

  for (const sat of sats) {
    if (VARIANT_RE.test(sat.name ?? '')) { res.keptVariant++; continue; }
    // The satellite's own fields ARE a listing-shaped title; the matcher's
    // language routing reads 'Japanese' straight out of the PC set name.
    const title = `${sat.name ?? ''} ${sat.number ?? ''} ${sat.set_name ?? ''}`.trim();
    const hit = matchListing(title, canonical);
    if (!hit) { res.keptUnmatched++; continue; }
    res.matched++;
    if (res.samples.length < 8) res.samples.push(`${sat.id} → ${hit}  (${title.slice(0, 60)})`);
    if (dry) continue;

    const pcId = (() => { try { return JSON.parse(sat.external_ids ?? '{}').pricecharting ?? null; } catch { return null; } })();
    const moved = Number(moveMarks.run(hit, sat.id).changes);
    res.marksMoved += moved;
    res.marksDroppedDup += Number(dropLeftoverMarks.run(sat.id).changes);
    res.salesMoved += Number(moveSales.run(hit, sat.id).changes);
    res.listingsRepointed += Number(moveListings.run(hit, sat.id).changes);
    res.registryRepointed += Number(moveRegistry.run(hit, sat.id).changes);
    if (pcId != null) attachPc.run(String(pcId), hit);
    for (const d of dropDerived) d.run(sat.id);
    res.retired += Number(dropSat.run(sat.id).changes);
  }

  if (!dry) db.exec('COMMIT');
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const dry = process.argv.includes('--dry');
  const res = mopupOpSatellites(db, { dry });
  console.log(`[mopup:op]${dry ? ' DRY RUN' : ''}`, JSON.stringify(res, null, 1));
  if (!dry) console.log('[mopup:op] NEXT: npm run oracle:refresh — that is when JP OP comps appear.');
}
