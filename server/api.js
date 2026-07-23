/**
 * Read API for the terminal UI. Run: `npm run api` (default port 5174).
 * Vite dev server proxies /api → here (see vite.config.js).
 */
import express from 'express';
import compression from 'compression';
import { existsSync, mkdirSync, createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timedFetch } from './net.js';
import { openDb } from './db.js';
import { PLATFORMS } from './platforms.js';
import { refreshLatestMarks, markTopGrades } from './oracle.js';
import { findLanguageSiblings } from './language-siblings.js';
import { getDeals } from './deals.js';
import { getMovers } from './movers.js';
import { buildBinderSeries, buildBinderMovers } from './binder.js';
import { buildSealedBook } from './sealed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();
// First boot after the latest_marks migration: build it once so the hot
// paths have data before the next ingest refreshes it.
if (db.prepare(`SELECT COUNT(*) n FROM latest_marks`).get().n === 0) {
  console.log('[api] building latest_marks (one-time)…');
  console.log(`[api] latest_marks ready: ${refreshLatestMarks(db)} rows`);
} else if (!db.prepare(`SELECT 1 FROM latest_marks WHERE is_top = 1 LIMIT 1`).get()) {
  // Migration self-heal: flags are new — compute once for the existing table.
  console.log('[api] computing top-grade flags (one-time)…');
  markTopGrades(db);
}
const app = express();
// Gzip everything — the listings JSON alone is ~2MB raw / ~200KB compressed,
// and the app bundle drops 245KB → 73KB. This was the "slow to load all the
// cards" (Kaleb, 2026-07-20): payloads shipped uncompressed.
app.use(compression());

// ── Card-art caching proxy ─────────────────────────────────────────────────
// Bandai's card sites (onepiece-cardgame.com) block browser HOTLINKING —
// their art fails to render inside our pages (seen live: every OP mover
// thumbnail broken, 2026-07-21). Referer-based blocks don't stop a direct
// server-side fetch, so we fetch each image ONCE from the droplet, cache it
// on disk, and serve it from our own origin — the first slice of the
// "mirror the art we display" backlog item. Only card ids we actually track
// are fetchable, and only their stored catalog URL — this is not an open proxy.
const IMG_CACHE = join(__dirname, '..', 'data', 'imgcache');
mkdirSync(IMG_CACHE, { recursive: true });
const HOTLINK_BLOCKED = /onepiece-cardgame\.com/i;
const proxiedImage = (cardId, url) =>
  url && cardId && HOTLINK_BLOCKED.test(url) ? `/api/img/${encodeURIComponent(cardId)}` : url;

// Image choice per card (Kaleb, 2026-07-21): own/official art (incl. curated
// variant art) first; then a REAL photo of a matched listing; BORROWED base-
// printing art only as last resort — a Reverse Holo's foil isn't visible in
// borrowed art, and an actual slab photo shows the true finish.
const pickImage = (cardId, cardImage, cardKind, listingPhoto) => {
  const chosen =
    cardImage && cardKind !== 'borrowed' ? { image: cardImage, image_kind: cardKind ?? 'official' }
    : listingPhoto ? { image: listingPhoto, image_kind: 'listing' }
    : cardImage ? { image: cardImage, image_kind: 'borrowed' }
    : { image: null, image_kind: null };
  chosen.image = proxiedImage(cardId, chosen.image);
  return chosen;
};

