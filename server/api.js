/**
 * Read API for the terminal UI. Run: `npm run api` (default port 5174).
 * Vite dev server proxies /api → here (see vite.config.js).
 */
import express from 'express';
import { openDb } from './db.js';

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

/** GET /api/cards/:id/series?grade=PSA10&days=90 → oracle mark history */
app.get('/api/cards/:id/series', (req, res) => {
  const grade = req.query.grade ?? 'raw';
  const days = Math.min(365, parseInt(req.query.days ?? '90', 10));
  const rows = db.prepare(`
    SELECT as_of, price_cents, confidence, sales_7d FROM oracle_prices
    WHERE card_id = ? AND grade = ?
      AND as_of >= date((SELECT MAX(as_of) FROM oracle_prices), ?)
    ORDER BY as_of`).all(req.params.id, grade, `-${days} day`);
  res.json(rows);
});

const port = process.env.PORT ?? 5174;
app.listen(port, () => console.log(`[api] listening on :${port}`));
