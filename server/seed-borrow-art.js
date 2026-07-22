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
// 'gold star' / 'prize pack' (2026-07-22, art census): DESCRIPTIVE brackets —
// PC writes 'Pikachu [Gold Star] Holon Phantoms 104' but Gold Star IS the
// card at that number; the canonical #104 carries the same official art.
// Prize Pack reprints reuse the original printing's artwork unchanged.
const SAFE_VARIANT = /\[(1st edition|reverse holo|no rarity|shadowless|unlimited|non[- ]?holo|holo|error|staff|promo|gold star|prize pack)\]/i;

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
  // Quality tiering (Kaleb, 2026-07-22): a borrowed OFFICIAL scan also
  // upgrades a 'pricecharting' product photo (lowest tier). It never replaces
  // a tcgplayer scan — that one shows the EXACT printing.
  const targets = db.prepare(
    `SELECT id, ip, name, number, set_name, language FROM cards
     WHERE (image IS NULL OR image_kind = 'pricecharting') AND id LIKE '%-pc%'`
  ).all();

  const upd = db.prepare(
    `UPDATE cards SET image = ?, image_kind = 'borrowed'
     WHERE id = ? AND (image IS NULL OR image_kind = 'pricecharting')`);
  const res = { targets: targets.length, eligible: 0, borrowed: 0, skippedVariant: 0, unmatched: 0, samples: [] };

  for (const t of targets) {
    const bracketed = /\[/.test(t.name ?? '');
    if (bracketed && !SAFE_VARIANT.test(t.name)) { res.skippedVariant++; continue; }
    res.eligible++;
    // The satellite's own fields are a listing-shaped title; the matcher's
    // set/number/language evidence rules do the safety work.
    const titles = [`${t.name ?? ''} ${t.number ?? ''} ${t.set_name ?? ''}`.trim()];
    // Descriptive bracket: canonical Gold Stars are named 'Pikachu ★' (norms
    // to 'pikachu' — the plain title hits) or 'Pikachu Star' (needs the
    // bracket rewritten to the name form). Try both; matcher stays the judge.
    if (/\[gold star\]/i.test(t.name ?? '')) {
      titles.push(`${t.name.replace(/\s*\[gold star\]/i, ' Star')} ${t.number ?? ''} ${t.set_name ?? ''}`.trim());
    }
    let hit = null;
    for (const title of titles) { hit = matchListing(title, donorsByIp[t.ip] ?? []); if (hit) break; }
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
