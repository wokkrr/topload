/**
 * Nightly ingestion job. Run: `npm run ingest` (cron: nightly).
 *
 * Pipeline: adapters → sales (deduped) → outlier flags → oracle marks → indexes.
 * Idempotent: re-running upserts, never duplicates (UNIQUE(source, external_id)).
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { makeDemoAdapter } from './adapters/demo.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

function pickAdapters() {
  // Live adapters activate automatically once keys are present.
  const adapters = [];
  if (process.env.EBAY_APP_ID) {
    // adapters.push(makeEbayAdapter());
  }
  if (adapters.length === 0) adapters.push(makeDemoAdapter());
  return adapters;
}

export async function ingest({ db = null, sinceDays = 180, dates = null } = {}) {
  mkdirSync(join(__dirname, '..', 'data'), { recursive: true });
  const database = db ?? openDb();
  const adapters = pickAdapters();
  const sinceISO = new Date(Date.now() - sinceDays * DAY_MS).toISOString().slice(0, 10);

  const insCard = database.prepare(
    `INSERT OR REPLACE INTO cards (id, ip, name, set_name, number, variant, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insSale = database.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, ?, ?)`
  );

  let cardCount = 0, saleCount = 0;
  for (const adapter of adapters) {
    const cards = await adapter.listCards();
    for (const c of cards) {
      insCard.run(c.id, c.ip, c.name, c.set_name ?? null, c.number ?? null, c.variant ?? '', JSON.stringify(c.external_ids ?? {}));
      cardCount++;
    }
    const sales = await adapter.fetchSales(cards.map(c => c.id), sinceISO);
    for (const s of sales) {
      insSale.run(s.card_id, s.grade, s.price_cents, s.sold_at, s.source, s.external_id);
      saleCount++;
    }
  }

  const outliers = refreshOutlierFlags(database);

  // Recompute marks over the sales date range (or supplied dates).
  const range = database.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales`).get();
  let markDates = dates;
  if (!markDates && range?.lo) {
    markDates = [];
    for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += DAY_MS) {
      markDates.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  const oracle = refreshOracle(database, markDates ?? []);
  const indexes = refreshIndexes(database);

  const summary = { adapters: adapters.map(a => a.name), cards: cardCount, salesIngested: saleCount, ...outliers, ...oracle, ...indexes };
  console.log('[ingest]', JSON.stringify(summary));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().catch(e => { console.error(e); process.exit(1); });
}
