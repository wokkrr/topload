/**
 * Seed the canonical Yu-Gi-Oh catalog from YGOPRODeck (per-printing English
 * catalog: one card per set_code). Replaces the PriceCharting-derived YGO
 * universe with a complete, release-day-current spine; PriceCharting attaches
 * PRICES to these canonical printings on the next ingest.
 *
 *   node server/seed-yugioh.js               # fetch (server-side!), snapshot, seed
 *   node server/seed-yugioh.js --snapshot    # seed from the committed snapshot
 *   node server/seed-yugioh.js --upsert-only # refresh path: add/update only
 *
 * IMPORTANT: fetch mode needs egress to db.ygoprodeck.com — run it on the
 * droplet (the dev container can only reach GitHub). After the FIRST server
 * run, commit seed/yugioh-catalog.json so the catalog is owned like OP/PKMN.
 *
 * FK-safety mirrors seed-pokemon: upsert canonical → re-point sales off old
 * cards via the tested matcher → delete old non-canonical cards ONLY when they
 * have no remaining sales. Worst case a redundant card lingers — never a
 * crash, never a lost sale.
 */
import { openDb } from './db.js';
import { fetchYugiohCatalog, mapCard } from './adapters/ygoprodeck-catalog.js';
import { matchListing } from './match.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(__dirname, '..', 'seed', 'yugioh-catalog.json');

async function loadRows(useSnapshot) {
  if (useSnapshot) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const rows = [];
    for (const c of snap.cards) rows.push(...mapCard({ ...c, card_images: c.image_url ? [{ image_url: c.image_url }] : [] }));
    return rows;
  }
  const { rows, cardCount, printingCount, rawCards } = await fetchYugiohCatalog();
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({ generated_at: Math.floor(Date.now() / 1000), source: 'db.ygoprodeck.com/api/v7/cardinfo.php', cards: rawCards }));
  console.log(`[seed:yugioh] fetched ${cardCount} cards → ${printingCount} EN printings; snapshot written (commit seed/yugioh-catalog.json!)`);
  return rows;
}

/**
 * @param {object} db
 * @param {object[]} rows canonical printing rows from the adapter
 * @param {{migrate?: boolean}} [opts] migrate=false = upsert-only refresh path.
 */
export function seedYugioh(db, rows, { migrate = true } = {}) {
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, image, language, external_ids)
     VALUES (?, 'YGO', ?, ?, ?, ?, ?, ?, ?)
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

  // Refresh path: upsert only. New sets flow in; nothing old is touched.
  if (!migrate) { db.exec('COMMIT'); return { seeded: n, purgedOld: 0, salesRepointed: 0, oldKeptStillHasSales: 0, mode: 'upsert-only' }; }

  // Canonical = has a ygoprodeck external_id. Old = any other YGO card.
  const isCanonical = `json_extract(external_ids, '$.ygoprodeck') IS NOT NULL`;
  const canonical = db.prepare(`SELECT id, name, number, set_name FROM cards WHERE ip='YGO' AND ${isCanonical}`).all();

  // 2. Re-point on-chain SALES from old cards → canonical via the tested
  //    matcher (handles regional-infix set codes: "LOB-001" → "LOB-EN001").
  const oldYg = db.prepare(`SELECT id, name, number, set_name FROM cards WHERE ip='YGO' AND NOT (${isCanonical})`).all();
  const hasSales = new Set(db.prepare(`SELECT DISTINCT card_id FROM sales`).all().map(r => r.card_id));
  const repoint = db.prepare(`UPDATE sales SET card_id = ? WHERE card_id = ?`);
  let repointed = 0;
  for (const o of oldYg) {
    if (!hasSales.has(o.id)) continue;
    const title = `${o.name ?? ''} ${o.number ?? ''} ${o.set_name ?? ''}`.trim();
    const canon = matchListing(title, canonical);
    if (canon && canon !== o.id) repointed += Number(repoint.run(canon, o.id).changes);
  }

  // 3. Delete old non-canonical YGO cards that no longer have sales (FK-safe).
  const purged = db.prepare(
    `DELETE FROM cards WHERE ip='YGO' AND NOT (${isCanonical})
       AND id NOT IN (SELECT DISTINCT card_id FROM sales)`
  ).run().changes;

  // 4. Clean derived rows orphaned by the delete; null listing/registry
  //    pointers to retired cards (rematch re-attributes).
  db.prepare(`DELETE FROM oracle_prices  WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM external_marks WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM latest_marks   WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM basket_members WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE gacha_listings SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE nft_registry   SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();

  db.exec('COMMIT');
  const keptWithSales = oldYg.length - Number(purged);
  return { seeded: n, purgedOld: Number(purged), salesRepointed: repointed, oldKeptStillHasSales: keptWithSales };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const rows = await loadRows(process.argv.includes('--snapshot'));
  const res = seedYugioh(db, rows, { migrate: !process.argv.includes('--upsert-only') });
  console.log('[seed:yugioh]', JSON.stringify({ ...res, sample: rows.slice(0, 3).map(r => ({ id: r.id, name: r.name, number: r.number, set: r.set_name, variant: r.variant })) }, null, 1));
  console.log('[seed:yugioh] NEXT: `npm run rematch -- --listings-only`, then a full ingest so PriceCharting prices merge into canonical.');
}
