/**
 * Art borrowing — fill artless PriceCharting satellite rows with the OFFICIAL
 * scan of a same-artwork sibling.
 *
 * The catalog's priciest rows (Illustrator Pikachu, 1st Edition Base Set
 * Charizard, …) are PC satellites: real prices, no artwork — so the terminal's
 * default price-sorted views render a wall of empty thumbnails (Kaleb,
 * 2026-07-21). But a [1st Edition] / [Reverse Holo] / [Shadowless] variant
 * shares its ARTWORK with the base printing we do have art for. This pass
 * routes each artless satellite through the conservative matcher against
 * art-bearing canonical rows and copies the sibling's image.
 *
 * Guardrails:
 * - WHITELIST of same-artwork variant tags only. [Alt Art]/[Manga]/[Full Art]
 *   and friends are DIFFERENT artwork — never borrowed, empty is honest.
 * - The matcher's language routing means Japanese satellites only match
 *   Japanese donors (which have art only for OP) — English art is never
 *   passed off as a Japanese printing. JP PKMN art arrives with the TCGdex
 *   layer, not here.
 * - Borrowed rows are marked image_kind='borrowed' and never become donors.
 *
 *   node server/seed-borrow-art.js --dry   # report only
 *   node server/seed-borrow-art.js         # write
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';

// Variant tags that reuse the base printing's artwork. Anything ELSE in
// brackets is presumed different art and skipped.
const SAFE_VARIANT = /\[(1st edition|reverse holo|no rarity|shadowless|unlimited|non[- ]?holo|holo|error|staff|promo)\]/i;

export function borrowArt(db, { dry = false } = {}) {
  const donorsByIp = {};
  const donorById = new Map();
  for (const c of db.prepare(
    `SELECT id, ip, name, number, set_name, language, image FROM cards
     WHERE image IS NOT NULL AND image_kind IS NULL`   // own art only: borrowed/variant rows never donate
  ).all()) {
    (donorsByIp[c.ip] ??= []).push(c);
    donorById.set(c.id, c);
  }
  const targets = db.prepare(
    `SELECT id, ip, name, number, set_name, language FROM cards
     WHERE image IS NULL AND id LIKE '%-pc%'`
  ).all();

  const upd = db.prepare(`UPDATE cards SET image = ?, image_kind = 'borrowed' WHERE id = ?`);
  const res = { targets: targets.length, eligible: 0, borrowed: 0, skippedVariant: 0, unmatched: 0, samples: [] };

  for (const t of targets) {
    const bracketed = /\[/.test(t.name ?? '');
    if (bracketed && !SAFE_VARIANT.test(t.name)) { res.skippedVariant++; continue; }
    res.eligible++;
    // The satellite's own fields are a listing-shaped title; the matcher's
    // set/number/language evidence rules do the safety work.
    const title = `${t.name ?? ''} ${t.number ?? ''} ${t.set_name ?? ''}`.trim();
    const hit = matchListing(title, donorsByIp[t.ip] ?? []);
    const donor = hit ? donorById.get(hit) : null;
    if (!donor?.image) { res.unmatched++; continue; }
    res.borrowed++;
    if (res.samples.length < 10) res.samples.push(`${t.id} ← ${donor.id}`);
    if (!dry) upd.run(donor.image, t.id);
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const dry = process.argv.includes('--dry');
  const res = borrowArt(db, { dry });
  console.log(`[borrow-art]${dry ? ' DRY RUN' : ''}`, JSON.stringify(res, null, 1));
}
