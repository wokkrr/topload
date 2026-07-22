/**
 * Diagnostic (read-only): why is a CC-vaulted Phygitals listing still showing
 * platform 'phygitals' on the desk? (Kaleb, 2026-07-22 — Destined Rivals ETB:
 * Phygitals' own page says "Vaulted at COLLECTOR / external item".)
 *
 * Prints, for a search term:
 *   1. LIVE payload fields from the Phygitals API (vault / marketplace / …)
 *   2. What our gacha_listings table currently stores for matching rows
 *
 *   node server/diag-phyg-vault.js "Destined Rivals Elite Trainer Box"
 */
import { openDb } from './db.js';

const term = process.argv[2] ?? 'Destined Rivals Elite Trainer Box';

// 1 — live API payload
const q = new URLSearchParams({
  searchTerm: term, sortBy: 'price-low-high', itemsPerPage: '50', page: '0',
  metadataConditions: JSON.stringify({ category: ['Pokemon'] }),
  priceRange: '[null,null]', fmvRange: '[null,null]', listedStatus: 'listed',
});
try {
  const r = await fetch(`https://api.phygitals.com/api/marketplace/marketplace-listings?${q}`,
    { headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ls = (await r.json())?.listings ?? [];
  console.log(`\n== LIVE API (${ls.length} hits for "${term}") ==`);
  for (const l of ls.slice(0, 8)) {
    console.log(JSON.stringify({
      name: l.name,
      address: `${(l.address ?? '').slice(0, 6)}…${(l.address ?? '').slice(-4)}`,
      price_usd: (Number(l.price) / 1e6).toFixed(2),
      vault: l.vault ?? null,
      marketplace: l.marketplace ?? null,
      // any other field that smells like custody/venue routing
      extra: Object.fromEntries(Object.entries(l).filter(([k, v]) =>
        /vault|market|escrow|external|custod|source|origin/i.test(k) && typeof v !== 'object' && !['vault', 'marketplace'].includes(k))),
    }));
  }
} catch (e) {
  console.log(`\n== LIVE API failed: ${e.message} (429 = rate-limited; retry later) ==`);
}

// 2 — what the desk currently stores
const db = openDb();
const rows = db.prepare(
  `SELECT platform, external_id, item_name, grade, price_cents, seen_at, listed_at
   FROM gacha_listings WHERE item_name LIKE ? ORDER BY price_cents LIMIT 10`
).all(`%${term}%`);
console.log(`\n== OUR DB (${rows.length} rows matching) ==`);
for (const r of rows) {
  console.log(JSON.stringify({ ...r, external_id: `${r.external_id.slice(0, 12)}…`, price_usd: (r.price_cents / 100).toFixed(2) }));
}
console.log('\nInterpretation: if LIVE vault=\'cc\' but OUR platform=\'phygitals\', the DB row');
console.log('predates the host-attribution fix and relabels on the next successful');
console.log('(non-429) Phygitals listings cycle. If LIVE vault is something OTHER than');
console.log("'cc' (e.g. 'collector'), the adapter's check needs widening — report back.");
