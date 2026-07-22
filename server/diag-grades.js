/**
 * DIAG (read-only): grade-dialect census across every table that stores one.
 *
 * Kaleb, 2026-07-22: "so many data points for each card with each grade and
 * each grading company… easy to incorrectly match data points. If we can
 * confidently read and match and organize all this data it would be massive."
 *
 * Grade strings are the JOIN KEY for marks, ladders, and comps — if one
 * source writes 'PSA 10' and another 'PSA10', the same card's data silently
 * splits into two series that never see each other. This census shows every
 * distinct grade string in the wild, where it came from, and which ones are
 * suspects: pairs that collapse to the same canonical form but differ as
 * strings, and shapes that don't look like any known grader dialect.
 *
 *   node server/diag-grades.js
 */
import { openDb } from './db.js';

const db = openDb();

// company+number compact form ('PSA10' / 'BGS9.5' / 'TAG8.5') or 'raw'.
const CANONICAL_RE = /^(raw|[A-Z]{1,8}(?:[0-9]|10)(?:\.[05])?)$/;
const squash = (s) => String(s ?? '').toUpperCase().replace(/[\s_-]+/g, '');

const QUERIES = [
  ['external_marks', `SELECT source AS origin, grade, COUNT(*) n FROM external_marks GROUP BY source, grade`],
  ['sales', `SELECT source AS origin, grade, COUNT(*) n FROM sales GROUP BY source, grade`],
  ['gacha_listings', `SELECT platform AS origin, grade, COUNT(*) n FROM gacha_listings GROUP BY platform, grade`],
  ['latest_marks', `SELECT 'oracle' AS origin, grade, COUNT(*) n FROM latest_marks GROUP BY grade`],
];

const seen = new Map();   // squashed → Set of exact strings (cross-table collision detection)
for (const [table, sql] of QUERIES) {
  const rows = db.prepare(sql).all();
  console.log(`\n== ${table} — ${rows.length} distinct (origin, grade) pairs ==`);
  const byGrade = new Map();
  for (const r of rows) {
    (byGrade.get(r.grade) ?? byGrade.set(r.grade, []).get(r.grade)).push(`${r.origin}:${r.n}`);
    const k = squash(r.grade);
    (seen.get(k) ?? seen.set(k, new Set()).get(k)).add(String(r.grade));
  }
  for (const [grade, origins] of [...byGrade.entries()].sort()) {
    const flag = CANONICAL_RE.test(String(grade)) ? '' : '  ← NONSTANDARD';
    console.log(`  ${String(grade).padEnd(12)} ${origins.join(' · ')}${flag}`);
  }
}

console.log('\n== DIALECT COLLISIONS (same grade, different spellings — data silently split) ==');
let collisions = 0;
for (const [k, variants] of seen) {
  if (variants.size > 1) { collisions++; console.log(`  ${k}: ${[...variants].map(v => `'${v}'`).join(' vs ')}`); }
}
if (!collisions) console.log('  none — every grade resolves to one spelling. The join key is clean.');

// The PC pseudo-grades deserve their own line: 'G9.5' (box-only column) is a
// company-less 9.5 that can never join CGC9.5/BGS9.5 listings.
const g95 = db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE grade = 'G9.5'`).get().n;
const g95lm = db.prepare(`SELECT COUNT(*) n FROM latest_marks WHERE grade = 'G9.5'`).get().n;
console.log(`\n== PC PSEUDO-GRADES == 'G9.5' marks: ${g95} (latest_marks series: ${g95lm}) — company-less; decide whether it earns a ladder row.`);
console.log('\n[diag-grades] read-only, nothing written.');
