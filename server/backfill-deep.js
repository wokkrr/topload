/**
 * Deep-history campaign (the index-history race vs Card Ladder, 2026-07-21).
 *
 * Each on-chain sales indexer is cursor-based and resumable — this runs them
 * in round-robin passes, walking every marketplace's history further backward
 * each pass, until the time budget expires. Then it extends the oracle marks
 * and rebuilds the indexes over the full recovered range, so every recovered
 * month of REAL sales becomes index history Card Ladder can't match (they
 * estimate from eBay; we recorded the actual fills).
 *
 *   BACKFILL_HOURS=8 npm run backfill:deep     (default 6h)
 *
 * Run overnight on the upgraded droplet via nohup, guarded like any writer.
 * Fully rerunnable: cursors persist, exhausted chains no-op cheaply, and the
 * oracle/index rebuild is idempotent. Nightly reruns keep digging until every
 * chain's history is fully recovered.
 */
import { openDb } from './db.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';

const DAY_MS = 86_400_000;
const HOURS = Number(process.env.BACKFILL_HOURS ?? 6);
const deadline = Date.now() + HOURS * 3_600_000;
const db = openDb();

const jobs = [
  ['collectorcrypt', async () => (await import('./indexer-solana.js')).runSolanaIndexer(db, { backfill: true, maxPages: 40 })],
  ['phygitals', async () => (await import('./indexer-phygitals.js')).runPhygitalsIndexer(db, { backfill: true, maxPages: 40 })],
  ['courtyard', async () => (await import('./indexer-courtyard.js')).runCourtyardIndexer(db, { backfill: true, maxWindows: 12 })],
  ['beezie', async () => (await import('./indexer-base.js')).runBaseIndexer(db, { backfill: true, maxWindows: 12 })],
];

let pass = 0;
const failed = new Set();
while (Date.now() < deadline && failed.size < jobs.length) {
  pass++;
  let insertedThisPass = 0;
  for (const [name, run] of jobs) {
    if (failed.has(name) || Date.now() >= deadline) continue;
    try {
      const r = await run();
      insertedThisPass += r?.inserted ?? 0;
      console.log(`[deep] pass ${pass} ${name}: ${JSON.stringify(r)}`);
    } catch (e) {
      console.warn(`[deep] ${name} errored (skipping for this run): ${e.message}`);
      failed.add(name);
    }
  }
  // Two consecutive all-quiet passes would mean every chain is exhausted, but
  // a single 0-insert pass can just be a stretch of non-sale txs — keep
  // walking; cursors make wasted passes cheap.
  if (insertedThisPass === 0 && pass > 4) { console.log('[deep] chains look exhausted — stopping early'); break; }
}

console.log('[deep] walking done — extending oracle + indexes over the recovered range…');
console.log('[deep] outliers:', JSON.stringify(refreshOutlierFlags(db)));
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
console.log(`[deep] oracle over ${dates.length} dates (${range?.lo} → ${range?.hi})…`);
console.log('[deep] oracle:', JSON.stringify(refreshOracle(db, dates)));
console.log('[deep] indexes:', JSON.stringify(refreshIndexes(db)));
console.log('[deep] campaign run complete.');
