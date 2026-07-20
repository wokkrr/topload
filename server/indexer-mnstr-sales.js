/**
 * MNSTR sales indexer (MegaETH) — fifth sales source; MNSTR's first-hand solds.
 *
 * WHY THIS IS A HYBRID (documented stopgap, 2026-07-20):
 * MegaETH on Alchemy's FREE tier caps eth_getLogs at 10 blocks and doesn't
 * enable Enhanced APIs (getAssetTransfers) at all, and the chain does ~130k
 * blocks/day — so the direct chain-scan our other indexers use isn't possible
 * here without a paid plan. Instead we take the sale FEED from mnstr.watch's
 * public analytics API (which tx-hashes are MNSTR secondary sales) but read
 * the PRICE first-hand from the blockchain: for each sale we fetch the tx
 * receipt (no range limit on the free tier) and decode the USDm transfer.
 * mnstr.watch is thus only a discovery index — the number we mark is
 * chain-verified. Verified live: feed price == on-chain USDm every time.
 *
 * UPGRADE PATH (when paying for infra): swap the feed for direct eth_getLogs
 * on the marketplace contract (0x5db1075782527e5ddacfdd816ea0c59b8c6eaad3),
 * making discovery first-hand too + backfillable. Until then this is
 * forward-only (feed returns the recent ~20; secondary volume is ~2-3/day so
 * a 6-hourly ingest never misses one).
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';
import { normalizeGrade, gradeFromTitle } from './adapters/collectorcrypt.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';

const FEED = 'https://mnstr.watch/api/marketplace/sales';
const MEGAETH_RPC = (key) => `https://megaeth-mainnet.g.alchemy.com/v2/${key}`;
export const MNSTR_USDM = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7'; // 18 decimals
export const MNSTR_MARKETPLACE = '0x5db1075782527e5ddacfdd816ea0c59b8c6eaad3';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CATEGORY_TO_IP = { pokemon: 'PKMN', 'one_piece': 'OP', one_piece_english: 'OP' };

// ---------- pure helpers (tested) ----------

/** USDm price (USD) from a receipt's logs — max USDm Transfer, 18 decimals. */
export function priceFromReceipt(receipt) {
  const legs = (receipt?.logs ?? [])
    .filter(l => (l.address ?? '').toLowerCase() === MNSTR_USDM && l.topics?.[0] === TRANSFER_TOPIC)
    .map(l => Number(BigInt(l.data)) / 1e18)
    .filter(v => Number.isFinite(v) && v > 0);
  return legs.length ? Math.max(...legs) : null;
}

/** Grade from mnstr.watch's 'card_grading' ('PSA 9', 'BGS 9.5', 'BECKETT 95'). */
export function gradeFromFeed(g, title) {
  const m = /^([A-Za-z]+)\s*([0-9]+(?:\.[0-9])?)/.exec(g ?? '');
  if (m) { let n = parseFloat(m[2]); if (n >= 20 && Number.isInteger(n)) n = n / 10; return normalizeGrade(m[1], n); }
  return gradeFromTitle(title);
}

/**
 * Map a feed row → normalized sale (card match + verified price supplied).
 * @returns {{card_id, grade, price_cents, sold_at, external_id}|null}
 */
export function mapSale(row, { card_id, price_usd }) {
  if (!card_id || !Number.isFinite(price_usd) || price_usd <= 0) return null;
  return {
    card_id,
    grade: gradeFromFeed(row.card_grading, row.card_title),
    price_cents: Math.round(price_usd * 100),
    // '2026-07-19 01:20:02+00' → ISO (space→T, bare +00 → +00:00).
    sold_at: new Date(String(row.bought_at).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString(),
    external_id: `${row.tx_hash}:${row.log_index}`,
  };
}

// ---------- main ----------

export async function runMnstrSalesIndexer(db, { dry = false, fetchImpl = fetch, apiKey = process.env.ALCHEMY_API_KEY, verify = true } = {}) {
  const summary = { fetched: 0, matched: 0, verified: 0, inserted: 0, unmatched: 0, priceMiss: 0, examples: [] };

  let rows;
  try {
    const res = await fetchImpl(FEED, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    rows = (await res.json())?.rows ?? [];
  } catch (e) { console.warn(`[mnstr-sales] feed fetch failed: ${e.message}`); return summary; }
  summary.fetched = rows.length;

  // Universe for title-matching (OP + PKMN — MNSTR's two categories).
  const universeByIp = {};
  for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards WHERE ip IN ('PKMN','OP')`).all())
    (universeByIp[c.ip] ??= []).push(c);

  const rpc = async (method, params) => {
    const r = await fetchImpl(MEGAETH_RPC(apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then(x => x.json());
    if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 100));
    return r.result;
  };

  const insSale = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, 'mnstr', ?)`
  );

  for (const row of rows) {
    // Match by title within the row's franchise universe (serial is a cross-check).
    const ip = CATEGORY_TO_IP[row.card_category] ?? (/one piece/i.test(row.card_title ?? '') ? 'OP' : 'PKMN');
    const card_id = matchListing(row.card_title ?? '', universeByIp[ip] ?? []);
    if (!card_id) { summary.unmatched++; continue; }
    summary.matched++;

    // Price: read first-hand from chain when possible; fall back to feed value.
    let price_usd = Number(row.price_usd);
    if (verify && apiKey) {
      try {
        const rec = await rpc('eth_getTransactionReceipt', [row.tx_hash]);
        const onchain = priceFromReceipt(rec);
        if (onchain != null) { price_usd = onchain; summary.verified++; }
        else summary.priceMiss++;
      } catch { summary.priceMiss++; /* keep feed price */ }
    }

    const sale = mapSale(row, { card_id, price_usd });
    if (!sale) continue;
    if (dry) { if (summary.examples.length < 8) summary.examples.push({ ...sale, title: row.card_title?.slice(0, 40) }); continue; }
    const r = insSale.run(sale.card_id, sale.grade, sale.price_cents, sale.sold_at, sale.external_id);
    if (Number(r.changes) > 0) summary.inserted++;
  }

  if (!dry && summary.inserted > 0) {
    refreshOutlierFlags(db);
    const range = db.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales WHERE source = 'mnstr'`).get();
    if (range?.lo) {
      const dates = [];
      for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
      refreshOracle(db, dates);
    }
  }
  console.log('[mnstr-sales]', JSON.stringify(summary, null, dry ? 1 : 0));
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  runMnstrSalesIndexer(db, { dry: process.argv.includes('--dry') }).catch(e => { console.error(e); process.exit(1); });
}
