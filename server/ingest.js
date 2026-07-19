/**
 * Nightly ingestion job. Run: `npm run ingest` (cron: nightly).
 *
 * Live mode (keys present):
 *   pokemontcg (PKMN metadata) + universe.js OP list → cards
 *   pricecharting → resolve product ids (once, cached) → external_marks (today)
 *   [ebay-insights → raw sales, when partner access is granted]
 * Demo mode (no keys): deterministic synthetic solds, full pipeline offline.
 *
 * Always: outlier flags → oracle marks (solds first, external bootstrap second)
 * → rules-based indexes. Idempotent throughout.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { makeDemoAdapter } from './adapters/demo.js';
import { makePokemonTcgAdapter } from './adapters/pokemontcg.js';
import { makePriceChartingAdapter } from './adapters/pricecharting.js';
import { opCardRecords } from './universe.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

function upsertCards(db, cards) {
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, set_name = excluded.set_name, number = excluded.number,
       variant = excluded.variant,
       external_ids = json_patch(cards.external_ids, excluded.external_ids)`
  );
  for (const c of cards) {
    ins.run(c.id, c.ip, c.name, c.set_name ?? null, c.number ?? null, c.variant ?? '', JSON.stringify(c.external_ids ?? {}));
  }
  return cards.length;
}

function insertSales(db, sales) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, ?, ?)`
  );
  let n = 0;
  for (const s of sales) { ins.run(s.card_id, s.grade, s.price_cents, s.sold_at, s.source, s.external_id); n++; }
  return n;
}

/** If a demo run ever populated this DB, wipe synthetic data + derived tables. */
function purgeDemoData(db) {
  const demo = db.prepare(`SELECT COUNT(*) n FROM sales WHERE source = 'demo'`).get().n;
  if (!demo) return 0;
  db.exec(`
    DELETE FROM sales WHERE source = 'demo';
    DELETE FROM cards WHERE json_extract(external_ids, '$.pcQuery') IS NULL
                        AND json_extract(external_ids, '$.ptcgio') IS NULL;
    DELETE FROM oracle_prices WHERE card_id NOT IN (SELECT id FROM cards);
    DELETE FROM basket_members WHERE card_id NOT IN (SELECT id FROM cards);
    DELETE FROM index_values;
  `);
  console.log(`[ingest] purged ${demo} demo sales + derived rows (live mode)`);
  return demo;
}

async function runLive(db, today) {
  const summary = { mode: 'live', cards: 0, resolved: 0, externalMarks: 0, salesIngested: 0 };
  summary.demoPurged = purgeDemoData(db);

  // 1. Card universe: PKMN metadata + manual OP list.
  const ptcg = makePokemonTcgAdapter();
  const pkmnCards = await ptcg.listCards();
  summary.cards += upsertCards(db, pkmnCards);
  summary.cards += upsertCards(db, opCardRecords());

  // 2. PriceCharting: resolve ids (once per card), then today's external marks.
  if (process.env.PRICECHARTING_API_KEY) {
    const pc = makePriceChartingAdapter();
    const resolveLimit = Number(process.env.PC_RESOLVE_LIMIT ?? 150);
    const unresolvedAll = db.prepare(
      `SELECT id, external_ids FROM cards
       WHERE json_extract(external_ids, '$.pricecharting') IS NULL
         AND json_extract(external_ids, '$.pcQuery') IS NOT NULL`
    ).all();
    const unresolved = unresolvedAll.slice(0, resolveLimit);
    if (unresolvedAll.length > resolveLimit) {
      console.log(`[ingest] resolving ${resolveLimit}/${unresolvedAll.length} unresolved cards this run (throttled); the rest resolve on subsequent runs`);
    }
    const setId = db.prepare(
      `UPDATE cards SET external_ids = json_set(external_ids, '$.pricecharting', ?) WHERE id = ?`
    );
    for (const row of unresolved) {
      const q = JSON.parse(row.external_ids).pcQuery;
      try {
        const [best] = await pc.resolveProduct(q);
        if (best) { setId.run(String(best.pcId), row.id); summary.resolved++; }
      } catch (e) {
        console.warn(`[ingest] resolve failed for ${row.id}: ${e.message}`);
      }
    }

    const resolved = db.prepare(`SELECT id, external_ids FROM cards WHERE json_extract(external_ids, '$.pricecharting') IS NOT NULL`)
      .all().map(r => ({ id: r.id, external_ids: JSON.parse(r.external_ids) }));
    const marks = await pc.fetchExternalMarks(resolved, today);
    const insMark = db.prepare(
      `INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES (?, ?, ?, ?, ?)`
    );
    for (const m of marks) { insMark.run(m.source, m.card_id, m.grade, m.as_of, m.price_cents); summary.externalMarks++; }
  }

  // 3. Raw solds: slot for eBay Marketplace Insights when access is granted.
  //    (Gacha on-chain sales land here in build step 2 — they're public data.)

  return summary;
}

async function runDemo(db) {
  const adapter = makeDemoAdapter();
  const cards = await adapter.listCards();
  const n = upsertCards(db, cards);
  const sales = await adapter.fetchSales(cards.map(c => c.id), new Date(Date.now() - 180 * DAY_MS).toISOString().slice(0, 10));
  return { mode: 'demo', cards: n, salesIngested: insertSales(db, sales) };
}

export async function ingest({ db = null, dates = null } = {}) {
  mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
  const database = db ?? openDb();
  const today = new Date().toISOString().slice(0, 10);
  const live = Boolean(process.env.PRICECHARTING_API_KEY || process.env.POKEMONTCG_API_KEY || process.env.EBAY_CLIENT_ID);

  const sourceSummary = live ? await runLive(database, today) : await runDemo(database);

  const outliers = refreshOutlierFlags(database);

  // Mark dates: union of sales range and external-mark range.
  let markDates = dates;
  if (!markDates) {
    const range = database.prepare(`
      SELECT MIN(d) lo, MAX(d) hi FROM (
        SELECT date(sold_at) d FROM sales
        UNION ALL SELECT as_of d FROM external_marks
      )`).get();
    markDates = [];
    if (range?.lo) {
      for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += DAY_MS) {
        markDates.push(new Date(t).toISOString().slice(0, 10));
      }
    }
  }
  const oracle = refreshOracle(database, markDates);
  const indexes = refreshIndexes(database);

  const summary = { ...sourceSummary, ...outliers, ...oracle, ...indexes };
  console.log('[ingest]', JSON.stringify(summary));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch(e => { console.error(e); process.exit(1); });
}