app.get('/api/img/:cardId', async (req, res) => {
  const row = db.prepare(`SELECT image FROM cards WHERE id = ?`).get(req.params.cardId);
  if (!row?.image) return res.status(404).end();
  const ext = /\.jpe?g($|\?)/i.test(row.image) ? 'jpg' : 'png';
  const file = join(IMG_CACHE, `${req.params.cardId.replace(/[^a-z0-9_-]/gi, '_')}.${ext}`);
  if (!existsSync(file)) {
    try {
      const r = await timedFetch(row.image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return res.status(404).end();
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    } catch { return res.status(404).end(); }
  }
  res.set('Cache-Control', 'public, max-age=604800');
  res.type(ext);
  createReadStream(file).pipe(res);
});

/** GET /api/indexes?days=90 → [{index_id, series, members, window_sales, window_vol_cents, published}] */
app.get('/api/indexes', (req, res) => {
  const days = Math.min(365, parseInt(req.query.days ?? '90', 10));
  // An index is PUBLISHED only when its basket has enough genuinely-traded
  // constituents — a flat line built on 2 cards pretends to be a market
  // (Kaleb, 2026-07-21: "doesn't really tell you much of anything").
  const MIN_MEMBERS = 8;
  const rows = db.prepare(`
    SELECT index_id, as_of, value FROM index_values
    WHERE as_of >= date((SELECT MAX(as_of) FROM index_values), ?)
    ORDER BY index_id, as_of`).all(`-${days} day`);
  const byIndex = {};
  for (const r of rows) (byIndex[r.index_id] ??= []).push({ as_of: r.as_of, value: r.value });
  const membersStmt = db.prepare(`
    SELECT COUNT(*) n FROM basket_members
    WHERE index_id = ? AND as_of = (SELECT MAX(as_of) FROM basket_members WHERE index_id = ?)`);
  const volStmt = db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(s.price_cents), 0) v
    FROM sales s JOIN cards c ON c.id = s.card_id
    WHERE c.ip = ? AND s.is_outlier = 0 AND date(s.sold_at) >= date('now', ?)`);
  // Re-normalize each window to 100 at window start for comparability.
  res.json(Object.entries(byIndex).map(([index_id, series]) => {
    const base = series[0]?.value ?? 100;
    const members = membersStmt.get(index_id, index_id)?.n ?? 0;
    const vol = volStmt.get(index_id, `-${days} day`);
    return {
      index_id,
      members,
      window_sales: vol?.n ?? 0,
      window_vol_cents: vol?.v ?? 0,
      published: members >= MIN_MEMBERS,
      min_members: MIN_MEMBERS,
      series: series.map(p => ({ ...p, value: +(100 * p.value / base).toFixed(2) })),
    };
  }));
});

/** GET /api/movers?window=1 → biggest 1D oracle moves (see movers.js gates) */
app.get('/api/movers', (_req, res) => {
  const rows = getMovers(db);
  // 14-day mini-series per mover — the sparkline that makes a move legible
  // at a glance (Kaleb, 2026-07-21: movers should SHOW the climb).
  const sparkStmt = db.prepare(`
    SELECT price_cents FROM oracle_prices
    WHERE card_id = ? AND grade = ? ORDER BY as_of DESC LIMIT 14`);
  res.json(rows.map(({ card_image, card_kind, listing_photo, rn, ...r }) => ({
    ...r,
    ...pickImage(r.card_id, card_image, card_kind, listing_photo),
    spark: sparkStmt.all(r.card_id, r.grade).map(p => p.price_cents).reverse(),
  })));
});

// ── Beezie slab-crop proxy ─────────────────────────────────────────────────
// Beezie shoots SQUARE photos (slab floating in padding — dark set idx 0/1,
// white set idx 2/3); every other platform gives tight slab crops, so their
// tiles looked wrong on the desk (Kaleb, 2026-07-22: "we need the cropped
// images of the slabs"). No cropped variant exists on their CDN → we make
// our own: fetch the white-background photo, sharp.trim() the uniform
// border down to the slab edges, cache to disk, serve from our origin.
// Falls back to the dark set server-side when an item lacks white photos.
const BEEZIE_IMG_CACHE = join(__dirname, '..', 'data', 'imgcache-beezie');
mkdirSync(BEEZIE_IMG_CACHE, { recursive: true });
app.get('/api/beezie-img/:chain/:token/:idx', async (req, res) => {
  const { chain, token, idx } = req.params;
  if (!/^(base|flow)$/.test(chain) || !/^\d{1,10}$/.test(token) || !/^[0-3]$/.test(idx)) return res.status(400).end();
  const file = join(BEEZIE_IMG_CACHE, `${chain}-${token}-${idx}.jpg`);
  if (existsSync(file)) return res.sendFile(file, { maxAge: '30d' });
  try {
    const sharp = (await import('sharp')).default;
    let buf = null;
    // Requested index first; white → dark fallback (2→0, 3→1) for the
    // ~1-in-12 items that only shot the dark set.
    const tries = [idx, ...(idx === '2' ? ['0'] : idx === '3' ? ['1'] : [])];
    for (const i of tries) {
      const r = await timedFetch(`https://images.beezie.com/${chain}/${token}/${i}/original.jpg`);
      if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); break; }
    }
    if (!buf) return res.status(404).end();
    const out = await sharp(buf).trim({ threshold: 25 }).jpeg({ quality: 88 }).toBuffer();
    await writeFile(file, out);
    res.set('Cache-Control', 'public, max-age=2592000').type('jpeg').send(out);
  } catch {
    res.status(502).end();
  }
});

