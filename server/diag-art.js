/**
 * Art-coverage census (read-only) — Kaleb, 2026-07-22: "we'll really have to
 * drill into the missing card arts to make this binder fully functional."
 *
 * What matters is not artless cards in the abstract — it's artless cards
 * PEOPLE SEE: priced cards (they surface in search/screener/binder) ranked
 * by value. Prints per-game totals, image-source mix, and the top artless
 * cards by Oracle value = the exact drill-down worklist.
 *
 *   node server/diag-art.js            (census + top 30)
 *   node server/diag-art.js 60         (top 60)
 */
import { openDb } from './db.js';

const topN = Number(process.argv[2] ?? 30);
const db = openDb();

console.log('\n== ART COVERAGE BY GAME ==');
const per = db.prepare(`
  SELECT c.ip,
         COUNT(*) AS total,
         SUM(c.image IS NULL) AS artless,
         SUM(CASE WHEN c.image IS NULL AND m.card_id IS NOT NULL THEN 1 ELSE 0 END) AS artless_priced
  FROM cards c
  LEFT JOIN (SELECT DISTINCT card_id FROM latest_marks) m ON m.card_id = c.id
  GROUP BY c.ip ORDER BY c.ip`).all();
for (const r of per) {
  console.log(`${r.ip.padEnd(6)} total ${String(r.total).padStart(6)} · artless ${String(r.artless).padStart(6)} (${((r.artless / r.total) * 100).toFixed(1)}%) · ARTLESS+PRICED ${String(r.artless_priced).padStart(5)}  ← user-visible gap`);
}

console.log('\n== IMAGE SOURCE MIX (how each game is illustrated) ==');
const mix = db.prepare(`
  SELECT ip, COALESCE(image_kind, CASE WHEN image IS NULL THEN '(none)' ELSE 'official' END) AS kind, COUNT(*) n
  FROM cards GROUP BY ip, kind ORDER BY ip, n DESC`).all();
let cur = '';
for (const r of mix) {
  if (r.ip !== cur) { cur = r.ip; console.log(`${r.ip}:`); }
  console.log(`   ${r.kind.padEnd(12)} ${r.n}`);
}

console.log(`\n== TOP ${topN} ARTLESS BY VALUE (the drill-down worklist) ==`);
const top = db.prepare(`
  SELECT c.ip, c.id, c.name, c.set_name, c.number, c.language, MAX(lm.price_cents) AS top_cents
  FROM cards c JOIN latest_marks lm ON lm.card_id = c.id
  WHERE c.image IS NULL
  GROUP BY c.id ORDER BY top_cents DESC LIMIT ?`).all(topN);
for (const t of top) {
  console.log(`$${String(Math.round(t.top_cents / 100)).padStart(6)}  ${t.ip.padEnd(5)} ${t.id.padEnd(22)} ${(t.name ?? '').slice(0, 44).padEnd(45)} ${(t.set_name ?? '').slice(0, 30)} ${t.number ?? ''} ${t.language !== 'English' ? '· ' + t.language : ''}`);
}
