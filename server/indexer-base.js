/**
 * Base-chain sales indexer — Beezie Collectibles (and the template for other
 * EVM platforms like Courtyard/Polygon).
 *
 * Decoding rules (verified against live receipts, 2026-07-19):
 *  - Marketplace sale: buyer pays USDC to a router; router pays seller ~94% +
 *    fee wallets ~6%; each sold card logs TWO transfers (seller→router→buyer).
 *  - Claw/gacha pulls move cards with NO USDC in the tx → excluded (a pull
 *    price is not a card price and must never feed the oracle).
 *  - Cart checkouts (N>1 cards for one lump payment) are counted but NOT
 *    priced — a lump sum can't honestly be split per card.
 *  - Attribution: token metadata is fully structured (Set Name / Card Number /
 *    Grader / Grade / Category) → exact-field matching, franchise-scoped.
 *
 * Modes: npm run base:dry | base:backfill; incremental runs ride ingest.
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';
import { matchListing } from './match.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';

export const BEEZIE_CONTRACT = '0xbb5ec6fd4b61723bd45c399840f1d868840ca16f';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BACKFILL_WINDOW = 100_000; // Base blocks (~2s each) ≈ 2.3 days per window

const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'Pokémon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO', 'Yu-Gi-Oh!': 'YGO' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- pure decode (tested) ----------

/**
 * Decode one transaction's Beezie activity into a sale, or null.
 * @param {{transfers: {tokenId:number|string, from:string, to:string}[],
 *          usdcFlows: {from:string, to:string, usd:number}[]}} tx
 */
export function decodeBaseSale(tx) {
  const flows = tx.usdcFlows ?? [];
  if (!flows.length) return null; // claw pulls / vault moves — no payment in tx

  // Pair each token's hops: seller→router, router→buyer.
  const byToken = new Map();
  for (const t of tx.transfers ?? []) {
    const k = String(t.tokenId);
    (byToken.get(k) ?? byToken.set(k, []).get(k)).push(t);
  }
  const sold = [];
  for (const [tokenId, moves] of byToken) {
    if (moves.length === 2 && moves[0].to?.toLowerCase() === moves[1].from?.toLowerCase()) {
      sold.push({ tokenId, seller: moves[0].from, buyer: moves[1].to });
    } else if (moves.length === 1) {
      sold.push({ tokenId, seller: moves[0].from, buyer: moves[0].to });
    }
  }
  if (sold.length !== 1) return sold.length > 1 ? { cart: sold.length } : null;

  // Price = the buyer's total USDC outflow in this tx.
  const buyer = sold[0].buyer?.toLowerCase();
  const outflows = {};
  for (const f of flows) outflows[f.from?.toLowerCase()] = (outflows[f.from?.toLowerCase()] ?? 0) + f.usd;
  // Buyer may pay via the router account itself when funds pre-deposited —
  // fall back to the largest single-payer outflow (same rule as Solana).
  const price = outflows[buyer] ?? Math.max(...Object.values(outflows));
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    tokenId: sold[0].tokenId,
    seller: sold[0].seller ?? null,
    buyer: sold[0].buyer ?? null,
    price_cents: Math.round(price * 100),
  };
}

/** Structured attrs → matcher-ready fields. */
export function metaToCard(meta) {
  const attrs = Object.fromEntries((meta?.attributes ?? []).map(a => [String(a.trait_type ?? '').toLowerCase(), String(a.value ?? '')]));
  const grade = attrs.grader && attrs.grade ? `${attrs.grader.toUpperCase().replace(/[^A-Z]/g, '')}${attrs.grade}` : 'raw';
  return {
    name: meta?.name ?? '',
    category: attrs.category ?? null,
    grade: grade === 'BECKETT' + attrs.grade ? `BGS${attrs.grade}` : grade,
    setName: attrs['set name'] ?? null,
    cardNumber: attrs['card number'] ?? null,
  };
}

// ---------- alchemy client ----------

function makeAlchemy({ apiKey = process.env.ALCHEMY_API_KEY, fetchImpl = timedFetch, throttleMs = 250 } = {}) {
  if (!apiKey) throw new Error('ALCHEMY_API_KEY not set');
  const RPC = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
  const NFT = `https://base-mainnet.g.alchemy.com/nft/v3/${apiKey}`;
  let last = 0;
  const throttle = async () => { const w = last + throttleMs - Date.now(); if (w > 0) await sleep(w); last = Date.now(); };
  return {
    async rpc(method, params) {
      await throttle();
      const res = await fetchImpl(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`${method} → ${JSON.stringify(json.error).slice(0, 160)}`);
      return json.result;
    },
    async metadata(tokenId) {
      await throttle();
      const res = await fetchImpl(`${NFT}/getNFTMetadata?contractAddress=${BEEZIE_CONTRACT}&tokenId=${tokenId}`);
      if (!res.ok) return null;
      const json = await res.json();
      return { name: json.name ?? json.raw?.metadata?.name ?? null, attributes: json.raw?.metadata?.attributes ?? [] };
    },
  };
}

// ---------- main ----------

