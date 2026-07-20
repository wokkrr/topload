/**
 * Standalone oracle refresh — recompute outlier flags, oracle prices,
 * latest_marks, and indexes from data ALREADY in the database. Pure local
 * compute, zero network.
 *
 *   npm run oracle:refresh
 *
 * Why it exists: comps appearing on cards must never be hostage to a flaky
 * marketplace network step. Live 2026-07-20: the ingest's MNSTR sales block
 * crawled through serial RPC timeouts for an hour+ with the oracle refresh
 * queued BEHIND it — while the price marks it needed were already committed.
 * Same date-range logic as ingest's final step.
 */
import { openDb } from './db.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const DAY_MS = 86_400_000;
const db = openDb();

console.log('[oracle:refresh] outlier flags…');
const outliers = refreshOutlierFlags(db);

const range = db.prepare(`
  SELECT MIN(d) lo, MAX(d) hi FROM (
    SELECT date(sold_at) d FROM sales
    UNION ALL SELECT as_of d FROM external_marks
  )`).get();
const dates = [];
if (range?.lo) {
  for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
}
console.log(`[oracle:refresh] recomputing ${dates.length} dates (${range?.lo} → ${range?.hi})…`);
const oracle = refreshOracle(db, dates);
const indexes = refreshIndexes(db);
console.log('[oracle:refresh]', JSON.stringify({ ...outliers, ...oracle, ...indexes }));
