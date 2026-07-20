/**
 * Read API for the terminal UI. Run: `npm run api` (default port 5174).
 * Vite dev server proxies /api → here (see vite.config.js).
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { PLATFORMS } from './platforms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = openDb();
const app = express();

/** GET /api/indexes?days=90 → [{index_id, series:[{as_of, value}]}] */
app.get('/api/indexes', (req, res) => {
  const days = Math.min(365, parseInt(req.query.days ?? '90', 10));
  const rows = db.prepare(`
    SELECT index_id, as_of, value FROM index_values
    WHERE as_of >= date((SELECT MAX(as_of) FROM index_values), ?)
    ORDER BY index_id, as_of`).all(`-${days} day`);
  const byIndex = {};
  for (const r of rows) (byIndex[r.index_id] ??= []).push({ as_of: r.as_of, value: r.value });
  // Re-normalize each window to 100 at window start for comparability.
  res.json(Object.entries(byIndex).map(([index_id, series]) => {
    const base = series[0]?.value ?? 100;
    return { index_id, series: series.map(p => ({ ...p, value: +(100 * p.value / base).toFixed(2) })) };
  }));
});

/** GET /api/movers?window=1 → biggest 1D oracle moves with confidence */
app.get('/api/movers', (req, res) => {
  const win = parseInt(req.query.window ?? '1', 10);
  const rows = db.prepare(`
    WITH latest AS (SELECT MAX(as_of) d FROM oracle_prices)
    SELECT c.ip, c.name, c.set_name, o1.card_id, o1.grade,
           o1.price_cents AS price_now, o0.price_cents AS price_then,
           o1.confidence, o1.sales_7d
    FROM oracle_prices o1
    JOIN latest ON o1.as_of = latest.d
    JOIN oracle_prices o0 ON o0.card_id = o1.card_id AND o0.grade = o1.grade
         AND o0.as_of = date(latest.d, ?)
    JOIN cards c ON c.id = o1.card_id
    WHERE o1.confidence >= 0.3`).all(`-${win} day`);
  const movers = rows
    .map(r => ({ ...r, change_pct: +((r.price_now / r.price_then - 1) * 100).toFixed(2) }))
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 20);
  res.json(movers);
});

