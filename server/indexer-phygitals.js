/**
 * Phygitals sales indexer (Solana) — third on-chain platform.
 *
 * Discovery (2026-07-19, live samples): Phygitals has NO marketplace program.
 * A sale = one tx composing a USDC transfer (buyer→seller, full price) with an
 * MPL Core transfer of the asset. The collection account phygZ… appears in
 * every Core instruction touching their assets → querying the COLLECTION's
 * parsed history sees the whole platform. Core instruction accounts:
 * [0]=asset, [1]=collection, [2]=platform authority, [3]=seller, [4]=buyer.
 * SOL-denominated deals exist (system-program txs) — counted, not priced
 * (needs a SOL/USD feed; v2). Assets carry structured attributes incl. Title,
 * Grade, Grader, Category → same strict attribution as everywhere else.
 *
 * Modes: npm run phyg:dry | phyg:backfill; incremental rides ingest.
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';

export const PHYGITALS_COLLECTION = 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC';
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'Pokémon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO', 'Yu-Gi-Oh!': 'YGO' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- pure decode (tested against live samples) ----------

/** @returns sale | {solPaid:true} | null */
export function decodePhygSale(tx) {
  const core = (tx.instructions ?? []).find(i =>
    i.programId === CORE_PROGRAM && (i.accounts ?? []).includes(PHYGITALS_COLLECTION));
  const asset = core?.accounts?.[0];
  if (!asset || asset === PHYGITALS_COLLECTION) return null;

  const usdcMoves = (tx.tokenTransfers ?? []).filter(t => t.mint === USDC && Number(t.tokenAmount) > 0);
  if (!usdcMoves.length) {
    const bigSol = (tx.nativeTransfers ?? []).some(n => n.amount > 5e7); // > 0.05 SOL ≈ not rent dust
    return bigSol ? { solPaid: true } : null; // plain transfers/claims → not sales
  }
  const outflows = {};
  for (const u of usdcMoves) outflows[u.fromUserAccount] = (outflows[u.fromUserAccount] ?? 0) + Number(u.tokenAmount);
  const buyer = Object.entries(outflows).sort((a, b) => b[1] - a[1])[0];
  const seller = usdcMoves.sort((a, b) => b.tokenAmount - a.tokenAmount)[0]?.toUserAccount ?? null;
  if (!buyer || buyer[1] <= 0) return null;

  return {
    signature: tx.signature,
    sold_at: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
    mint: asset,
    buyer: buyer[0],
    seller,
    price_cents: Math.round(buyer[1] * 100),
  };
}

// ---------- helius plumbing (mirrors indexer-solana; kept local for clarity) ----------

function makeHelius({ apiKey = process.env.HELIUS_API_KEY, fetchImpl = fetch, throttleMs = 250 } = {}) {
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');
  let last = 0;
  const throttled = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      const w = last + throttleMs - Date.now();
      if (w > 0) await sleep(w);
      last = Date.now();
      try { return await fn(); } catch (e) {
        // 429 = rate limit — back off and retry a few times before giving up.
        if (String(e.message).includes('429') && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
        throw e;
      }
    }
  };
  return {
    async parsedTxs(address, { before, limit = 100 } = {}) {
      return throttled(async () => {
        const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
        url.searchParams.set('api-key', apiKey);
        url.searchParams.set('limit', String(limit));
        if (before) url.searchParams.set('before', before);
        const res = await fetchImpl(url);
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`helius parsedTxs → ${res.status}`);
        return res.json();
      });
    },
    async getAsset(mint) {
      return throttled(async () => {
        const res = await fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
        });
        if (!res.ok) throw new Error(`helius getAsset → ${res.status}`);
        return (await res.json()).result ?? null;
      });
    },
  };
}

// ---------- main ----------