/**
 * POST /api/binder/marks — bulk live values for Binder positions.
 * Body: {positions:[{card_id, grade}]} (≤200). Returns per position the
 * current Oracle mark + lookbacks + live card meta. Positions themselves
 * live in the USER'S browser (no accounts yet — they arrive with the Buy
 * Flow's sign-in); the server only prices what it's shown.
 */
app.post('/api/binder/marks', express.json({ limit: '128kb' }), (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions.slice(0, 200) : [];
  const mark = db.prepare(
    `SELECT price_cents, price_1d, price_7d, basis, confidence, sales_7d FROM latest_marks WHERE card_id = ? AND grade = ?`);
  const meta = db.prepare(
    `SELECT id, ip, name, set_name, number, language, image AS card_image, image_kind AS card_kind,
            (SELECT g.image FROM gacha_listings g WHERE g.card_id = cards.id AND g.image IS NOT NULL LIMIT 1) AS listing_photo
     FROM cards WHERE id = ?`);
  res.json(positions.map(p => {
    const c = p?.card_id ? meta.get(String(p.card_id)) : null;
    if (!c) return { card_id: p?.card_id ?? null, grade: p?.grade ?? null, missing: true };
    const m = mark.get(c.id, String(p.grade ?? 'raw')) ?? null;
    return {
      card_id: c.id, grade: String(p.grade ?? 'raw'),
      ip: c.ip, name: c.name, set_name: c.set_name, number: c.number, language: c.language,
      ...pickImage(c.id, c.card_image, c.card_kind, c.listing_photo),
      price_cents: m?.price_cents ?? null, price_1d: m?.price_1d ?? null, price_7d: m?.price_7d ?? null,
      basis: m?.basis ?? null, confidence: m?.confidence ?? null, sales_7d: m?.sales_7d ?? null,
    };
  }));
});

/** POST /api/binder/series — {series, movers}: portfolio value history + per-position window movement (see server/binder.js). */
app.post('/api/binder/series', express.json({ limit: '128kb' }), (req, res) => {
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const days = Math.min(365, Math.max(7, parseInt(req.body?.days ?? '90', 10) || 90));
  // {series, movers}: the chart line + the per-position movement behind it
  // ("what moved" — Kaleb, 2026-07-22). One round trip, same window.
  res.json({
    series: buildBinderSeries(db, positions, { days }),
    movers: buildBinderMovers(db, positions, { days }),
  });
});

/** GET /api/sealed — the sealed order book: one entry per product, cheapest
 *  physical unit as the buy box, mint-deduped depth (mirror listings of the
 *  same token collapse — the double-spend guard), market reference price. */
app.get('/api/sealed', (_req, res) => {
  res.json(buildSealedBook(db));
});

/** GET /api/deals?limit=15 → live asks under the oracle mark (grade-matched, deduped, banded) */
app.get('/api/deals', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit ?? '15', 10));
  res.json(getDeals(db, { limit }).map(({ card_id, image, ...r }) => ({
    ...r, card_id,
    image: image ?? null,
    discount_pct: +(r.discount * 100).toFixed(1),
  })));
});

/** GET /api/basket?index=PKMN → current membership w/ marks */
app.get('/api/basket', (req, res) => {
  const indexId = req.query.index ?? 'PKMN';
  const rows = db.prepare(`
    WITH cur AS (SELECT MAX(as_of) d FROM basket_members WHERE index_id = ?)
    SELECT bm.card_id, bm.grade, bm.weight, c.name, c.set_name, c.number,
           lm.price_cents, lm.confidence, lm.sales_7d, lm.sales_30d,
           lm.price_1d, lm.price_30d
    FROM basket_members bm
    JOIN cur ON bm.as_of = cur.d
    JOIN cards c ON c.id = bm.card_id
    LEFT JOIN latest_marks lm ON lm.card_id = bm.card_id AND lm.grade = bm.grade
    WHERE bm.index_id = ?
    ORDER BY bm.weight DESC`).all(indexId, indexId);
  res.json(rows.map(r => ({
    ...r,
    change_1d_pct: r.price_1d ? +((r.price_cents / r.price_1d - 1) * 100).toFixed(2) : null,
    change_30d_pct: r.price_30d ? +((r.price_cents / r.price_30d - 1) * 100).toFixed(2) : null,
  })));
});

