/**
 * Courtyard sales indexer (Polygon) — fourth on-chain platform, largest by
 * dollar volume ($99M lifetime, ~$400K/day at discovery).
 *
 * Decoding rules (verified against live receipts, 2026-07-19):
 *  - SECONDARY SALE (indexed): buyer pays USDC to marketplace escrow
 *    0x5e49…, escrow forwards the identical amount to the seller; exactly one
 *    ERC-721 moves seller→buyer. Price = buyer's outflow.
 *  - PRIMARY MINT (excluded): token minted from 0x0 with payment to treasury —
 *    pack rips / vault buys; a pull price is not a card comp.
 *  - Token IDs are 2^256-scale — ALWAYS hex strings, never parsed to Number
 *    (the probe's parseInt produced 6.37e+76 garbage and broke metadata).
 *
 * Modes: npm run yard:dry | yard:backfill; incremental rides ingest.
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';
import { matchListing } from './match.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';

export const COURTYARD_CONTRACT = '0x251be3a17af4892035c37ebf5890f4a4d889dcad';
const NETWORK = 'polygon-mainnet';
const STABLES = new Set([
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC (native)
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e (bridged)
]);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const BACKFILL_WINDOW = 15_000; // Polygon ~2s blocks ≈ 8h per window — busiest contract, keep runs short
const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'Pokémon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO', 'Yu-Gi-Oh!': 'YGO', 'Magic: The Gathering': null };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- pure decode (tested) ----------

/**
 * @param {{transfers: {tokenId:string, from:string, to:string}[],
 *          usdcFlows: {from:string, to:string, usd:number}[]}} tx
 */
export function decodeYardSale(tx) {
  const moves = tx.transfers ?? [];
  if (moves.length !== 1) return moves.length > 1 ? { batch: moves.length } : null;
  const m = moves[0];
  if ((m.from ?? '').toLowerCase() === ZERO) return { mint: true }; // primary — excluded
  const flows = (tx.usdcFlows ?? []).filter(f => f.usd > 0);
  if (!flows.length) return null; // plain transfer/vault move

  // Buyer = NFT recipient; price = their total outflow (escrow pass-through
  // means the same amount appears twice — outflow from the buyer is the truth).
  const buyer = (m.to ?? '').toLowerCase();
  const outflows = {};
  for (const f of flows) outflows[(f.from ?? '').toLowerCase()] = (outflows[(f.from ?? '').toLowerCase()] ?? 0) + f.usd;
  const price = outflows[buyer] ?? Math.max(...Object.values(outflows));
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    tokenId: String(m.tokenId), // hex string, opaque
    seller: m.from,
    buyer: m.to,
    price_cents: Math.round(price * 100),
  };
}

// ---------- alchemy client (polygon) ----------

