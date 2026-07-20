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
  // Retire the old PriceCharting-derived OP cards (op-pc*) and the 10 manual
  // ones — the canonical catalog supersedes them. Their PC prices re-attach to
  // the canonical cards on the next ingest (import matches by code+name).
  const purged = db.prepare(`DELETE FROM cards WHERE ip = 'OP' AND id NOT LIKE 'op-op%' AND id NOT LIKE 'op-st%' AND id NOT LIKE 'op-eb%' AND id NOT LIKE 'op-p%' AND id NOT LIKE 'op-prb%'`).run().changes;
  let n = 0;
  for (const r of rows) { ins.run(r.id, r.name, r.set_name, r.number, r.variant, r.image, r.language, JSON.stringify(r.external_ids)); n++; }
  db.exec('COMMIT');
  return { seeded: n, purgedOldOp: Number(purged) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const rows = await loadRows(process.argv.includes('--snapshot'));
  const res = seedOnePiece(db, rows);
  console.log('[seed:onepiece]', JSON.stringify({ ...res, sample: rows.slice(0, 2).map(r => ({ id: r.id, name: r.name, number: r.number, set: r.set_name })) }, null, 1));
}