/** GET /api/basket?index=PKMN → current membership w/ marks */
app.get('/api/basket', (req, res) => {
  const indexId = req.query.index ?? 'PKMN';
  const rows = db.prepare(`
    WITH cur AS (SELECT MAX(as_of) d FROM basket_members WHERE index_id = ?),
         latest AS (SELECT MAX(as_of) d FROM oracle_prices)
    SELECT bm.card_id, bm.grade, bm.weight, c.name, c.set_name, c.number,
           o.price_cents, o.confidence, o.sales_7d, o.sales_30d,
           o1.price_cents AS price_1d, o30.price_cents AS price_30d
    FROM basket_members bm
    JOIN cur ON bm.as_of = cur.d
    JOIN cards c ON c.id = bm.card_id
    JOIN latest
    LEFT JOIN oracle_prices o   ON o.card_id = bm.card_id AND o.grade = bm.grade AND o.as_of = latest.d
    LEFT JOIN oracle_prices o1  ON o1.card_id = bm.card_id AND o1.grade = bm.grade AND o1.as_of = date(latest.d, '-1 day')
    LEFT JOIN oracle_prices o30 ON o30.card_id = bm.card_id AND o30.grade = bm.grade AND o30.as_of = date(latest.d, '-30 day')
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
  if (req.query.grade) { clauses.push(`o.grade = ?`); args.push(req.query.grade); }
  if (req.query.q) {
    // Every word must appear somewhere in name/set/number.
    for (const word of String(req.query.q).trim().split(/\s+/).slice(0, 6)) {
      clauses.push(`(c.name LIKE ? OR c.set_name LIKE ? OR c.number LIKE ?)`);
      const w = `%${word}%`;
      args.push(w, w, w);
    }
  }
  const ipFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const sort = {
    price: 'o.price_cents DESC',
    change: 'ABS(COALESCE((o.price_cents * 1.0 / NULLIF(o1.price_cents, 0) - 1), 0)) DESC',
    volume: 'o.sales_7d DESC, o.price_cents DESC',
  }[req.query.sort] ?? 'o.price_cents DESC';
  const rows = db.prepare(`
    WITH latest AS (
      SELECT card_id, grade, MAX(as_of) d FROM oracle_prices GROUP BY card_id, grade
    )
    SELECT c.ip, c.id AS card_id, c.name, c.set_name, c.number,
           COALESCE(c.image, (SELECT g.image FROM gacha_listings g WHERE g.card_id = c.id AND g.image IS NOT NULL LIMIT 1)) AS image,
           CASE WHEN c.image IS NOT NULL THEN 'official'
                WHEN EXISTS (SELECT 1 FROM gacha_listings g WHERE g.card_id = c.id AND g.image IS NOT NULL) THEN 'listing' END AS image_kind,
           o.grade, o.price_cents, o.confidence, o.basis, o.source, o.sales_7d,
           o1.price_cents AS price_1d, o30.price_cents AS price_30d
    FROM latest
    JOIN oracle_prices o ON o.card_id = latest.card_id AND o.grade = latest.grade AND o.as_of = latest.d
    JOIN cards c ON c.id = o.card_id
    LEFT JOIN oracle_prices o1 ON o1.card_id = o.card_id AND o1.grade = o.grade AND o1.as_of = date(latest.d, '-1 day')
    LEFT JOIN oracle_prices o30 ON o30.card_id = o.card_id AND o30.grade = o.grade AND o30.as_of = date(latest.d, '-30 day')
    WHERE 1=1 ${ipFilter}
    ORDER BY ${sort} LIMIT ${limit}`).all(...args);
  res.json(rows.map(r => ({
    ...r,
    change_1d_pct: r.price_1d ? +((r.price_cents / r.price_1d - 1) * 100).toFixed(2) : null,
    change_30d_pct: r.price_30d ? +((r.price_cents / r.price_30d - 1) * 100).toFixed(2) : null,
  })));
});

/** GET /api/cards/:id → card meta + latest mark per grade (with provenance) */
app.get('/api/cards/:id', (req, res) => {
  const card = db.prepare(`
    SELECT id, ip, name, set_name, number, variant,
           COALESCE(image, (SELECT g.image FROM gacha_listings g WHERE g.card_id = cards.id AND g.image IS NOT NULL LIMIT 1)) AS image,
           CASE WHEN image IS NOT NULL THEN 'official'
                WHEN EXISTS (SELECT 1 FROM gacha_listings g WHERE g.card_id = cards.id AND g.image IS NOT NULL) THEN 'listing' END AS image_kind
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
  res.json({
    ...card,
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
    WITH latest AS (SELECT MAX(as_of) d FROM oracle_prices)
    SELECT g.platform, g.external_id, g.card_id, g.item_name, g.category, g.grade,
           g.price_cents, g.currency, g.listed_at, g.nft_address, g.image_back, g.proof,
           COALESCE(g.image, c.image) AS image,
           CASE WHEN g.image IS NOT NULL THEN 'actual' WHEN c.image IS NOT NULL THEN 'art' END AS image_kind,
           c.name AS card_name, c.ip,
           o.price_cents AS comp_cents, o.confidence AS comp_confidence, o.basis AS comp_basis, o.source AS comp_source
    FROM gacha_listings g
    LEFT JOIN cards c ON c.id = g.card_id
    LEFT JOIN latest
    LEFT JOIN oracle_prices o ON o.card_id = g.card_id AND o.grade = g.grade AND o.as_of = latest.d
    ORDER BY g.listed_at DESC, g.price_cents DESC`).all();
  res.json(rows.map(r => {
    // A comp wildly out of line with the ask (ask < 20% of comp, or > 5x) is
    // almost always bad data (penny/auction-start listings, residual mis-
    // attribution) — not free money. Surface it as suspect, never as a delta.
    const ratio = r.comp_cents ? r.price_cents / r.comp_cents : null;
    const suspect = ratio != null && (ratio < 0.2 || ratio > 5);
    return {
      ...r,
      delta_pct: ratio != null && !suspect ? +((ratio - 1) * 100).toFixed(2) : null,
      comp_suspect: suspect || undefined,
    };
  }));
});

// Production: serve the built UI from the same process (VPS mode) — /api/*
// stays API, everything else falls through to the SPA.
const dist = join(__dirname, '..', 'dist');
if (existsSync(join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  console.log('[api] serving built UI from dist/');
}

const port = process.env.PORT ?? 5174;
app.listen(port, '0.0.0.0', () => console.log(`[api] listening on :${port}`));