function makeAlchemy({ apiKey = process.env.ALCHEMY_API_KEY, fetchImpl = timedFetch, throttleMs = 300 } = {}) {
  if (!apiKey) throw new Error('ALCHEMY_API_KEY not set');
  const RPC = `https://${NETWORK}.g.alchemy.com/v2/${apiKey}`;
  const NFT = `https://${NETWORK}.g.alchemy.com/nft/v3/${apiKey}`;
  let last = 0;
  const throttle = async () => { const w = last + throttleMs - Date.now(); if (w > 0) await sleep(w); last = Date.now(); };
  return {
    async rpc(method, params) {
      for (let attempt = 0; ; attempt++) {
        await throttle();
        try {
          const res = await fetchImpl(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
          if (res.status === 429) throw new Error('429');
          if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
          const json = await res.json();
          if (json.error) throw new Error(`${method} → ${JSON.stringify(json.error).slice(0, 160)}`);
          return json.result;
        } catch (e) {
          if (String(e.message).includes('429') && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
          throw e;
        }
      }
    },
    async metadata(tokenIdHex) {
      await throttle();
      const res = await fetchImpl(`${NFT}/getNFTMetadata?contractAddress=${COURTYARD_CONTRACT}&tokenId=${tokenIdHex}`);
      if (!res.ok) return null;
      const json = await res.json();
      return { name: json.name ?? json.raw?.metadata?.name ?? null, attributes: json.raw?.metadata?.attributes ?? [] };
    },
  };
}

// ---------- main ----------

export async function runCourtyardIndexer(db, { dry = false, backfill = false, maxWindows = Number(process.env.ALCHEMY_MAX_WINDOWS ?? 2), alchemy = null } = {}) {
  const { gradeFromTitle } = await import('./adapters/collectorcrypt.js');
  const a = alchemy ?? makeAlchemy();
  const universeByIp = {};
  for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) (universeByIp[c.ip] ??= []).push(c);
  const getState = (k) => db.prepare(`SELECT value FROM indexer_state WHERE key = ?`).get(k)?.value ?? null;
  const setState = (k, v) => db.prepare(`INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v));
  const insSale = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, 'courtyard', ?)`
  );
  const upReg = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, category, grade, first_seen, last_seen)
     VALUES (?, 'courtyard', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET card_id = COALESCE(nft_registry.card_id, excluded.card_id), last_seen = excluded.last_seen`
  );

  const head = parseInt(await a.rpc('eth_blockNumber', []), 16);
  const summary = { windows: 0, txs: 0, sales: 0, mints: 0, batches: 0, moves: 0, attributed: 0, inserted: 0, unattributed: 0, dryExamples: [] };

  let lo, hi;
  if (backfill) {
    const before = parseInt(getState('yard_backfill_before') ?? String(head), 10);
    lo = Math.max(0, before - BACKFILL_WINDOW * maxWindows);
    hi = before;
  } else {
    lo = parseInt(getState('yard_newest_block') ?? String(head - BACKFILL_WINDOW), 10) + 1;
    hi = head;
  }
  if (lo >= hi) { console.log('[yard] nothing new'); return summary; }
  summary.windows = Math.ceil((hi - lo) / BACKFILL_WINDOW);

  // 1. ERC-721 transfers in range — tokenId kept RAW (hex string).
  const byHash = new Map();
  const timeByHash = new Map();
  let pageKey;
  do {
    const r = await a.rpc('alchemy_getAssetTransfers', [{
      fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16),
      contractAddresses: [COURTYARD_CONTRACT], category: ['erc721'],
      order: 'asc', maxCount: '0x3e8', withMetadata: true, ...(pageKey ? { pageKey } : {}),
    }]);
    for (const t of r.transfers ?? []) {
      const tokenId = t.erc721TokenId ?? t.tokenId; // RAW hex — never Number()
      (byHash.get(t.hash) ?? byHash.set(t.hash, []).get(t.hash)).push({ tokenId, from: t.from, to: t.to });
      timeByHash.set(t.hash, t.metadata?.blockTimestamp);
    }
    pageKey = r.pageKey;
  } while (pageKey);
  summary.txs = byHash.size;

  // 2. Receipts → USDC flows → decode.
  for (const [hash, transfers] of byHash) {
    let usdcFlows = [];
    try {
      const rec = await a.rpc('eth_getTransactionReceipt', [hash]);
      usdcFlows = (rec?.logs ?? [])
        .filter(l => STABLES.has(l.address?.toLowerCase()) && l.topics?.[0] === TRANSFER_TOPIC)
        .map(l => ({ from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), usd: parseInt(l.data, 16) / 1e6 }));
    } catch { continue; }

    const sale = decodeYardSale({ transfers, usdcFlows });
    if (!sale) { summary.moves++; continue; }
    if (sale.mint) { summary.mints++; continue; }
    if (sale.batch) { summary.batches++; continue; }
    summary.sales++;

    const mintKey = `courtyard:${sale.tokenId}`;
    let reg = db.prepare(`SELECT card_id, grade, item_name FROM nft_registry WHERE mint = ?`).get(mintKey);
    if (!reg) {
      const meta = await a.metadata(sale.tokenId);
      const attrs = Object.fromEntries((meta?.attributes ?? []).map(x => [String(x.trait_type ?? '').toLowerCase(), String(x.value ?? '')]));
      const name = meta?.name ?? '';
      const category = attrs.category ?? attrs.game ?? (/pokemon|pokémon/i.test(name) ? 'Pokemon' : null);
      const grade = attrs.grader && attrs.grade ? gradeFromTitle(`${attrs.grader} ${attrs.grade}`) : gradeFromTitle(name);
      const ip = CATEGORY_TO_IP[category];
      const card_id = ip && name ? matchListing(name, universeByIp[ip] ?? []) : null;
      const today = new Date().toISOString().slice(0, 10);
      upReg.run(mintKey, card_id, name, category, grade, today, today);
      reg = { card_id, grade, item_name: name };
    }

    if (dry) {
      if (summary.dryExamples.length < 8) {
        summary.dryExamples.push({
          hash: hash.slice(0, 14), at: timeByHash.get(hash), price_cents: sale.price_cents,
          item: reg.item_name?.slice(0, 60), grade: reg.grade, matched: reg.card_id ?? null,
        });
      }
      continue;
    }
    if (!reg.card_id) { summary.unattributed++; continue; }
    summary.attributed++;
    const r = insSale.run(reg.card_id, reg.grade ?? 'raw', sale.price_cents, timeByHash.get(hash) ?? null, `${hash}:${sale.tokenId.slice(0, 18)}`);
    if (Number(r.changes) > 0) summary.inserted++;
  }

  if (!dry) {
    if (backfill) setState('yard_backfill_before', lo);
    else setState('yard_newest_block', hi);
    if (summary.inserted > 0) {
      refreshOutlierFlags(db);
      const range = db.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales WHERE source = 'courtyard'`).get();
      if (range?.lo) {
        const dates = [];
        for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
        refreshOracle(db, dates);
      }
    }
  }
  console.log('[yard]', JSON.stringify(summary, null, dry ? 1 : 0));
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  runCourtyardIndexer(db, {
    dry: process.argv.includes('--dry'),
    backfill: process.argv.includes('--backfill'),
  }).catch(e => { console.error(e); process.exit(1); });
}