export async function runBaseIndexer(db, { dry = false, backfill = false, maxWindows = Number(process.env.ALCHEMY_MAX_WINDOWS ?? 3), alchemy = null } = {}) {
  const a = alchemy ?? makeAlchemy();
  const universeByIp = {};
  for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) (universeByIp[c.ip] ??= []).push(c);
  const getState = (k) => db.prepare(`SELECT value FROM indexer_state WHERE key = ?`).get(k)?.value ?? null;
  const setState = (k, v) => db.prepare(`INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v));
  const insSale = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, 'beezie', ?)`
  );
  const upReg = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, category, grade, first_seen, last_seen)
     VALUES (?, 'beezie', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET card_id = COALESCE(excluded.card_id, nft_registry.card_id), last_seen = excluded.last_seen`
  );

  const head = parseInt(await a.rpc('eth_blockNumber', []), 16);
  const summary = { windows: 0, txs: 0, sales: 0, carts: 0, clawOrMoves: 0, attributed: 0, inserted: 0, unattributed: 0, dryExamples: [] };

  // Window bounds: incremental walks forward from last-seen; backfill walks backward.
  let lo, hi;
  if (backfill) {
    const before = parseInt(getState('beezie_backfill_before') ?? String(head), 10);
    lo = Math.max(0, before - BACKFILL_WINDOW * maxWindows);
    hi = before;
  } else {
    lo = parseInt(getState('beezie_newest_block') ?? String(head - BACKFILL_WINDOW), 10) + 1;
    hi = head;
  }
  if (lo >= hi) { console.log('[base] nothing new'); return summary; }

  // 1. All ERC-721 transfers of the contract in range (paginated).
  const transfersByHash = new Map();
  const timeByHash = new Map();
  let pageKey;
  do {
    const r = await a.rpc('alchemy_getAssetTransfers', [{
      fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16),
      contractAddresses: [BEEZIE_CONTRACT], category: ['erc721'],
      order: 'asc', maxCount: '0x3e8', withMetadata: true, ...(pageKey ? { pageKey } : {}),
    }]);
    for (const t of r.transfers ?? []) {
      const tokenId = t.tokenId ? parseInt(t.tokenId, 16) : t.erc721TokenId;
      (transfersByHash.get(t.hash) ?? transfersByHash.set(t.hash, []).get(t.hash)).push({ tokenId, from: t.from, to: t.to });
      timeByHash.set(t.hash, t.metadata?.blockTimestamp);
    }
    pageKey = r.pageKey;
  } while (pageKey);
  summary.txs = transfersByHash.size;
  summary.windows = Math.ceil((hi - lo) / BACKFILL_WINDOW);

  // 2. Per-tx receipts → USDC flows → decode.
  for (const [hash, transfers] of transfersByHash) {
    let usdcFlows = [];
    try {
      const rec = await a.rpc('eth_getTransactionReceipt', [hash]);
      usdcFlows = (rec?.logs ?? [])
        .filter(l => l.address?.toLowerCase() === USDC_BASE && l.topics?.[0] === TRANSFER_TOPIC)
        .map(l => ({ from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), usd: parseInt(l.data, 16) / 1e6 }));
    } catch { continue; }

    const sale = decodeBaseSale({ transfers, usdcFlows });
    if (!sale) { summary.clawOrMoves++; continue; }
    if (sale.cart) { summary.carts++; continue; }
    summary.sales++;

    // 3. Attribution via structured metadata (registry-cached).
    const mintKey = `beezie:${sale.tokenId}`;
    let reg = db.prepare(`SELECT card_id, grade, item_name FROM nft_registry WHERE mint = ?`).get(mintKey);
    if (!reg) {
      const meta = await a.metadata(sale.tokenId);
      const m = metaToCard(meta);
      const ip = CATEGORY_TO_IP[m.category];
      const card_id = ip && m.name ? matchListing(`${m.name} ${m.setName ?? ''}`, universeByIp[ip] ?? []) : null;
      const today = new Date().toISOString().slice(0, 10);
      upReg.run(mintKey, card_id, m.name, m.category, m.grade, today, today);
      reg = { card_id, grade: m.grade, item_name: m.name };
    }

    if (dry) {
      if (summary.dryExamples.length < 8) {
        summary.dryExamples.push({
          hash: hash.slice(0, 14), at: timeByHash.get(hash), tokenId: sale.tokenId,
          price_cents: sale.price_cents, item: reg.item_name?.slice(0, 60), grade: reg.grade,
          matched: reg.card_id ?? null,
        });
      }
      continue;
    }
    if (!reg.card_id) { summary.unattributed++; continue; }
    summary.attributed++;
    const r = insSale.run(reg.card_id, reg.grade ?? 'raw', sale.price_cents, timeByHash.get(hash) ?? null, `${hash}:${sale.tokenId}`);
    if (Number(r.changes) > 0) summary.inserted++;
  }

  if (!dry) {
    if (backfill) setState('beezie_backfill_before', lo);
    else setState('beezie_newest_block', hi);
    if (summary.inserted > 0) {
      refreshOutlierFlags(db);
      const range = db.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales WHERE source = 'beezie'`).get();
      if (range?.lo) {
        const dates = [];
        for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
        refreshOracle(db, dates);
      }
    }
  }
  console.log('[base]', JSON.stringify(summary, null, dry ? 1 : 0));
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  runBaseIndexer(db, {
    dry: process.argv.includes('--dry'),
    backfill: process.argv.includes('--backfill'),
  }).catch(e => { console.error(e); process.exit(1); });
}