/** GET /api/cards?q=charizard&ip=PKMN&grade=PSA10&sort=price&limit=100 → screener */
app.get('/api/cards', (req, res) => {
  const limit = Math.min(2000, parseInt(req.query.limit ?? '100', 10));
  const clauses = [];
  const args = [];
  if (req.query.ip) { clauses.push(`c.ip = ?`); args.push(req.query.ip); }
  if (req.query.grade) { clauses.push(`lm.grade = ?`); args.push(req.query.grade); }
  if (req.query.q) {
    // Every word must appear somewhere in name/set/number. Synonym pairs let
    // both spellings find the card ('first edition' ↔ '1st Edition' — Kaleb,
    // 2026-07-21); extend the map as more collector-dialect pairs surface.
    const SYNONYMS = { first: '1st', '1st': 'first' };
    for (const word of String(req.query.q).trim().split(/\s+/).slice(0, 6)) {
      const variants = [word, SYNONYMS[word.toLowerCase()]].filter(Boolean);
      clauses.push(`(${variants.map(() => `c.name LIKE ? OR c.set_name LIKE ? OR c.number LIKE ?`).join(' OR ')})`);
      for (const v of variants) { const w = `%${v}%`; args.push(w, w, w); }
    }
  }
  const ipFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const sort = {
    price: 'price_cents DESC',
    change: 'ABS(COALESCE((price_cents * 1.0 / NULLIF(price_1d, 0) - 1), 0)) DESC',
    volume: 'sales_7d DESC, price_cents DESC',
  }[req.query.sort] ?? 'price_cents DESC';
  // ONE row per card (Kaleb, 2026-07-21): the lookup lists CARDS — the top-
  // value grade (precomputed is_top; markTopGrades runs in every rebuild)
  // represents each; the card page holds the full ladder. Request-time window
  // functions took this to 12s on the droplet — precompute at ingest, always.
  // Degrade gracefully while flags are absent (mid-migration / mid-rebuild):
  // duplicate grade rows beat an empty lookup. Grade-filtered queries are
  // already one-per-card and skip the flag.
  const topFilter = req.query.grade ? ''
    : db.prepare(`SELECT 1 FROM latest_marks WHERE is_top = 1 LIMIT 1`).get() ? 'AND lm.is_top = 1' : '';
  const rows = db.prepare(`
    SELECT o.*, c2.image AS card_image, c2.image_kind AS card_kind,
           (SELECT g.image FROM gacha_listings g WHERE g.card_id = o.card_id AND g.image IS NOT NULL LIMIT 1) AS listing_photo
    FROM (
      SELECT c.ip, c.id AS card_id, c.name, c.set_name, c.number, c.language,
             lm.grade, lm.price_cents, lm.confidence, lm.basis, lm.source, lm.sales_7d,
             lm.price_1d, lm.price_30d, lm.grades_tracked
      FROM latest_marks lm
      JOIN cards c ON c.id = lm.card_id
      WHERE 1=1 ${topFilter} ${ipFilter}
      ORDER BY ${sort} LIMIT ${limit}
    ) o
    JOIN cards c2 ON c2.id = o.card_id
    ORDER BY ${sort}`).all(...args);
  res.json(rows.map(({ card_image, card_kind, listing_photo, ...r }) => ({
    ...r,
    ...pickImage(r.card_id, card_image, card_kind, listing_photo),
    change_1d_pct: r.price_1d ? +((r.price_cents / r.price_1d - 1) * 100).toFixed(2) : null,
    change_30d_pct: r.price_30d ? +((r.price_cents / r.price_30d - 1) * 100).toFixed(2) : null,
  })));
});

