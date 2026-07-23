/**
 * PriceCharting CSV fetch — hardened (2026-07-23 incident: the overnight
 * spine mint half-failed because timedFetch's global 30s timeout is sized
 * for API calls, not a rate-limited multi-MB CSV download. PKMN died on
 * HTTP 503 then timeout; YGO timed out three nights running; only OP fit
 * through the window).
 *
 * fetchPcCsv: long per-attempt timeout (PC_CSV_TIMEOUT_MS, default 180s),
 * retries with linear backoff (PC_CSV_ATTEMPTS, default 4), validates the
 * payload actually looks like a price-guide CSV before returning.
 *
 * CLI (the daytime retry lane): node server/import-pc-retry.js PKMN YGO
 *   → for each IP: fetch w/ retry → save data/imports/<today>-<ip>.csv →
 *     importCsv (spine rule: rows for everything, gates only guard marks) →
 *     language tags → ONE oracle refresh + index rebuild at the end.
 * Filename carries the guard token 'import-' on purpose: while this runs,
 * every guarded unit queues behind it.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { importCsv } from './import-pricecharting-csv.js';
import { refreshOracle } from './oracle.js';
import { refreshIndexes } from './indexes.js';
import { tagLanguages } from './seed-language-tags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchPcCsv(url, {
  attempts = Number(process.env.PC_CSV_ATTEMPTS ?? 4),
  timeoutMs = Number(process.env.PC_CSV_TIMEOUT_MS ?? 180_000),
  backoffMs = 30_000,
  fetchImpl = fetch,
  log = console.log,
  sleepImpl = sleep,
} = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.slice(0, 200).includes('product-name')) throw new Error('response is not a price-guide CSV (check the URL)');
      return text;
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        log(`[pc-csv] attempt ${i}/${attempts} failed (${e.message}) — backing off ${(backoffMs * i) / 1000}s`);
        await sleepImpl(backoffMs * i);
      }
    }
  }
  throw lastErr;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ips = process.argv.slice(2).filter(a => ['PKMN', 'OP', 'YGO'].includes(a));
  if (!ips.length) { console.error('Usage: node server/import-pc-retry.js <PKMN|OP|YGO> [more…]'); process.exit(1); }
  const db = openDb();
  const today = new Date().toISOString().slice(0, 10);
  let any = false;
  for (const ip of ips) {
    const url = process.env[`PC_CSV_URL_${ip}`];
    if (!url) { console.warn(`[import-pc-retry] no PC_CSV_URL_${ip} in env — skipping`); continue; }
    try {
      const text = await fetchPcCsv(url);
      mkdirSync(join(__dirname, '..', 'data', 'imports'), { recursive: true });
      writeFileSync(join(__dirname, '..', 'data', 'imports', `${today}-${ip}.csv`), text);
      const r = importCsv(db, {
        text, ip, asOf: today,
        minVolume: Number(process.env.PC_MIN_VOLUME ?? 10),
        minPriceCents: Number(process.env.PC_MIN_PRICE_CENTS ?? 200),
      });
      console.log(`[import-pc-retry] ${ip}: ${JSON.stringify(r)}`);
      any = true;
    } catch (e) {
      console.warn(`[import-pc-retry] ${ip} FAILED after retries: ${e.message}`);
    }
    if (ip !== ips[ips.length - 1]) await sleep(15_000);   // duck the rate limiter between franchises
  }
  if (any) {
    console.log('[import-pc-retry] language tags:', JSON.stringify(tagLanguages(db)));
    console.log('[import-pc-retry] recomputing oracle + indexes…');
    console.log('[import-pc-retry]', JSON.stringify({ ...refreshOracle(db, [today]), ...refreshIndexes(db) }));
  }
}
