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
import { timedFetch } from './net.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { makeDemoAdapter } from './adapters/demo.js';
import { makePokemonTcgAdapter } from './adapters/pokemontcg.js';
import { makePriceChartingAdapter } from './adapters/pricecharting.js';
import { makeCollectorCryptAdapter } from './adapters/collectorcrypt.js';
import { makeCourtyardListingsAdapter } from './adapters/courtyard-listings.js';
import { makeMnstrListingsAdapter } from './adapters/mnstr-listings.js';
import { makePhygitalsListingsAdapter } from './adapters/phygitals-listings.js';
import { runSolanaIndexer, registerListings } from './indexer-solana.js';
import { importCsv } from './import-pricecharting-csv.js';
import { matchListings } from './match.js';
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

  // Fresh-skip (--if-stale slots): when today's PriceCharting import already
  // landed, skip the once-daily heavy steps (universe + CSVs) but STILL run
  // listings accumulation + sales indexers below.
  const freshSkip = process.env.TOPLOAD_SKIP_FRESH === '1' && (() => {
    try {
      const today0 = new Date().toISOString().slice(0, 10);
      return db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE source = 'pricecharting' AND as_of = ?`).get(today0).n > 0;
    } catch { return false; }
  })();
  if (freshSkip) console.log('[ingest] fresh-skip: universe + CSVs already current today — running listings + sales only');

  // 1. Card universe: OWNED by the canonical catalog seeds (seed:pokemon /
  //    seed:onepiece / seed:yugioh + weekly catalog:refresh). Ingest no longer
  //    mutates the universe — the old per-run pokemontcg.io 5-set fetch both
  //    depended on a flaky API (504s live, 2026-07-20) and re-created retired
  //    old-scheme cards every run, silently regrowing remnants.

  const insMark = db.prepare(
    `INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES (?, ?, ?, ?, ?)`
  );

  // 1b. Free price bootstrap: TCGplayer market snapshots via pokemontcg.io
  //     (raw grade, PKMN only — costs nothing, discounted hardest by the
  //     oracle). Keyed to canonical ids (pkmn-<ptcgio id>); tracked set from
  //     the DB so marks only ever land on cards that exist.
  if (!freshSkip) {
  try {
    const ptcg = makePokemonTcgAdapter();
    const tracked = db.prepare(`SELECT id FROM cards WHERE ip = 'PKMN'`).all();
    const freeMarks = await ptcg.fetchExternalMarks(tracked, today);
    for (const m of freeMarks) { insMark.run(m.source, m.card_id, m.grade, m.as_of, m.price_cents); summary.externalMarks++; }
    console.log(`[ingest] tcgplayer snapshot marks: ${freeMarks.length}`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] tcgplayer snapshot fetch failed: ${e.message}`);
  }
  }

  // 2a. PriceCharting CSV auto-fetch (preferred bulk route, zero-touch daily).
  //     .env: PC_CSV_URL_PKMN / PC_CSV_URL_YGO / PC_CSV_URL_OP — the download
  //     links from pricecharting.com/subscriptions ("API/Download"); the files
  //     regenerate server-side every 24h behind stable URLs.
  const csvSources = freshSkip ? [] : [
    ['PKMN', process.env.PC_CSV_URL_PKMN],
    ['YGO', process.env.PC_CSV_URL_YGO],
    ['OP', process.env.PC_CSV_URL_OP],
  ].filter(([, url]) => url);
  for (const [ip, url] of csvSources) {
    try {
      const res = await timedFetch(url);
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

  // 2b. PriceCharting per-card API — ONLY for setups with no CSV subscription
  //     at all. Gate on whether CSV URLs are CONFIGURED, not on this run's
  //     csvSources (freshSkip empties that list, which wrongly re-enabled this
  //     path on --if-stale runs — live 2026-07-20: it started crawling 9,916
  //     canonical cards via loose search-based resolution, an accuracy risk
  //     AND an hours-long delay ahead of the oracle refresh).
  const csvConfigured = Boolean(process.env.PC_CSV_URL_PKMN || process.env.PC_CSV_URL_YGO || process.env.PC_CSV_URL_OP);
  if (process.env.PRICECHARTING_API_KEY && !csvConfigured) {
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
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name, language FROM cards`).all()) {
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
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, cert, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of listings) {
      insL.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, l.image_back ?? null, l.nft_address, l.cert ?? null, l.seen_at);
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
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name, language FROM cards`).all()) {
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
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, proof, cert, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    );
    for (const l of listings) {
      insY.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, l.nft_address, l.proof ?? null, l.cert ?? null, l.seen_at);
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

  // 3c. Gacha listings: MNSTR (MegaETH vault) — official public collection API.
  //     Full snapshot each run (the API returns the CURRENT in-stock set), so
  //     snapshot-replace is correct here (unlike Courtyard's rolling feed).
  try {
    const mnstr = makeMnstrListingsAdapter();
    const listings = await mnstr.fetchListings({ seenAt: today });
    const universeByIp = {};
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name, language FROM cards`).all()) {
      (universeByIp[c.ip] ??= []).push(c);
    }
    const matches = new Map();
    for (const ip of ['PKMN', 'OP', 'YGO']) {
      const subset = listings.filter(l => l.ip === ip);
      if (!subset.length || !universeByIp[ip]) continue;
      for (const [k, v] of matchListings(subset, universeByIp[ip])) matches.set(k, v);
    }
    db.exec(`DELETE FROM gacha_listings WHERE platform = 'mnstr'`); // full snapshot refresh
    const insM = db.prepare(
      `INSERT OR REPLACE INTO gacha_listings
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, proof, cert, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of listings) {
      insM.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, l.image_back ?? null, l.nft_address, l.slug ?? null, l.cert ?? null, l.seen_at);
    }
    summary.mnstrListings = listings.length;
    summary.mnstrMatched = matches.size;
    console.log(`[ingest] mnstr listings: ${listings.length} (${matches.size} matched to tracked cards)`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] mnstr listings fetch failed: ${e.message}`);
  }

  // 3d. Gacha listings: Phygitals — their marketplace API (mapped live
  //     2026-07-21: PKMN ~8k, OP ~400, YGO ~36). The API returns the current
  //     listed set → snapshot-replace like MNSTR. English Pokémon rows carry
  //     the PTCG.io 'Card Id' → exact canonical attach (no fuzzy); Japanese
  //     and everything else language-route through the matcher. Mints also
  //     feed nft_registry so the on-chain sales indexer attributes future
  //     Phygitals sales to cards automatically.
  try {
    const phyg = makePhygitalsListingsAdapter();
    const listings = await phyg.fetchListings({ seenAt: today });
    const universeByIp = {};
    for (const c of db.prepare(`SELECT id, ip, name, number, set_name, language FROM cards`).all()) {
      (universeByIp[c.ip] ??= []).push(c);
    }
    const cardIds = new Set(db.prepare(`SELECT id FROM cards`).all().map(r => r.id));
    const matches = new Map();
    const needFuzzy = [];
    let exact = 0;
    for (const l of listings) {
      if (l.exact_card_id && cardIds.has(l.exact_card_id)) { matches.set(l.external_id, l.exact_card_id); exact++; }
      else needFuzzy.push(l);
    }
    for (const ip of ['PKMN', 'OP', 'YGO']) {
      const subset = needFuzzy.filter(l => l.ip === ip);
      if (!subset.length || !universeByIp[ip]) continue;
      for (const [k, v] of matchListings(subset, universeByIp[ip])) matches.set(k, v);
    }
    db.exec(`DELETE FROM gacha_listings WHERE platform = 'phygitals'`); // full snapshot refresh
    const insP = db.prepare(
      `INSERT OR REPLACE INTO gacha_listings
       (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, image, image_back, nft_address, proof, cert, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of listings) {
      insP.run(l.platform, l.external_id, matches.get(l.external_id) ?? null, l.item_name, l.category,
               l.grade, l.price_cents, l.currency, l.listed_at, l.image, null, l.nft_address, l.slug ?? null, l.cert ?? null, l.seen_at);
    }
    registerListings(db, listings, matches);
    summary.phygitalsListings = listings.length;
    summary.phygitalsMatched = matches.size;
    console.log(`[ingest] phygitals listings: ${listings.length} (${matches.size} matched — ${exact} exact by Card Id)`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] phygitals listings fetch failed: ${e.message}`);
  }

  // 4. Raw solds — on-chain gacha sales (self-collected, first-class oracle input).
  if (process.env.HELIUS_API_KEY) {
    try {
      const idx = await runSolanaIndexer(db, { maxPages: Number(process.env.HELIUS_MAX_PAGES ?? 5) });
      summary.onchainSales = idx.inserted;
    } catch (e) {
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
      console.warn(`[ingest] courtyard indexer failed: ${e.message}`);
    }
  }
  // MNSTR (MegaETH): feed-discovery + on-chain price verification (see indexer).
  try {
    const { runMnstrSalesIndexer } = await import('./indexer-mnstr-sales.js');
    const idx = await runMnstrSalesIndexer(db, {});
    summary.mnstrSales = idx.inserted;
    console.log(`[ingest] mnstr sales: ${idx.inserted} inserted (${idx.matched} matched, ${idx.verified} chain-verified of ${idx.fetched} feed rows)`);
  } catch (e) {
    rollback();
    console.warn(`[ingest] mnstr sales indexer failed: ${e.message}`);
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
  // --if-stale: skip only the HEAVY, once-daily steps (card universe + CSV
  // imports) when today's PriceCharting data already landed. Listings
  // accumulation and sales indexing run on EVERY slot — the old exit-early
  // semantics (a fallback chain for a sleeping Mac) silently froze Courtyard
  // listings at the 18:00 run only (caught 2026-07-20 morning: stuck at 38).
  if (process.argv.includes('--if-stale')) {
    process.env.TOPLOAD_SKIP_FRESH = '1';
  }
  ingest().catch(e => { console.error(e); process.exit(1); });
}
