/**
 * Duplicate-identity diagnostic (read-only) — Kaleb, 2026-07-22, Phantasmal
 * Flames Charizard: "are these duplicates or actually separate cards?"
 *
 * The suspected mechanism: a brand-new set reaches PriceCharting before our
 * vendored catalog snapshot carries it → ingest creates satellite rows
 * (id …-pc<n>) for the unmatched products → a later catalog refresh adds the
 * canonical rows → the same physical card now has TWO identity rows, both
 * marked. The fix is the satellite mop-up (absorb marks/sales into the
 * canonical row, retire the satellite) — this script SIZES that backlog.
 *
 *   node server/diag-dupes.js "phantasmal"     (inspect one search term)
 *   node server/diag-dupes.js                  (just the per-game dupe census)
 */
import { openDb } from './db.js';

const term = process.argv[2] ?? null;
const db = openDb();
const isSat = (id) => /-pc\d+$/.test(id);
const hasBracket = (name) => /\[/.test(name ?? '');
const normName = (s) => (s ?? '').toLowerCase().replace(/\b(pokemon|ex|gx|v|vmax|vstar)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const numKey = (n) => { const s = String(n ?? '').toUpperCase().split('/')[0].replace(/^0+(?=\w)/, ''); return s || null; };

if (term) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.set_name, c.number, c.language,
           lm.price_cents, lm.basis, lm.source
    FROM cards c LEFT JOIN latest_marks lm ON lm.card_id = c.id AND lm.is_top = 1
    WHERE c.name LIKE ? OR c.set_name LIKE ?
    ORDER BY c.name, c.number`).all(`%${term}%`, `%${term}%`);
  console.log(`\n== ROWS MATCHING "${term}" (${rows.length}) ==`);
  for (const r of rows) {
    console.log(JSON.stringify({
      id: r.id, kind: isSat(r.id) ? 'SATELLITE' : 'canonical',
      name: r.name, set: r.set_name, number: r.number, lang: r.language,
      mark: r.price_cents != null ? `$${(r.price_cents / 100).toFixed(0)} (${r.basis}${r.source ? '/' + r.source : ''})` : null,
    }));
  }
}

// Census: unbracketed satellites whose (name, number-key) collides with a
// canonical row of the same game+language = duplicate identities. Bracketed
// satellites ([Reverse Holo] etc.) are legitimate variant rows, not dupes.
const all = db.prepare(`SELECT id, ip, name, set_name, number, language FROM cards`).all();
const marked = new Set(db.prepare(`SELECT DISTINCT card_id FROM latest_marks`).all().map(r => r.card_id));
const canon = new Map();
for (const c of all) {
  if (isSat(c.id)) continue;
  const k = `${c.ip}|${c.language}|${normName(c.name)}|${numKey(c.number)}`;
  if (numKey(c.number)) canon.set(k, c);
}
const dupes = {};
const samples = [];
for (const c of all) {
  if (!isSat(c.id) || hasBracket(c.name) || !numKey(c.number)) continue;
  const hit = canon.get(`${c.ip}|${c.language}|${normName(c.name)}|${numKey(c.number)}`);
  if (!hit) continue;
  const d = (dupes[c.ip] ??= { total: 0, bothMarked: 0 });
  d.total++;
  if (marked.has(c.id) && marked.has(hit.id)) {
    d.bothMarked++;
    if (samples.length < 12) samples.push(`${c.ip} ${c.name} #${c.number} → satellite ${c.id} DUPLICATES canonical ${hit.id}`);
  }
}
console.log(`\n== DUPLICATE-IDENTITY CENSUS (unbracketed satellites colliding with canonical rows) ==`);
console.log(JSON.stringify(dupes, null, 1));
console.log(`\nSamples (both rows carrying marks — the user-visible dupes):`);
for (const s of samples) console.log('  ' + s);
console.log('\nFix path: satellite mop-up — re-point sales/marks to the canonical row, retire the satellite (same FK-safe pattern as the OP mop-up).');
