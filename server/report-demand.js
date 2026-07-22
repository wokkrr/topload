/**
 * On-chain demand snapshot (read-only) — Kaleb, 2026-07-22: "curious what it
 * would tell us." How much TCG demand actually exists on the gacha
 * marketplaces right now, measured from OUR first-hand recorded sales and
 * live listings. Re-run monthly; compare against prior output for trend.
 *
 *   node server/report-demand.js            (30-day window)
 *   node server/report-demand.js --days=90
 */
import { openDb } from './db.js';

const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 30);
const db = openDb();
const since = db.prepare(`SELECT date('now', ?) d`).get(`-${days} day`).d;
const $ = (c) => c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

console.log(`\n== ON-CHAIN DEMAND SNAPSHOT · last ${days}d (since ${since}) · generated ${db.prepare(`SELECT date('now') d`).get().d} ==\n`);

// Per-platform: recorded sales vs live inventory.
const platforms = db.prepare(`
  SELECT s.source AS platform,
         COUNT(*) AS sales, SUM(s.price_cents) AS vol_cents,
         CAST(AVG(s.price_cents) AS INT) AS avg_cents
  FROM sales s
  WHERE s.sold_at >= ? AND s.is_outlier = 0 AND s.source NOT IN ('pricecharting', 'demo')
  GROUP BY s.source ORDER BY vol_cents DESC`).all(since);

const inv = Object.fromEntries(db.prepare(`
  SELECT platform, COUNT(*) n, SUM(price_cents) ask_cents,
         CAST(AVG(JULIANDAY('now') - JULIANDAY(COALESCE(listed_at, seen_at))) AS INT) AS med_age_days
  FROM gacha_listings GROUP BY platform`).all().map(r => [r.platform, r]));

console.log('PLATFORM         SALES   $VOLUME    AVG SALE   LISTINGS   $ASKING     SELL-THRU  INV AGE');
for (const p of platforms) {
  const i = inv[p.platform] ?? { n: 0, ask_cents: null, med_age_days: null };
  const st = i.n ? `${((p.sales / i.n) * 100).toFixed(1)}%` : '—';
  console.log(
    p.platform.padEnd(16) + String(p.sales).padStart(5) + '  ' + $(p.vol_cents).padStart(9) + '  ' +
    $(p.avg_cents).padStart(9) + '  ' + String(i.n).padStart(8) + '  ' + $(i.ask_cents).padStart(9) + '  ' +
    st.padStart(9) + '  ' + (i.med_age_days != null ? `${i.med_age_days}d avg` : '—').padStart(8));
}
// Listings-only platforms (no sales in window) still deserve a row.
for (const [plat, i] of Object.entries(inv)) {
  if (!platforms.some(p => p.platform === plat)) {
    console.log(plat.padEnd(16) + '    0  ' + '$0'.padStart(9) + '  ' + '—'.padStart(9) + '  ' +
      String(i.n).padStart(8) + '  ' + $(i.ask_cents).padStart(9) + '  ' + '0.0%'.padStart(9) + '  ' +
      (i.med_age_days != null ? `${i.med_age_days}d avg` : '—').padStart(8));
  }
}

// Franchise split of the same window.
const byIp = db.prepare(`
  SELECT COALESCE(c.ip, '?') ip, COUNT(*) sales, SUM(s.price_cents) vol_cents
  FROM sales s JOIN cards c ON c.id = s.card_id
  WHERE s.sold_at >= ? AND s.is_outlier = 0 AND s.source NOT IN ('pricecharting', 'demo')
  GROUP BY c.ip ORDER BY vol_cents DESC`).all(since);
console.log('\nFRANCHISE        SALES   $VOLUME');
for (const r of byIp) console.log(r.ip.padEnd(16) + String(r.sales).padStart(5) + '  ' + $(r.vol_cents).padStart(9));

// Price-band split: where does demand actually clear?
const bands = db.prepare(`
  SELECT CASE WHEN price_cents < 5000 THEN 'a. under $50'
              WHEN price_cents < 20000 THEN 'b. $50-200'
              WHEN price_cents < 100000 THEN 'c. $200-1k'
              WHEN price_cents < 500000 THEN 'd. $1k-5k'
              ELSE 'e. $5k+' END band,
         COUNT(*) sales, SUM(price_cents) vol_cents
  FROM sales WHERE sold_at >= ? AND is_outlier = 0 AND source NOT IN ('pricecharting', 'demo')
  GROUP BY band ORDER BY band`).all(since);
console.log('\nPRICE BAND       SALES   $VOLUME');
for (const r of bands) console.log(r.band.slice(3).padEnd(16) + String(r.sales).padStart(5) + '  ' + $(r.vol_cents).padStart(9));

// Daily run-rate + the headline.
const tot = platforms.reduce((a, p) => ({ s: a.s + p.sales, v: a.v + (p.vol_cents ?? 0) }), { s: 0, v: 0 });
const listTot = Object.values(inv).reduce((a, i) => ({ n: a.n + i.n, v: a.v + (i.ask_cents ?? 0) }), { n: 0, v: 0 });
console.log(`\nTOTALS: ${tot.s} sales · ${$(tot.v)} in ${days}d  →  ~${(tot.s / days).toFixed(1)} sales/day · ${$(Math.round(tot.v / days))}/day run-rate`);
console.log(`INVENTORY: ${listTot.n.toLocaleString()} live listings asking ${$(listTot.v)} → window sell-through ${listTot.n ? ((tot.s / listTot.n) * 100).toFixed(1) : '—'}%`);
console.log(`ANNUALIZED RUN-RATE: ~${$(Math.round((tot.v / days) * 365))} GMV/yr across the tracked gacha marketplaces.`);
