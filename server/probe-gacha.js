/**
 * One-shot probe: fetch one page of real Collector Crypt listings and show how
 * they parse + match against the tracked card universe. Run on a machine with
 * network: `npm run probe:gacha`. Paste the output to Claude to verify the
 * field mapping and matcher quality before trusting it at scale.
 */
import { makeCollectorCryptAdapter } from './adapters/collectorcrypt.js';
import { matchListing } from './match.js';
import { openDb } from './db.js';

const cc = makeCollectorCryptAdapter();
const listings = await cc.fetchListings({ maxPages: 1 });
console.log(`\nFetched ${listings.length} listed Pokémon/One Piece cards from page 1.\n`);

for (const l of listings.slice(0, 8)) {
  console.log(`  ${l.grade.padEnd(8)} $${(l.price_cents / 100).toFixed(2).padStart(9)}  ${l.item_name}`);
}

try {
  const db = openDb();
  const cards = db.prepare(`SELECT id, name, number, set_name FROM cards`).all();
  if (cards.length) {
    let matched = 0;
    console.log('\nMatch check (first 8):');
    for (const l of listings.slice(0, 8)) {
      const hit = matchListing(l.item_name, cards);
      if (hit) matched++;
      console.log(`  ${hit ? '✓' : '·'} ${l.item_name}${hit ? ` → ${hit}` : ''}`);
    }
    const total = listings.filter(l => matchListing(l.item_name, cards)).length;
    console.log(`\nMatched ${total}/${listings.length} listings to the tracked universe.`);
  } else {
    console.log('\n(no cards in DB yet — run `npm run ingest` first for match stats)');
  }
} catch { /* no db yet */ }
