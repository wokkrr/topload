/**
 * DIAG (read-only): how many cards is the catalog MISSING? (Kaleb,
 * 2026-07-22, Ooyama's Pikachu: "Are we missing cards?")
 *
 * The import gates (minVolume 10 · minPrice $2) protect the PRICE feed from
 * junk, but they also stop thin vintage printings from ever getting a card
 * ROW — a card that trades twice a year never enters the database. This
 * measures that: every card-genre product in the freshest daily CSVs that
 * has NO card row wearing its PC id, split by why it was gated, ranked by
 * the value we're blind to.
 *
 *   node server/diag-catalog-gaps.js
 */
import { openDb } from './db.js';
import { latestCsvs } from './repair-variant-marks.js';
import { parseCsv } from './import-pricecharting-csv.js';

const db = openDb();
const cents = (s) => { const n = parseFloat(String(s ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };

// Every PC id currently attached to any card (incl. absorbed satellites).
const attached = new Set();
for (const r of db.prepare(`SELECT json_extract(external_ids, '$.pricecharting') pc FROM cards WHERE json_extract(external_ids, '$.pricecharting') IS NOT NULL`).all()) {
  attached.add(String(r.pc));
}

for (const { text, ip, file } of latestCsvs()) {
  let cardRows = 0, present = 0, missing = 0, gatedVolume = 0, gatedPrice = 0, unexplained = 0, missingValue = 0;
  const bySet = new Map();
  for (const row of parseCsv(text)) {
    if (!(row.genre ?? '').includes('Card')) continue;
    cardRows++;
    if (attached.has(String(row.id))) { present++; continue; }
    missing++;
    const vol = parseInt(row['sales-volume'] || '0', 10);
    const loose = cents(row['loose-price']) ?? 0;
    if (vol < 10) gatedVolume++;
    else if (loose < 200) gatedPrice++;
    else unexplained++;
    missingValue += loose;
    const set = (row['console-name'] ?? '').trim();
    const s = bySet.get(set) ?? { n: 0, v: 0 };
    s.n++; s.v += loose;
    bySet.set(set, s);
  }
  console.log(`\n== ${ip} (${file}) ==`);
  console.log(`  card products: ${cardRows} · with a row: ${present} · MISSING: ${missing} (${(missing / cardRows * 100).toFixed(1)}%)`);
  console.log(`  why: volume<10: ${gatedVolume} · price<$2: ${gatedPrice} · passes gates but absent: ${unexplained}`);
  console.log(`  loose-value we're blind to: $${Math.round(missingValue / 100).toLocaleString()}`);
  const top = [...bySet.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 10);
  for (const [set, s] of top) console.log(`    $${String(Math.round(s.v / 100)).padStart(8)}  ${String(s.n).padStart(5)} missing  ${set}`);
}
console.log('\n[catalog-gaps] read-only. Fix candidates: (a) create rows for ALL card products (gates keep applying to MARKS only), (b) artofpkm as a vintage-JP identity seed for cards PC does not even model.');
