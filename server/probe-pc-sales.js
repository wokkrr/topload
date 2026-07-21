/**
 * Probe: does PriceCharting's API expose INDIVIDUAL sales (the per-item eBay
 * solds shown on their product pages), or only aggregated prices?
 *
 * If individual sales are available, they become a dense dated-sales stream
 * for the oracle across the whole catalog (labeled provenance: eBay-via-PC) —
 * the velocity the vault marketplaces alone can't supply (Kaleb, 2026-07-21).
 *
 *   node --env-file-if-exists=.env server/probe-pc-sales.js [productId]
 *
 * Read-only network probe; touches no DB. Defaults to a liquid product id
 * resolved via the search API so the probe is self-contained.
 */
import { timedFetch } from './net.js';

const KEY = process.env.PRICECHARTING_API_KEY;
if (!KEY) { console.error('PRICECHARTING_API_KEY not set in .env'); process.exit(1); }
const BASE = 'https://www.pricecharting.com';

async function show(path, label) {
  try {
    const res = await timedFetch(`${BASE}${path}`);
    const text = await res.text();
    console.log(`\n=== ${label}\n    ${path.replace(KEY, 'KEY')}\n    HTTP ${res.status}`);
    try {
      const j = JSON.parse(text);
      const keys = Object.keys(j);
      console.log(`    keys: ${keys.join(', ').slice(0, 300)}`);
      // Anything that looks like a sales array gets sampled in full.
      for (const k of keys) {
        if (Array.isArray(j[k]) && j[k].length && /sale|sold|ebay|history/i.test(k)) {
          console.log(`    ${k}[0..2]:`, JSON.stringify(j[k].slice(0, 3)));
        }
      }
      if (!keys.some(k => /sale|sold|ebay|history/i.test(k))) {
        console.log('    (no sales-looking keys)');
      }
    } catch { console.log(`    body: ${text.slice(0, 300)}`); }
  } catch (e) { console.log(`\n=== ${label}: fetch failed — ${e.message}`); }
}

let id = process.argv[2];
if (!id) {
  const res = await timedFetch(`${BASE}/api/products?t=${KEY}&q=${encodeURIComponent('charizard base set pokemon')}`);
  const j = await res.json();
  id = j?.products?.[0]?.id;
  console.log(`resolved probe product: ${id} (${j?.products?.[0]?.['product-name']} · ${j?.products?.[0]?.['console-name']})`);
}
if (!id) { console.error('could not resolve a product id'); process.exit(1); }

await show(`/api/product?t=${KEY}&id=${id}`, 'product (full field inventory)');
await show(`/api/product-sales?t=${KEY}&id=${id}`, 'product-sales (candidate)');
await show(`/api/sales?t=${KEY}&id=${id}`, 'sales (candidate)');
await show(`/api/ebay-sales?t=${KEY}&id=${id}`, 'ebay-sales (candidate)');
await show(`/api/sale-history?t=${KEY}&id=${id}`, 'sale-history (candidate)');
console.log('\nDone. If any candidate returned individual sales, the oracle gets its stream.');
