/**
 * Diagnostic: Collector Crypt listings that map to 'raw' — what do their REAL
 * fields hold? (Live 2026-07-20: two obvious slabs — a PSA 8 Dark Charizard,
 * a CGC 10 Luffy — tagged raw.) Also dumps one full item's keys so we can see
 * whether CC exposes cert numbers / grade fields we never captured.
 *
 *   node server/probe-cc-grades.js       (run on the droplet — open egress)
 */
import { timedFetch } from './net.js';
import { normalizeGrade, gradeFromTitle } from './adapters/collectorcrypt.js';

const out = [];
for (let page = 1; page <= 20; page++) {
  const res = await timedFetch(`https://api.collectorcrypt.com/marketplace?page=${page}&step=100`);
  if (!res.ok) { console.error(`page ${page} → HTTP ${res.status}`); break; }
  const json = await res.json();
  for (const c of json.filterNFtCard ?? []) {
    if (!c.listing || (c.type && c.type !== 'Card')) continue;
    if (!['Pokemon', 'One Piece'].includes(c.category)) continue;
    out.push(c);
  }
  if (page >= (json.totalPages ?? 1)) break;
}
console.log(`fetched ${out.length} listed cards\n`);

const raws = out.filter(c => {
  let g = normalizeGrade(c.gradingCompany, c.gradeNum ?? c.grade);
  if (g === 'raw') g = gradeFromTitle(c.itemName);
  return g === 'raw';
});
console.log(`${raws.length} map to raw — grade-ish fields on each:`);
for (const c of raws.slice(0, 12)) {
  const gradeKeys = Object.keys(c).filter(k => /grad|cert|condition|type|serial/i.test(k));
  console.log(JSON.stringify({
    itemName: (c.itemName ?? '').slice(0, 55),
    fields: Object.fromEntries(gradeKeys.map(k => [k, c[k]])),
  }));
}

console.log('\n--- one full item, all keys (cert-field hunt) ---');
if (out[0]) console.log(Object.keys(out[0]).join(', '));