/** GET /api/cards/:id → card meta + latest mark per grade (with provenance) */
app.get('/api/cards/:id', (req, res) => {
  const card = db.prepare(`
    SELECT id, ip, name, set_name, number, variant, language,
           image AS card_image, image_kind AS card_kind,
           (SELECT g.image FROM gacha_listings g WHERE g.card_id = cards.id AND g.image IS NOT NULL LIMIT 1) AS listing_photo
    FROM cards WHERE id = ?`).get(req.params.id);
  if (!card) return res.status(404).json({ error: 'unknown card' });
  const grades = db.prepare(`
    WITH latest AS (
      SELECT grade, MAX(as_of) d FROM oracle_prices WHERE card_id = ? GROUP BY grade
    )
    SELECT o.grade, o.as_of, o.price_cents, o.confidence, o.basis, o.source, o.sales_7d, o.sales_30d,
           o1.price_cents AS price_1d, o30.price_cents AS price_30d
    FROM latest
    JOIN oracle_prices o ON o.card_id = ? AND o.grade = latest.grade AND o.as_of = latest.d
    LEFT JOIN oracle_prices o1 ON o1.card_id = o.card_id AND o1.grade = o.grade AND o1.as_of = date(latest.d, '-1 day')
    LEFT JOIN oracle_prices o30 ON o30.card_id = o.card_id AND o30.grade = o.grade AND o30.as_of = date(latest.d, '-30 day')
    ORDER BY o.price_cents DESC`).all(req.params.id, req.params.id);
  const { card_image, card_kind, listing_photo, ...cardOut } = card;
  res.json({
    ...cardOut,
    ...pickImage(card.id, card_image, card_kind, listing_photo),
    other_languages: findLanguageSiblings(db, card),
    // TCGplayer daily snapshot: market (their trusted headline number) + ask
    // floor ("cheapest copy today"). Floors never touch the oracle.
    tcgplayer: db.prepare(`
      SELECT subtype, as_of, market_cents, low_cents, direct_low_cents, product_url
      FROM tcgplayer_prices WHERE card_id = ? ORDER BY subtype`).all(req.params.id),
    grades: grades.map(g => ({
      ...g,
      change_1d_pct: g.price_1d ? +((g.price_cents / g.price_1d - 1) * 100).toFixed(2) : null,
      change_30d_pct: g.price_30d ? +((g.price_cents / g.price_30d - 1) * 100).toFixed(2) : null,
    })),
  });
});

/** GET /api/cards/:id/sales → recent raw solds for one card (all grades, newest first) */
app.get('/api/cards/:id/sales', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit ?? '25', 10));
  const rows = db.prepare(`
    SELECT grade, price_cents, sold_at, source, is_outlier
    FROM sales WHERE card_id = ?
    ORDER BY sold_at DESC LIMIT ${limit}`).all(req.params.id);
  res.json(rows);
});

/** GET /api/sales/recent → global raw-solds tape (on-chain first-hand data) */
app.get('/api/sales/recent', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit ?? '20', 10));
  const rows = db.prepare(`
    SELECT s.grade, s.price_cents, s.sold_at, s.source, s.is_outlier,
           c.id AS card_id, c.name, c.set_name, c.ip
    FROM sales s JOIN cards c ON c.id = s.card_id
    WHERE s.source != 'demo'
    ORDER BY s.sold_at DESC LIMIT ${limit}`).all();
  res.json(rows);
});

/** GET /api/cards/:id/series?grade=PSA10&days=90 → oracle mark history (with provenance) */
app.get('/api/cards/:id/series', (req, res) => {
  const grade = req.query.grade ?? 'raw';
  const days = Math.min(365, parseInt(req.query.days ?? '90', 10));
  const rows = db.prepare(`
    SELECT as_of, price_cents, confidence, basis, sales_7d FROM oracle_prices
    WHERE card_id = ? AND grade = ?
      AND as_of >= date((SELECT MAX(as_of) FROM oracle_prices), ?)
    ORDER BY as_of`).all(req.params.id, grade, `-${days} day`);
  res.json(rows);
});

/** GET /api/platforms → aggregator coverage map */
app.get('/api/platforms', (_req, res) => res.json(PLATFORMS));

