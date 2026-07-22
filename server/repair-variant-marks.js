/**
 * Repair variant-price-on-canonical corruption (Kaleb, 2026-07-22: canonical
 * Dawn #87 wearing the [Regional Championships Staff] promo's $585 mark;
 * Suicune #26 wearing [EB Games]'s $480).
 *
 * Cause (now gated in import-pricecharting-csv.js): bracketed PC products
 * were allowed to merge onto unbracketed catalog cards — the variant's
 * price history became the base card's marks.
 *
 * Repair, per corrupted attach (cross-referenced against the daily PC CSVs):
 *   1. find cards whose $.pricecharting id belongs to a BRACKETED product
 *      while the card's own name is unbracketed;
 *   2. create/refresh the proper satellite row for that product;
 *   3. move ALL pricecharting marks (every as_of) card → satellite;
 *   4. detach $.pricecharting from the canonical;
 *   5. delete the canonical's derived external-pricecharting oracle rows +
 *      latest_marks (solds-based history untouched).
 * AFTER: `npm run oracle:refresh` rebuilds today's marks; the freed canonical
 * re-matches its TRUE base product (label-gated) on the next CSV import.
 *
 *   node server/repair-variant-marks.js --dry data/imports/2026-07-22-PKMN.csv:PKMN [more file:IP …]
 *   node server/repair-variant-marks.js data/imports/…-PKMN.csv:PKMN data/imports/…-YGO.csv:YGO data/imports/…-OP.csv:OP
 */
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { parseCsv, splitProductName, labelOf } from './import-pricecharting-csv.js';

export function repairVariantMarks(db, { csvs, dry = false }) {
  // pc-id → product info, for every BRACKETED product in the guides.
  const bracketed = new Map();
  for (const { text, ip } of csvs) {
    for (const row of parseCsv(text)) {
      if (!(row.genre ?? '').includes('Card')) continue;
      if (!labelOf(row['product-name'])) continue;
      bracketed.set(String(row.id), {
        ip, name: splitProductName(row['product-name']).name,
        number: splitProductName(row['product-name']).number,
        set: (row['console-name'] ?? '').trim(),
      });
    }
  }

  const res = { bracketedProducts: bracketed.size, corrupted: 0, marksMoved: 0, satellitesMade: 0, samples: [] };
  const cards = db.prepare(
    `SELECT id, ip, name, json_extract(external_ids, '$.pricecharting') AS pc FROM cards
     WHERE json_extract(external_ids, '$.pricecharting') IS NOT NULL`).all();

  if (!dry) db.exec('BEGIN');
  const mkSat = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES (?, ?, ?, ?, ?, '', ?)
     ON CONFLICT(id) DO NOTHING`);
  const moveMarks = db.prepare(`UPDATE OR IGNORE external_marks SET card_id = ? WHERE card_id = ? AND source = 'pricecharting'`);
  const dropLeftover = db.prepare(`DELETE FROM external_marks WHERE card_id = ? AND source = 'pricecharting'`);
  const detach = db.prepare(`UPDATE cards SET external_ids = json_remove(external_ids, '$.pricecharting') WHERE id = ?`);
  const dropDerived = [
    db.prepare(`DELETE FROM oracle_prices WHERE card_id = ? AND basis = 'external' AND source = 'pricecharting'`),
    db.prepare(`DELETE FROM latest_marks WHERE card_id = ?`),
  ];

  for (const c of cards) {
    if (/\[/.test(c.name ?? '')) continue;                    // card itself is a variant row — fine
    const prod = bracketed.get(String(c.pc));
    if (!prod || prod.ip !== c.ip) continue;                  // attached product is unbracketed — fine
    res.corrupted++;
    const satId = `${c.ip.toLowerCase()}-pc${c.pc}`;
    if (res.samples.length < 12) res.samples.push(`${c.id} "${c.name}" wearing [${prod.name}] (pc ${c.pc}) → ${satId}`);
    if (dry) continue;
    const made = mkSat.run(satId, c.ip, prod.name, prod.set, prod.number, JSON.stringify({ pricecharting: String(c.pc) })).changes;
    res.satellitesMade += Number(made);
    res.marksMoved += Number(moveMarks.run(satId, c.id).changes);
    dropLeftover.run(c.id);
    detach.run(c.id);
    for (const d of dropDerived) d.run(c.id);
  }
  if (!dry) db.exec('COMMIT');
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry');
  const csvs = process.argv.slice(2).filter(a => a.includes(':')).map(a => {
    const i = a.lastIndexOf(':');
    return { text: readFileSync(a.slice(0, i), 'utf8'), ip: a.slice(i + 1) };
  });
  if (!csvs.length) { console.error('usage: node server/repair-variant-marks.js [--dry] <csv-path>:<IP> …'); process.exit(1); }
  const res = repairVariantMarks(openDb(), { csvs, dry });
  console.log(`[repair:variant-marks]${dry ? ' DRY RUN' : ''}`, JSON.stringify(res, null, 1));
  if (!dry) console.log('[repair] NEXT: npm run oracle:refresh — canonical base cards re-match their true products on the next CSV import.');
}
