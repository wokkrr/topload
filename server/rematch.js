/**
 * Maintenance: rebuild all listing→card attribution with the current (strict)
 * matcher, and purge data attributed under older, looser rules.
 *
 * Run after any matcher change: npm run rematch
 * Then re-run `npm run solana:backfill` to re-ingest on-chain sales with
 * clean attribution (cursors are reset here on purpose).
 *
 * --listings-only : re-match gacha_listings + nft_registry ONLY, and leave
 *   sales / cursors untouched. Use this after a CATALOG change (e.g. seeding
 *   the canonical One Piece cards) where the matcher itself did NOT change and
 *   sales are already correctly attributed (the seed re-points them). This is
 *   the safe path — it never destroys on-chain sales or forces a full backfill.
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';

const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO' };

const listingsOnly = process.argv.includes('--listings-only');
const db = openDb();
const universeByIp = {};
for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) {
  (universeByIp[c.ip] ??= []).push(c);
}

db.exec('BEGIN');

// 1. Gacha listings: re-match every row, franchise-scoped.
let listingsMatched = 0, listingsCleared = 0;
const updListing = db.prepare(`UPDATE gacha_listings SET card_id = ? WHERE platform = ? AND external_id = ?`);
for (const l of db.prepare(`SELECT platform, external_id, item_name, category, card_id FROM gacha_listings`).all()) {
  const ip = CATEGORY_TO_IP[l.category];
  const hit = ip ? matchListing(l.item_name, universeByIp[ip] ?? []) : null;
  updListing.run(hit, l.platform, l.external_id);
  if (hit) listingsMatched++;
  else if (l.card_id) listingsCleared++;
}

// 2. NFT registry: re-match from stored item_name (overwrites old attributions,
//    including clearing ones the strict matcher no longer stands behind).
let regMatched = 0, regCleared = 0;
const updReg = db.prepare(`UPDATE nft_registry SET card_id = ? WHERE mint = ?`);
for (const r of db.prepare(`SELECT mint, item_name, category, card_id FROM nft_registry`).all()) {
  const ip = CATEGORY_TO_IP[r.category];
  const hit = ip && r.item_name ? matchListing(r.item_name, universeByIp[ip] ?? []) : null;
  updReg.run(hit, r.mint);
  if (hit) regMatched++;
  else if (r.card_id) regCleared++;
}

// 3. On-chain sales: attributions were made under the previous matcher — purge
//    ALL sources and reset ALL cursors so backfills re-walk the same history
//    with clean attribution. Registry keeps item_names, so re-attribution is
//    instant (no metadata refetches); the nightly crons regrow the totals.
//    SKIPPED in --listings-only mode: a catalog change doesn't invalidate sale
//    attribution (the seed already re-points sales), so keep them.
let purged = 0;
if (!listingsOnly) {
  purged = db.prepare(`SELECT COUNT(*) n FROM sales`).get().n;
  db.exec(`DELETE FROM sales`);
  db.exec(`DELETE FROM oracle_prices WHERE basis = 'solds'`);
  db.exec(`DELETE FROM indexer_state`);
}

db.exec('COMMIT');

console.log('[rematch]', JSON.stringify({
  mode: listingsOnly ? 'listings-only (sales kept)' : 'full (sales purged)',
  listings: { matched: listingsMatched, cleared: listingsCleared },
  registry: { matched: regMatched, cleared: regCleared },
  onchainSalesPurged: purged,
  next: listingsOnly
    ? 'refresh oracle/latest_marks so newly-matched cards surface comps'
    : 'backfills (manual or nightly cron) re-ingest sales with clean attribution',
}, null, 1));
