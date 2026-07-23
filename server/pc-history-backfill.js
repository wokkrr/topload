/**
 * PC history BACKFILL walker — dedicated, deliberate, gentle. Walks PC-
 * attached cards by VALUE (the cards people actually look up first), fetches
 * each product page once, harvests the embedded 5.5-year monthly chart_data
 * into external_marks, and remembers where it left off (state key) so
 * successive runs continue down the value ladder instead of re-fetching.
 *
 * Same politeness contract as the art pass: robots-honoring, ≥1.5s delay,
 * hard --limit per run (default 500 pages ≈ 13 min). Cards that already
 * have ≥12 months of pricecharting history are skipped (already harvested —
 * passively or by a prior run).
 *
 *   node server/pc-history-backfill.js --dry --limit=20
 *   node server/pc-history-backfill.js --ip=PKMN --limit=500
 *
 * WRITER — run behind the canonical guard (filename carries no guard token;
 * launch via guard-wait wrapper with a bracketed payload path).
 * NOTE (posture): keep runs modest until PriceCharting answers the
 * historical-data email — the Legendary subscription funds the daily CSV
 * spine and is never worth risking for speed.
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';
import { pageUrl, pcNameMap } from './seed-pc-page-art.js';
import { extractChartData, storeChartHistory } from './pc-history.js';

const WWW = 'https://www.pricecharting.com';
const pcIdOf = (c) => { try { return JSON.parse(c.external_ids ?? '{}').pricecharting ?? null; } catch { return null; } };

export async function backfillHistory(db, { ips = ['PKMN', 'OP', 'YGO'], limit = 500, delayMs = 1500, dry = false, fetchImpl = timedFetch, log = console.log } = {}) {
  const robots = await (await fetchImpl(`${WWW}/robots.txt`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  if (robots.split('\n').some(l => /^disallow:\s*\/game\b/i.test(l.trim()))) {
    log('[pc-history] robots.txt disallows /game/ — refusing.'); return { refused: true };
  }
  // Names come from the daily CSVs on disk — same loader the art pass uses
  // (latestCsvs returns {text,ip,file} objects, NOT paths — the ERR_INVALID_
  // ARG_TYPE crash on first launch was reimplementing this wrongly).
  const names = pcNameMap();
  const rows = db.prepare(
    `SELECT c.id, c.external_ids, v.v value_cents,
            (SELECT COUNT(DISTINCT as_of) FROM external_marks m
              WHERE m.card_id = c.id AND m.source = 'pricecharting') history_days
     FROM cards c
     JOIN (SELECT card_id, MAX(price_cents) v FROM latest_marks GROUP BY card_id) v ON v.card_id = c.id
     WHERE c.ip IN (${ips.map(() => '?').join(',')})
     ORDER BY v.v DESC`).all(...ips);

  const res = { scanned: 0, skippedDone: 0, noPcId: 0, noCsvRow: 0, harvested: 0, points: 0, empty: 0, httpErr: 0, samples: [] };
  for (const card of rows) {
    if (res.scanned >= limit) break;
    if (card.history_days >= 12) { res.skippedDone++; continue; }   // already harvested
    const pc = pcIdOf(card);
    if (!pc) { res.noPcId++; continue; }
    const n = names.get(String(pc));
    if (!n) { res.noCsvRow++; continue; }
    res.scanned++;
    const url = pageUrl(n.console, n.product);
    if (dry) { if (res.samples.length < 15) res.samples.push(`$${Math.round((card.value_cents ?? 0) / 100)} ${card.id} → ${url}`); continue; }
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html' } });
      if (!r.ok) res.httpErr++;
      else {
        const chart = extractChartData(await r.text());
        if (!chart) res.empty++;
        else {
          const pts = storeChartHistory(db, card.id, chart);
          res.points += pts;
          if (pts) res.harvested++;
          if (res.samples.length < 10) res.samples.push(`$${Math.round((card.value_cents ?? 0) / 100)} ${card.id} ← ${pts} points`);
        }
      }
    } catch { res.httpErr++; }
    if (!dry && res.scanned >= 12 && res.harvested === 0) {
      res.aborted = 'first 12 pages yielded no chart_data — page shape changed, re-probe';
      break;
    }
    await new Promise(r2 => setTimeout(r2, delayMs));
  }
  return res;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  const ips = arg('ip', 'ALL') === 'ALL' ? ['PKMN', 'OP', 'YGO'] : [arg('ip')];
  const res = await backfillHistory(openDb(), {
    ips, limit: Number(arg('limit', 500)), dry: process.argv.includes('--dry'),
  });
  console.log(`[pc-history]${process.argv.includes('--dry') ? ' DRY' : ''}`, JSON.stringify(res, null, 1));
}
