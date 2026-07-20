/**
 * Seed the canonical One Piece catalog from punk-records (the vendored,
 * official-sourced dataset). This REPLACES the thin PriceCharting-derived OP
 * universe with ~4,672 canonical cards (clean names, universal OP codes,
 * official images, every set incl. the newest). PriceCharting then attaches
 * PRICES to these canonical cards on the next ingest (matching by code+name).
 *
 *   node server/seed-onepiece.js            # fetch from source, snapshot, seed
 *   node server/seed-onepiece.js --snapshot # seed from the committed snapshot
 *
 * The snapshot (seed/onepiece-catalog.json) is committed so the catalog is
 * ours even if the upstream repo disappears — the ownership model.
 */
import { openDb } from './db.js';
import { fetchOnePieceCatalog, mapCard } from './adapters/punk-records.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(__dirname, '..', 'seed', 'onepiece-catalog.json');

async function loadRows(useSnapshot) {
  if (useSnapshot) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    // snapshot stores raw {cards, packs} so we re-map with current logic
    return Object.values(snap.cards).map(c => mapCard(c, snap.packs, { language: 'English' })).filter(Boolean);
  }
  // fetch raw, snapshot it (ownership), then map
  const RAW = 'https://raw.githubusercontent.com/buhbbl/punk-records/main/english';
  const [cards, packs] = await Promise.all([
    fetch(`${RAW}/index/cards_by_id.json`).then(r => r.json()),
    fetch(`${RAW}/packs.json`).then(r => r.json()),
  ]);
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({ generated_at: Math.floor(Date.now() / 1000), source: 'punk-records/english', cards, packs }));
  return Object.values(cards).map(c => mapCard(c, packs, { language: 'English' })).filter(Boolean);
}

export function seedOnePiece(db, rows) {
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, image, language, external_ids)
     VALUES (?, 'OP', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, set_name = excluded.set_name, number = excluded.number,
       variant = excluded.variant, image = COALESCE(excluded.image, cards.image),
       language = excluded.language,
       external_ids = json_patch(cards.external_ids, excluded.external_ids)`
  );
  db.exec('BEGIN');

  // 1. Upsert the canonical catalog (so re-point targets exist).
  let n = 0;
  for (const r of rows) { ins.run(r.id, r.name, r.set_name, r.number, r.variant, r.image, r.language, JSON.stringify(r.external_ids)); n++; }

  // Canonical = has a punkrecords external_id. Old = any other OP card
  // (op-pc* from PriceCharting + the legacy manual ones).
  const isCanonical = `json_extract(external_ids, '$.punkrecords') IS NOT NULL`;
  const canonicalByNumber = new Map();
  for (const c of db.prepare(`SELECT id, number FROM cards WHERE ip='OP' AND ${isCanonical} AND number IS NOT NULL`).all())
    canonicalByNumber.set(c.number.toUpperCase(), c.id);

  // 2. Re-point on-chain SALES from old OP cards → canonical (by code), so we
  //    never lose real solds. sales.card_id is the only hard FK to cards.
  const oldOp = db.prepare(`SELECT id, number FROM cards WHERE ip='OP' AND NOT (${isCanonical})`).all();
  const repoint = db.prepare(`UPDATE sales SET card_id = ? WHERE card_id = ?`);
  let repointed = 0;
  for (const o of oldOp) {
    const canon = o.number ? canonicalByNumber.get(String(o.number).toUpperCase()) : null;
    if (canon) repointed += Number(repoint.run(canon, o.id).changes);
  }

  // 3. Delete old OP cards that no longer have sales referencing them (FK-safe).
  const purged = db.prepare(
    `DELETE FROM cards WHERE ip='OP' AND NOT (${isCanonical})
       AND id NOT IN (SELECT DISTINCT card_id FROM sales)`
  ).run().changes;

  // 4. Clean derived rows orphaned by the delete (these tables have no FK).
  db.prepare(`DELETE FROM oracle_prices WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM external_marks WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM latest_marks   WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM basket_members WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE gacha_listings SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE nft_registry   SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();

  db.exec('COMMIT');
  const keptWithSales = oldOp.length - Number(purged);
  return { seeded: n, purgedOldOp: Number(purged), salesRepointed: repointed, oldKeptStillHasSales: keptWithSales };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const rows = await loadRows(process.argv.includes('--snapshot'));
  const res = seedOnePiece(db, rows);
  console.log('[seed:onepiece]', JSON.stringify({ ...res, sample: rows.slice(0, 2).map(r => ({ id: r.id, name: r.name, number: r.number, set: r.set_name })) }, null, 1));
}
