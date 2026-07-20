/**
 * Diagnostic: what do MNSTR's live grading fields ACTUALLY look like, and what
 * does our mapper now make of them? (Live bug 2026-07-20: listings showing
 * raw/ungraded — every MNSTR item is a slab, so raw = parse failure.)
 *
 *   node server/probe-mnstr-grades.js      (run on the droplet — open egress)
 */
import { timedFetch } from './net.js';
import { mapListing } from './adapters/mnstr-listings.js';

const res = await timedFetch('https://api.mnstr.xyz/mnstr/collection', { headers: { 'User-Agent': 'Mozilla/5.0' } });
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
const cards = (await res.json())?.data ?? [];
console.log(`fetched ${cards.length} collection cards\n`);

// Distribution of raw grading-field shapes.
const shapes = new Map();
for (const c of cards) {
  const key = JSON.stringify({ grading: c.grading ?? null, gradingCompany: c.gradingCompany ?? null });
  shapes.set(key, (shapes.get(key) ?? 0) + 1);
}
console.log('--- raw grading-field shapes (top 15) ---');
for (const [k, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(5), k);

// What the CURRENT mapper yields.
const grades = new Map();
for (const c of cards) {
  const r = mapListing(c, '2026-07-20');
  if (!r) continue;
  grades.set(r.grade, (grades.get(r.grade) ?? 0) + 1);
}
console.log('\n--- mapped grade distribution (current parser) ---');
for (const [g, n] of [...grades.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), g);

// Show full objects for a few that STILL map to raw.
console.log('\n--- samples still mapping to raw ---');
let shown = 0;
for (const c of cards) {
  const r = mapListing(c, '2026-07-20');
  if (r && r.grade === 'raw' && shown < 5) {
    shown++;
    console.log(JSON.stringify({ title: c.title?.slice(0, 60), grading: c.grading, gradingCompany: c.gradingCompany, grade_fields: Object.keys(c).filter(k => /grad|cond/i.test(k)) }));
  }
}
if (!shown) console.log('(none — parser covers everything)');
