/**
 * Bulk-import a PriceCharting price-guide CSV (Legendary sub download) into the
 * card universe + external marks. This is the whole-catalog route — one file
 * covers a full category with per-grade prices AND sales-volume (the liquidity
 * signal that unlocks rules-based baskets/indexes without raw solds).
 *
 * Usage:  npm run import:pc -- <file.csv> <IP>     IP ∈ PKMN | OP | YGO
 * Env:    PC_MIN_VOLUME (default 10), PC_MIN_PRICE_CENTS (default 200)
 *
 * Rows kept: genre contains 'Card', sales-volume ≥ floor, loose ≥ price floor.
 * Existing cards (e.g. pokemontcg-seeded) are matched by name+number and get
 * the PriceCharting id attached instead of creating a duplicate.
 */
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { matchListing } from './match.js';
import { refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const CSV_GRADE_FIELDS = {
  'loose-price': 'raw',
  'graded-price': 'PSA9',
  'manual-only-price': 'PSA10',
  'box-only-price': 'G9.5',
  'bgs-10-price': 'BGS10',
  'condition-17-price': 'CGC10',
};

export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const cents = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/**
 * 'Charizard #6' → {name:'Charizard', number:'6'}; 'Ain OP07-002' →
 * {name:'Ain', number:'OP07-002'}; 'Boa Hancock P-066' → {name:'Boa Hancock',
 * number:'P-066'} (single-letter promo codes — were being dropped, leaving
 * 544 One Piece promos with null numbers + the code jammed in the name).
 */
export function splitProductName(productName) {
  const s = (productName ?? '').trim();
  let m = /^(.*?)\s*#([A-Za-z0-9/-]+)\s*$/.exec(s);
  if (m) return { name: m[1].trim(), number: m[2] };
  m = /^(.*?)\s+([A-Z]{1,5}\d{0,3}-[A-Za-z0-9]+)\s*$/.exec(s);   // {1,5}: P-066, OP07-002, ST11-003
  if (m) return { name: m[1].trim(), number: m[2] };
  m = /^(.*?)\s+(\d{1,4}\/\d{1,4})\s*$/.exec(s);
  if (m) return { name: m[1].trim(), number: m[2] };
  return { name: s, number: null };
}

export function importCsv(db, { text, ip, asOf, minVolume = 10, minPriceCents = 200 }) {
  const rows = parseCsv(text);
  const existing = db.prepare(
    `SELECT id, name, number, set_name, language FROM cards
     WHERE ip = ? AND json_extract(external_ids, '$.pricecharting') IS NULL`
  ).all(ip);
  const insCard = db.prepare(
    // On re-import, re-apply the (now-better) name/number split — these ids are
    // PC-created (op-pc<rowid>), so this never clobbers pokemontcg-seeded cards.
    // Fixes the historical null-number promos in place on the next import.
    `INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES (?, ?, ?, ?, ?, '', ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, number = excluded.number, set_name = excluded.set_name,
       external_ids = json_patch(cards.external_ids, excluded.external_ids)`
  );
  const attachPc = db.prepare(`UPDATE cards SET external_ids = json_set(external_ids, '$.pricecharting', ?) WHERE id = ?`);
  const insMark = db.prepare(
    `INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents, sales_volume)
     VALUES ('pricecharting', ?, ?, ?, ?, ?)`
  );

  let kept = 0, merged = 0, marks = 0, skipped = 0;
  const matchedExisting = new Set();
  db.exec('BEGIN');
  for (const row of rows) {
    if (!(row.genre ?? '').includes('Card')) { skipped++; continue; }
    const volume = parseInt(row['sales-volume'] || '0', 10);
    const loose = cents(row['loose-price']);
    if (volume < minVolume || (loose ?? 0) < minPriceCents) { skipped++; continue; }

    const { name, number } = splitProductName(row['product-name']);
    const setName = (row['console-name'] ?? '').trim();

    // Merge with an existing (e.g. pokemontcg-seeded) card when possible.
    let cardId = null;
    const hit = matchListing(`${row['product-name']} ${setName}`, existing.filter(c => !matchedExisting.has(c.id)));
    if (hit) { cardId = hit; matchedExisting.add(hit); attachPc.run(String(row.id), hit); merged++; }
    else {
      cardId = `${ip.toLowerCase()}-pc${row.id}`;
      insCard.run(cardId, ip, name, setName, number, JSON.stringify({ pricecharting: String(row.id) }));
    }

    for (const [field, grade] of Object.entries(CSV_GRADE_FIELDS)) {
      const p = cents(row[field]);
      if (p != null) { insMark.run(cardId, grade, asOf, p, volume); marks++; }
    }
    kept++;
  }
  db.exec('COMMIT');
  return { rows: rows.length, kept, merged, marks, skipped };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ip] = process.argv.slice(2);
  if (!file || !['PKMN', 'OP', 'YGO'].includes(ip)) {
    console.error('Usage: npm run import:pc -- <file.csv> <PKMN|OP|YGO>');
    process.exit(1);
  }
  const db = openDb();
  const asOf = new Date().toISOString().slice(0, 10);
  const res = importCsv(db, {
    text: readFileSync(file, 'utf8'), ip, asOf,
    minVolume: Number(process.env.PC_MIN_VOLUME ?? 10),
    minPriceCents: Number(process.env.PC_MIN_PRICE_CENTS ?? 200),
  });
  console.log(`[import:pc] ${ip}:`, JSON.stringify(res));
  console.log('[import:pc] recomputing oracle + indexes…');
  const dates = [asOf];
  const oracle = refreshOracle(db, dates);
  const indexes = refreshIndexes(db);
  console.log('[import:pc]', JSON.stringify({ ...oracle, ...indexes }));
}