/** GET /api/gacha → current gacha listings with grade-matched oracle comps */
app.get('/api/gacha', (req, res) => {
  const rows = db.prepare(`
    SELECT g.platform, g.external_id, g.card_id, g.item_name, g.category, g.grade,
           g.price_cents, g.currency, g.listed_at, g.nft_address, g.image_back, g.proof, g.cert, g.listing_type, g.fmv_usd,
           COALESCE(g.image, c.image) AS image,
           CASE WHEN g.image IS NOT NULL THEN 'actual' WHEN c.image IS NOT NULL THEN 'art' END AS image_kind,
           c.name AS card_name, c.ip, c.language AS card_language,
           lm.price_cents AS comp_cents, lm.confidence AS comp_confidence, lm.basis AS comp_basis, lm.source AS comp_source,
           COALESCE(json_extract(pcert.raw, '$.pop'), pop.count) AS pop_count,
           COALESCE(json_extract(pcert.raw, '$.pop_higher'), pop.higher_count) AS pop_higher
    FROM gacha_listings g
    LEFT JOIN cards c ON c.id = g.card_id
    LEFT JOIN latest_marks lm ON lm.card_id = g.card_id AND lm.grade = g.grade
    LEFT JOIN psa_certs pcert ON pcert.cert = g.cert AND g.grade LIKE 'PSA%'
    LEFT JOIN (SELECT card_id, grade, count, higher_count, MAX(as_of) AS as_of
               FROM pop_counts WHERE source = 'psa' GROUP BY card_id, grade) pop
      ON pop.card_id = g.card_id AND pop.grade = g.grade
    ORDER BY g.listed_at DESC, g.price_cents DESC`).all();
  const out = rows.map(r => {
    // A comp wildly out of line with the ask (ask < 20% of comp, or > 5x) is
    // almost always bad data (penny/auction-start listings, residual mis-
    // attribution) — not free money. Surface it as suspect, never as a delta.
    const ratio = r.comp_cents ? r.price_cents / r.comp_cents : null;
    const suspect = ratio != null && (ratio < 0.2 || ratio > 5);
    return {
      ...r,
      image: proxiedImage(r.card_id, r.image),
      delta_pct: ratio != null && !suspect ? +((ratio - 1) * 100).toFixed(2) : null,
      comp_suspect: suspect || undefined,
    };
  });
  // Cross-marketplace duplicates: vault tokens are portable, so the SAME
  // physical item can be live on two venues at once (52 CC×Phygitals pairs
  // found live, 2026-07-21). Kaleb: never double-list — keep only the HOST
  // listing. Phygitals labels these 'external items' (the vault lives
  // elsewhere), so its copy is the guest; ties fall back to the earliest-
  // created listing.
  const byMint = new Map();
  for (const r of out) {
    if (!r.nft_address) continue;
    const g = byMint.get(r.nft_address) ?? [];
    g.push(r);
    byMint.set(r.nft_address, g);
  }
  const drop = new Set();
  for (const group of byMint.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) =>
      // Host wins over the Phygitals mirror. phyg: provenance (not platform)
      // is the discriminator: CC-vaulted mirrors carry platform
      // 'collectorcrypt' but external_id 'phyg:…' — a CC-native sighting of
      // the same mint should still outrank them.
      (String(a.external_id ?? '').startsWith('phyg:') - String(b.external_id ?? '').startsWith('phyg:'))
      || String(a.listed_at ?? '9999').localeCompare(String(b.listed_at ?? '9999'))
    )[0];
    for (const g of group) if (g !== keep) drop.add(g);
  }
  res.json(out.filter(r => !drop.has(r)));
});

// Vintage-JP art store (seed-artofpkm-art.js downloads ONCE into data/jpart;
// we serve from our own disk — never hotlink the fan-site source). Immutable:
// files are content-stable per card.
app.use('/jpart', express.static(join(__dirname, '..', 'data', 'jpart'), {
  immutable: true, maxAge: '365d', fallthrough: true,
}));

// Production: serve the built UI from the same process (VPS mode) — /api/*
// stays API, everything else falls through to the SPA.
const dist = join(__dirname, '..', 'dist');
if (existsSync(join(dist, 'index.html'))) {
  // Vite assets are content-hashed → safe to cache forever; index.html must
  // revalidate so new deploys are picked up on plain refresh.
  app.use(express.static(dist, {
    setHeaders(res, path) {
      if (path.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  console.log('[api] serving built UI from dist/');
}

const port = process.env.PORT ?? 5174;
app.listen(port, '0.0.0.0', () => console.log(`[api] listening on :${port}`));
