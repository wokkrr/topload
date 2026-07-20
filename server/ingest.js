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
import { makeCollectorCryptAdapter } from './adapters/collectorcrypt.js';
import { makeCourtyardListingsAdapter } from './adapters/courtyard-listings.js';
import { runSolanaIndexer, registerListings } from './indexer-solana.js';
import { importCsv } from './import-pricecharting-csv.js';
import { matchListings } from './match.js';
import { opCardRecords } from './universe.js';
import { writeFileSync } from 'node:fs';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

function upsertCards(db, cards) {
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, image, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, set_name = excluded.set_name, number = excluded.number,
       variant = excluded.variant,
       image = COALESCE(excluded.image, cards.image),
       external_ids = json_patch(cards.external_ids, excluded.external_ids)`
  );
  for (const c of cards) {
    ins.run(c.id, c.ip, c.name, c.set_name ?? null, c.number ?? null, c.variant ?? '', c.image ?? null, JSON.stringify(c.external_ids ?? {}));
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
  // A source that dies mid-write (e.g. 'database is locked' losing a race with
  // a long backfill) can leave its transaction OPEN on this connection — roll
  // it back so later steps don't hit 'transaction within a transaction'
  // (bit us live 2026-07-20 while the first backfill marathon was running).
  const rollback = () => { try { db.exec('ROLLBACK'); } catch { /* no open txn */ } };
  const summary = { mode: 'live', cards: 0, resolved: 0, externalMarks: 0, salesIngested: 0 };
  summary.demoPurged = purgeDemoData(db);

  // 1. Card universe: PKMN metadata + manual OP list. Each source is
  //    independently fault-tolerant — one API being down must not kill ingest.
  const ptcg = makePokemonTcgAdapter();
  let pkmnCards = [];
  try {
    pkmnCards = await ptcg.listCards();
    summary.cards += upsertCards(db, pkmnCards);
  } catch (e) {
    rollback();
    console.warn(`[ingest] pokemontcg universe fetch failed: ${e.message}`);
  }
  summary.cards += upsertCards(db, opCardRecords());

  const insMark = db.prepare(
    `INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES (?, ?, ?, ?, ?)`
  );

  // 1b. Free price bootstrap: TCGplayer market snapshots via pokemontcg.io
  //     (raw grade, PKMN only — costs nothing, discounted hardest by the oracle).
  try {
    if (pkmnCards.length) {
      const freeMarks = await ptcg.fetchExternalMarks(pkmnCards, today);
      for (const m of freeMarks) { insMark.run(m.source, m.card_id, m.grade, m.as_of, m.price_cents); summary.externalMarks++; }
      console.log(`[ingest] tcgplayer snapshot marks: ${freeMarks.length}`);
    }
  } catch (e) {
    rollback();
    console.warn(`[ingest] tcgplayer snapshot fetch failed: ${e.message}`);
  }

  // 2a. PriceCharting CSV auto-fetch (preferred bulk route, zero-touch daily).
  //     .env: PC_CSV_URL_PKMN / PC_CSV_URL_YGO / PC_CSV_URL_OP — the download
  //     links from pricecharting.com/subscriptions ("API/Download"); the files
  //     regenerate server-side every 24h behind stable URLs.
  const csvSources = [
    ['PKMN', process.env.PC_CSV_URL_PKMN],
    ['YGO', process.env.PC_CSV_URL_YGO],
    ['OP', process.env.PC_CSV_URL_OP],
  ].filter(([, url]) => url);
  for (const [ip, url] of csvSources) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.slice(0, 200).includes('product-name')) throw new Error('response is not a price-guide CSV (check the URL)');
      mkdirSync(join(__dirname, '..', 'data', 'imports'), { recursive: true });
      writeFileSync(join(__dirname, '..', 'data', 'imports', `${today}-${ip}.csv`), text);
      const r = importCsv(db, {
        text, ip, asOf: today,
        minVolume: Number(process.env.PC_MIN_VOLUME ?? 10),
        minPriceCents: Number(process.env.PC_MIN_PRICE_CENTS ?? 200),
      });
      summary.externalMarks += r.marks;
      console.log(`[ingest] pricecharting csv ${ip}: ${JSON.stringify(r)}`);
    } catch (e) {
      rollback();
      console.warn(`[ingest] pricecharting csv ${ip} failed: ${e.message}`);
    }
  }

  // 2b. PriceCharting per-card API — only used when no CSV URLs are configured
  //     (the CSV route supersedes card-by-card resolution).
  if (process.env.PRICECHARTING_API_KEY && csvSources.length === 0) {
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
        rollback();
        console.warn(`[ingest] resolve failed for ${row.id}: ${e.message}`);
      }
    }

    const resolved = db.prepare(`SELECT id, external_ids FROM cards WHERE json_extract(external_ids, '$.pricecharting') IS NOT NULL`)
      .all().map(r => ({ id: r.id, external_ids: JSON.parse(r.external_ids) }));
    const marks = await pc.fetchExternalMarks(resolved, today);
    for (const m of marks) { insMark.run(m.source, m.card_id, m.grade, m.as_of, m.price_cents); summary.externalMarks++; }
  }

  // 3. Gacha listings: Collector Crypt current listings (asking prices → aggregator only).
  try {
    const cc = makeCollectorCryptAdapter();
    const listings = await cc.fetchListings({ seenAt: today, maxPages: Number(process.env.CC_MAX_PAGES ?? 20) });
    // Franchise-scoped matching: a One Piece listing may only match OP cards.
    const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO' };
    const universeByIp = {};
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) {
      (universeByIp[c.ip] ??= []).push(c);
    }
    const matches = new Map();
    for (const [category, ip] of Object.entries(CATEGORY_TO_IP)) {
      const subset = listings.filter(l => l.category === category);
      if (!subset.length || !universeByIp[ip]) continue;
      for (const [k, v] of matchListings(subset, universeByIp[ip])) matches.set(k, v);
    }
    db.exec(`DELETE FROM gacha_listings WHERE platform = 'collectorcrypt'`); // snapshot refresh
    const insL = db.prepare(
      `INSERT OR REPLACE INTO gacha_listings
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of listings) {
      insL.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, l.image_back ?? null, l.nft_address, l.seen_at);
    }
    summary.gachaListings = listings.length;
    summary.gachaMatched = matches.size;
    summary.registered = registerListings(db, listings, matches);
    console.log(`[ingest] collectorcrypt listings: ${listings.length} (${matches.size} matched to tracked cards)`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] collectorcrypt fetch failed: ${e.message}`);
  }

  // 3b. Gacha listings: Courtyard (Polygon vault) — official recently-listed API.
  try {
    const yard = makeCourtyardListingsAdapter();
    const listings = await yard.fetchListings({ seenAt: today, maxPages: Number(process.env.YARD_LISTINGS_MAX_PAGES ?? 20) });
    const universeByIp = {};
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) {
      (universeByIp[c.ip] ??= []).push(c);
    }
    // Each listing already carries its franchise (ip); match within that universe.
    const matches = new Map();
    for (const ip of ['PKMN', 'OP', 'YGO']) {
      const subset = listings.filter(l => l.ip === ip);
      if (!subset.length || !universeByIp[ip]) continue;
      for (const [k, v] of matchListings(subset, universeByIp[ip])) matches.set(k, v);
    }
    // ACCUMULATE, don't snapshot: the recently-listed feed is a rolling window,
    // so each ingest adds the new flow on top of everything already seen.
    const insY = db.prepare(
      `INSERT OR REPLACE INTO gacha_listings
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, proof, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    );
    for (const l of listings) {
      insY.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, l.nft_address, l.proof ?? null, l.seen_at);
    }
    // Prune SOLD: our own Courtyard sales indexer sees every fill — a sale of
    // the same token on/after the listing date means this ask is gone. (Sales
    // store external_id as '<hash>:<tokenId first 18 chars>'.)
    const sold = db.prepare(
      `DELETE FROM gacha_listings WHERE platform = 'courtyard' AND EXISTS (
         SELECT 1 FROM sales s WHERE s.source = 'courtyard'
           AND s.external_id LIKE '%:' || substr(gacha_listings.nft_address, 1, 18)
           AND (gacha_listings.listed_at IS NULL OR date(s.sold_at) >= gacha_listings.listed_at))`
    ).run();
    // Prune STALE: orders expire / get repriced off-feed — cap shelf life.
    const stale = db.prepare(
      `DELETE FROM gacha_listings WHERE platform = 'courtyard' AND seen_at < date('now', '-45 days')`
    ).run();
    const live = db.prepare(`SELECT COUNT(*) n FROM gacha_listings WHERE platform = 'courtyard'`).get().n;
    summary.yardListings = listings.length;
    summary.yardMatched = matches.size;
    console.log(`[ingest] courtyard listings: +${listings.length} new (${matches.size} matched) · ${live} accumulated · pruned ${Number(sold.changes)} sold, ${Number(stale.changes)} stale`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] courtyard listings fetch failed: ${e.message}`);
  }

  // 4. Raw solds — on-chain gacha sales (self-collected, first-class oracle input).
  if (process.env.HELIUS_API_KEY) {
    try {
      const idx = await runSolanaIndexer(db, { maxPages: Number(process.env.HELIUS_MAX_PAGES ?? 5) });
      summary.onchainSales = idx.inserted;
    } catch (e) {
     rollback();
      rollback();
      console.warn(`[ingest] solana indexer failed: ${e.message}`);
    }
  }
  if (process.env.ALCHEMY_API_KEY) {
    try {
      const { runBaseIndexer } = await import('./indexer-base.js');
      const idx = await runBaseIndexer(db, {});
      summary.beezieSales = idx.inserted;
    } catch (e) {
     rollback();
      rollback();
      console.warn(`[ingest] base indexer failed: ${e.message}`);
    }
  }
  if (process.env.HELIUS_API_KEY) {
    try {
      const { runPhygitalsIndexer } = await import('./indexer-phygitals.js');
      const idx = await runPhygitalsIndexer(db, { maxPages: Number(process.env.HELIUS_MAX_PAGES ?? 5) });
      summary.phygitalsSales = idx.inserted;
    } catch (e) {
     rollback();
      rollback();
      console.warn(`[ingest] phygitals indexer failed: ${e.message}`);
    }
  }
  if (process.env.ALCHEMY_API_KEY) {
    try {
      const { runCourtyardIndexer } = await import('./indexer-courtyard.js');
      const idx = await runCourtyardIndexer(db, {});
      summary.courtyardSales = idx.inserted;
    } catch (e) {
     rollback();
      rollback();
      console.warn(`[ingest] courtyard indexer failed: ${e.message}`);
    }
  }
  rollback(); // belt-and-suspenders: never hand an open txn to the oracle refresh

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
  // Live mode: any API key present, or TOPLOAD_MODE=live (free path needs no key at all).
  const live = process.env.TOPLOAD_MODE === 'live'
    || Boolean(process.env.PRICECHARTING_API_KEY || process.env.POKEMONTCG_API_KEY || process.env.EBAY_CLIENT_ID);

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
  // --if-stale: exit quietly when today's PriceCharting import already landed.
  // Lets cron fire at several times a day (9am/12pm/6pm) as fallbacks for a
  // sleeping Mac — the first successful run wins, later slots no-op.
  if (process.argv.includes('--if-stale')) {
    try {
      const db = openDb();
      const today = new Date().toISOString().slice(0, 10);
      const done = db.prepare(
        `SELECT COUNT(*) n FROM external_marks WHERE source = 'pricecharting' AND as_of = ?`
      ).get(today).n;
      if (done > 0) {
        console.log(`[ingest] --if-stale: today's pricecharting data already imported (${done} marks) — skipping`);
        process.exit(0);
      }
    } catch { /* no db yet → proceed with full ingest */ }
  }
  ingest().catch(e => { console.error(e); process.exit(1); });
}