export async function runPhygitalsIndexer(db, { dry = false, backfill = false, maxPages = Number(process.env.HELIUS_MAX_PAGES ?? 10), helius = null } = {}) {
  const { gradeFromTitle } = await import('./adapters/collectorcrypt.js');
  const h = helius ?? makeHelius();
  const universeByIp = {};
  for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) (universeByIp[c.ip] ??= []).push(c);
  const getState = (k) => db.prepare(`SELECT value FROM indexer_state WHERE key = ?`).get(k)?.value ?? null;
  const setState = (k, v) => db.prepare(`INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  const insSale = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, 'phygitals', ?)`
  );
  const upReg = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, category, grade, first_seen, last_seen)
     VALUES (?, 'phygitals', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET card_id = COALESCE(nft_registry.card_id, excluded.card_id), last_seen = excluded.last_seen`
  );

  const newestSeen = getState('phyg_newest_sig');
  const summary = { pages: 0, txs: 0, sales: 0, solPaid: 0, attributed: 0, inserted: 0, unattributed: 0, dryExamples: [] };
  let before = backfill ? (getState('phyg_backfill_before') ?? undefined) : undefined;
  let newestThisRun = null;
  let reachedKnown = false;

  for (let page = 0; page < maxPages && !reachedKnown; page++) {
    let txs;
    try { txs = await h.parsedTxs(PHYGITALS_COLLECTION, { before }); }
    catch (e) { console.warn(`[phyg] page fetch failed: ${e.message}`); break; }
    if (!txs.length) { if (backfill) setState('phyg_backfill_done', '1'); break; }
    summary.pages++;
    summary.txs += txs.length;
    newestThisRun ??= txs[0]?.signature;

    for (const tx of txs) {
      if (!backfill && newestSeen && tx.signature === newestSeen) { reachedKnown = true; break; }
      const sale = decodePhygSale(tx);
      if (!sale) continue;
      if (sale.solPaid) { summary.solPaid++; continue; }
      summary.sales++;

      let reg = db.prepare(`SELECT card_id, grade, item_name FROM nft_registry WHERE mint = ?`).get(sale.mint);
      if (!reg) {
        let name = '', category = null, grade = 'raw';
        try {
          const a = await h.getAsset(sale.mint);
          const attrs = Object.fromEntries((a?.content?.metadata?.attributes ?? []).map(x => [String(x.trait_type ?? '').toLowerCase(), String(x.value ?? '')]));
          name = attrs.title ?? a?.content?.metadata?.name ?? '';
          category = attrs.category ?? null;
          grade = attrs.grader && attrs.grade ? gradeFromTitle(`${attrs.grader} ${attrs.grade}`) : gradeFromTitle(name);
        } catch { /* unattributed */ }
        const ip = CATEGORY_TO_IP[category];
        const card_id = ip && name ? matchListing(name, universeByIp[ip] ?? []) : null;
        const today = new Date().toISOString().slice(0, 10);
        upReg.run(sale.mint, card_id, name, category, grade, today, today);
        reg = { card_id, grade, item_name: name };
      }

      if (dry) {
        if (summary.dryExamples.length < 8) {
          summary.dryExamples.push({
            signature: sale.signature?.slice(0, 20), at: sale.sold_at, price_cents: sale.price_cents,
            item: reg.item_name?.slice(0, 60), grade: reg.grade, matched: reg.card_id ?? null,
          });
        }
        continue;
      }
      if (!reg.card_id) { summary.unattributed++; continue; }
      summary.attributed++;
      const r = insSale.run(reg.card_id, reg.grade ?? 'raw', sale.price_cents, sale.sold_at, sale.signature);
      if (Number(r.changes) > 0) summary.inserted++;
    }
    before = txs.at(-1)?.signature;
  }

  if (!dry) {
    if (backfill && before) setState('phyg_backfill_before', before);
    if (!backfill && newestThisRun) setState('phyg_newest_sig', newestThisRun);
    if (summary.inserted > 0) {
      refreshOutlierFlags(db);
      const range = db.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales WHERE source = 'phygitals'`).get();
      if (range?.lo) {
        const dates = [];
        for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
        refreshOracle(db, dates);
      }
    }
  }
  console.log('[phyg]', JSON.stringify(summary, null, dry ? 1 : 0));
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  runPhygitalsIndexer(db, {
    dry: process.argv.includes('--dry'),
    backfill: process.argv.includes('--backfill'),
  }).catch(e => { console.error(e); process.exit(1); });
}
