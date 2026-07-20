/**
 * The accuracy-pass loupe: print FULL unmatched listing titles for a platform,
 * so title-shape problems are diagnosable instead of guessed at (coverage.js
 * buckets truncate to 5 words — good for ranking gaps, useless for debugging).
 *
 *   node server/debug-unmatched.js [platform] [n]     (default courtyard 15)
 */
import { openDb } from './db.js';

const [plat = 'courtyard', nArg = '15'] = process.argv.slice(2);
const db = openDb();

const un = db.prepare(
  `SELECT item_name, category FROM gacha_listings
   WHERE platform = ? AND card_id IS NULL ORDER BY seen_at DESC LIMIT ?`
).all(plat, Number(nArg));
const total = db.prepare(`SELECT COUNT(*) n, SUM(card_id IS NOT NULL) m FROM gacha_listings WHERE platform = ?`).get(plat);

console.log(`\n=== ${plat}: ${total.m}/${total.n} matched — ${un.length} unmatched samples (full titles) ===\n`);
for (const r of un) console.log(`[${r.category ?? '?'}] ${r.item_name}`);

// A few matched ones for contrast — what a working title looks like on this platform.
const ok = db.prepare(
  `SELECT item_name, card_id FROM gacha_listings
   WHERE platform = ? AND card_id IS NOT NULL ORDER BY seen_at DESC LIMIT 5`
).all(plat);
console.log(`\n--- matched, for contrast ---`);
for (const r of ok) console.log(`${r.card_id}  ←  ${r.item_name}`);
