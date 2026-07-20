/**
 * Seed the canonical Pokémon catalog from pokemon-tcg-data (the vendored,
 * official pokemontcg.io dataset). This REPLACES the thin, high-rarity
 * pokemontcg.io API slice + the PriceCharting-derived universe with the FULL
 * ~20,400-card English catalog (every set Base→newest, every rarity, official
 * images, stable ids that ARE the pokemontcg.io ids). PriceCharting then
 * attaches PRICES to these canonical cards on the next ingest (import:pc merges
 * its rows into them by name+number).
 *
 *   node server/seed-pokemon.js            # fetch from source, snapshot, seed
 *   node server/seed-pokemon.js --snapshot # seed from the committed snapshot
 *
 * The snapshot (seed/pokemon-catalog.json) is committed so the catalog is ours
 * even if the upstream repo disappears — the ownership model.
 *
 * FK-safety (mirrors seed-onepiece): sales.card_id is the only hard FK to
 * cards. We (1) upsert canonical, (2) re-point sales off old cards onto the
 * canonical match (via our tested matcher, so "Charizard #4"→"4/102" resolves),
 * (3) delete old non-canonical cards ONLY when they have no remaining sales.
 * Worst case a few redundant old cards linger — never a crash, never a lost sale.
 */
import { openDb } from './db.js';
import { fetchPokemonCatalog, mapCard } from './adapters/ptcgdata.js';
import { matchListing } from './match.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(__dirname, '..', 'seed', 'pokemon-catalog.json');

// Fields worth keeping in the committed snapshot: catalog + a future browsable
// card-DB. Drop bulky gameplay text (attacks, flavor, legalities) — never used.
const CARD_KEEP = ['id', 'name', 'supertype', 'subtypes', 'hp', 'types', 'number', 'artist', 'rarity', 'regulationMark', 'images', 'nationalPokedexNumbers'];
const SET_KEEP = ['id', 'name', 'series', 'printedTotal', 'total', 'releaseDate', 'images'];
const pick = (obj, keys) => { const o = {}; for (const k of keys) if (obj?.[k] !== undefined) o[k] = obj[k]; return o; };

async function loadRows(useSnapshot) {
  if (useSnapshot) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const setsById = Object.fromEntries(snap.sets.map(s => [s.id, s]));
    const rows = [];
    for (const [setId, cards] of Object.entries(snap.cards))
      for (const c of cards) { const m = mapCard(c, setsById[setId], { language: 'English' }); if (m) rows.push(m); }
    return rows;
  }
  // fetch raw, snapshot it (ownership, slimmed), then map
  const { rows, rawSets, rawCards } = await fetchPokemonCatalog();
  const slimSets = rawSets.map(s => pick(s, SET_KEEP));
  const slimCards = {};
  for (const [setId, cards] of Object.entries(rawCards)) slimCards[setId] = cards.map(c => pick(c, CARD_KEEP));
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({ generated_at: Math.floor(Date.now() / 1000), source: 'PokemonTCG/pokemon-tcg-data/en', sets: slimSets, cards: slimCards }));
  return rows;
}

/**
 * @param {object} db
 * @param {object[]} rows canonical card rows from the adapter
 * @param {{migrate?: boolean}} [opts] migrate=true (default) runs the one-time
 *   FK-safe replacement of old cards (re-point sales, purge, clean). migrate=false
 *   is the UPSERT-ONLY refresh path — adds/updates canonical cards and touches
 *   nothing else, so it's safe to run on a schedule as new sets drop.
 */
export function seedPokemon(db, rows, { migrate = true } = {}) {
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, image, language, external_ids)
     VALUES (?, 'PKMN', ?, ?, ?, ?, ?, ?, ?)
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

  // Canonical = has a ptcgdata external_id. Old = any other PKMN card
  // (pkmn-pc* from PriceCharting + the thin pokemontcg-API-seeded ones).
  const isCanonical = `json_extract(external_ids, '$.ptcgdata') IS NOT NULL`;
  const canonical = db.prepare(`SELECT id, name, number, set_name FROM cards WHERE ip='PKMN' AND ${isCanonical}`).all();

  // 2. Re-point on-chain SALES from old cards → canonical so we never lose real
  //    solds. Old cards' number format differs ("#4" vs "4/102"), so re-point by
  //    running the tested matcher on a reconstructed title rather than exact code.
  const oldPk = db.prepare(`SELECT id, name, number, set_name FROM cards WHERE ip='PKMN' AND NOT (${isCanonical})`).all();
  const hasSales = new Set(db.prepare(`SELECT DISTINCT card_id FROM sales`).all().map(r => r.card_id));
  const repoint = db.prepare(`UPDATE sales SET card_id = ? WHERE card_id = ?`);
  let repointed = 0;
  for (const o of oldPk) {
    if (!hasSales.has(o.id)) continue;                 // only bother for cards with sales
    const title = `${o.name ?? ''} #${o.number ?? ''} ${o.set_name ?? ''}`.trim();
    const canon = matchListing(title, canonical);
    if (canon && canon !== o.id) repointed += Number(repoint.run(canon, o.id).changes);
  }

  // 3. Delete old non-canonical PKMN cards that no longer have sales (FK-safe).
  const purged = db.prepare(
    `DELETE FROM cards WHERE ip='PKMN' AND NOT (${isCanonical})
       AND id NOT IN (SELECT DISTINCT card_id FROM sales)`
  ).run().changes;

  // 4. Clean derived rows orphaned by the delete (these tables have no FK), and
  //    null out listing/registry pointers to retired cards (rematch re-attributes).
  db.prepare(`DELETE FROM oracle_prices  WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM external_marks WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM latest_marks   WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`DELETE FROM basket_members WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE gacha_listings SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();
  db.prepare(`UPDATE nft_registry   SET card_id = NULL WHERE card_id NOT IN (SELECT id FROM cards)`).run();

  db.exec('COMMIT');
  const keptWithSales = oldPk.length - Number(purged);
  return { seeded: n, purgedOld: Number(purged), salesRepointed: repointed, oldKeptStillHasSales: keptWithSales };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const rows = await loadRows(process.argv.includes('--snapshot'));
  const res = seedPokemon(db, rows, { migrate: !process.argv.includes('--upsert-only') });
  console.log('[seed:pokemon]', JSON.stringify({ ...res, sample: rows.slice(0, 2).map(r => ({ id: r.id, name: r.name, number: r.number, set: r.set_name })) }, null, 1));
  console.log('[seed:pokemon] NEXT: `npm run rematch -- --listings-only` to re-point listings, then a full `npm run ingest` so PriceCharting prices merge into canonical.');
}
