/**
 * Solana on-chain sales indexer — the oracle's first SELF-COLLECTED solds.
 *
 * Reads the Collector Crypt marketplace program's parsed transaction history
 * via Helius, decodes completed sales (NFT one way, USDC the other), maps each
 * slab mint to a card via nft_registry (populated from listings snapshots,
 * with DAS metadata lookups as fallback), and writes them into `sales` as
 * source='collectorcrypt' — first-class raw solds: outlier-filtered, oracle
 * marks basis='solds', outranking every external source.
 *
 * Modes:
 *   node server/indexer-solana.js --dry        decode a page, print, write nothing
 *   node server/indexer-solana.js              incremental (new sales since cursor)
 *   node server/indexer-solana.js --backfill   walk history backwards (bounded per run)
 *
 * Discovery basis (probe 2026-07-19): program CcmRK…SQUr; Helius labels source
 * COLLECTOR_CRYPT; USDC settlements visible in tokenTransfers (escrow-style:
 * one account pays out seller + fee — total single-payer outflow = price).
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';
import { matchListing } from './match.js';
import { refreshOutlierFlags, refreshOracle } from './oracle.js';

export const CC_MARKETPLACE_PROGRAM = 'CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'One Piece': 'OP', 'YuGiOh': 'YGO', 'Yu-Gi-Oh': 'YGO' };

// ---------- pure decode (tested) ----------

/**
 * Decode one Helius-parsed transaction into a sale, or null.
 * Robust to parser labels: primary signal is token flow — exactly one non-USDC
 * token moving (the slab) plus USDC moving, price = the largest total USDC
 * outflow from a single account (buyer or escrow paying out 100%).
 */
const KNOWN_PROGRAMS = new Set([
  CC_MARKETPLACE_PROGRAM, USDC,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', // MPL Core
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
]);

export function decodeSale(tx) {
  const tt = tx.tokenTransfers ?? [];
  const ev = tx.events?.nft;
  const nftMoves = tt.filter(t => t.mint && t.mint !== USDC && Number(t.tokenAmount) === 1);
  const usdcMoves = tt.filter(t => t.mint === USDC && Number(t.tokenAmount) > 0);

  // Price: largest total USDC outflow from a single payer (buyer or escrow
  // paying out 100%); fall back to the parsed event amount (USDC, 6dp — CC
  // is a USDC-only market; verified against money flows live).
  let price = 0;
  if (usdcMoves.length) {
    const outflows = {};
    for (const u of usdcMoves) {
      outflows[u.fromUserAccount] = (outflows[u.fromUserAccount] ?? 0) + Number(u.tokenAmount);
    }
    price = Math.max(...Object.values(outflows));
  } else if (ev?.amount > 0) {
    price = Number(ev.amount) / 1e6;
  }
  if (!Number.isFinite(price) || price <= 0) return null;

  const base = {
    signature: tx.signature,
    sold_at: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
    seller: ev?.seller ?? null,
    buyer: ev?.buyer ?? null,
    price_cents: Math.round(price * 100),
  };

  // Slab identity, in order of certainty:
  // 1. A visible SPL transfer of the slab (non-vaulted pNFTs).
  if (nftMoves.length === 1) {
    return { ...base, mint: nftMoves[0].mint, seller: nftMoves[0].fromUserAccount ?? base.seller, buyer: nftMoves[0].toUserAccount ?? base.buyer, candidates: null };
  }
  if (nftMoves.length > 1) return null; // ambiguous batch

  // 2. The parsed event names the asset (rare for CC, but free when present).
  const evNfts = (ev?.nfts ?? []).filter(n => n?.mint && n.mint !== USDC);
  if (evNfts.length === 1) return { ...base, mint: evNfts[0].mint, candidates: null };

  // 3. Vaulted MPL Core sales: the asset hides in the marketplace instruction's
  //    account list. Positions 6 and 8 vary per sale (verified live 2026-07-19);
  //    return both as candidates — the caller resolves which is the real asset
  //    via registry membership or a DAS lookup.
  if (tx.type === 'NFT_SALE') {
    const cc = (tx.instructions ?? []).find(i => i.programId === CC_MARKETPLACE_PROGRAM);
    const accts = cc?.accounts ?? [];
    const exclude = new Set([base.buyer, base.seller, ...KNOWN_PROGRAMS]);
    const candidates = [accts[8], accts[6]].filter(a => a && !exclude.has(a));
    if (candidates.length) return { ...base, mint: null, candidates: [...new Set(candidates)] };
  }
  return null;
}

// ---------- helius client ----------

function makeHelius({ apiKey = process.env.HELIUS_API_KEY, fetchImpl = timedFetch, throttleMs = 250 } = {}) {
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');
  let last = 0;
  const throttled = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + throttleMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try { return await fn(); } catch (e) {
        // 429 = rate limit — back off and retry a few times before giving up.
        if (String(e.message).includes('429') && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
        throw e;
      }
    }
  };
  return {
    /** Parsed transactions for an address, newest first. `before` = signature cursor. */
    async parsedTxs(address, { before, limit = 100, type } = {}) {
      return throttled(async () => {
        const url = new URL(`https://api.helius.xyz/v0/addresses/${address}/transactions`);
        url.searchParams.set('api-key', apiKey);
        url.searchParams.set('limit', String(limit));
        if (type) url.searchParams.set('type', type);
        if (before) url.searchParams.set('before', before);
        const res = await fetchImpl(url);
        if (res.status === 404) {
          // Filtered scans 404 when their bounded window has no matches — the
          // body carries a continuation signature to keep walking from.
          const body = await res.text().catch(() => '');
          const hint = /`?before-signature`?[^1-9A-HJ-NP-Za-km-z]*([1-9A-HJ-NP-Za-km-z]{60,90})/.exec(body)?.[1]
            ?? /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(body)?.[1];
          return { _continueBefore: hint ?? null };
        }
        if (!res.ok) throw new Error(`helius parsedTxs → ${res.status}`);
        return res.json();
      });
    },
    /** DAS metadata for a mint (name/attributes) — post-hoc card attribution. */
    async getAsset(mint) {
      return throttled(async () => {
        const res = await fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
        });
        if (!res.ok) throw new Error(`helius getAsset → ${res.status}`);
        const json = await res.json();
        return json.result ?? null;
      });
    },
  };
}

// ---------- mint → card attribution ----------

function universeByIp(db) {
  const by = {};
  for (const c of db.prepare(`SELECT id, ip, name, number, set_name FROM cards`).all()) {
    (by[c.ip] ??= []).push(c);
  }
  return by;
}

/**
 * Vaulted Core sales don't name their asset — decodeSale returns candidate
 * accounts instead. The real asset is whichever candidate is a known slab
 * (registry) or resolves via DAS with metadata; listing PDAs resolve to
 * nothing and get cached as non-assets for the rest of the run.
 */
async function resolveCandidates(db, helius, candidates, notAsset) {
  for (const c of candidates) {
    if (db.prepare(`SELECT mint FROM nft_registry WHERE mint = ?`).get(c)) return { mint: c, asset: null };
  }
  for (const c of candidates) {
    if (notAsset.has(c)) continue;
    try {
      const a = await helius.getAsset(c);
      if (a?.content?.metadata?.name) return { mint: c, asset: a };
    } catch { /* fall through */ }
    notAsset.add(c);
  }
  return { mint: null, asset: null };
}

/** Resolve a mint to {card_id, grade} via registry, else DAS metadata match. */
async function attributeMint(db, helius, mint, universe, gradeFromTitle, preloadedAsset = null) {
  const reg = db.prepare(`SELECT card_id, grade FROM nft_registry WHERE mint = ?`).get(mint);
  if (reg?.card_id) return { card_id: reg.card_id, grade: reg.grade ?? 'raw', how: 'registry' };

  let asset = preloadedAsset;
  if (!asset) { try { asset = await helius.getAsset(mint); } catch { /* rpc hiccup → unattributed */ } }
  const name = asset?.content?.metadata?.name ?? '';
  if (!name) return null;
  const attrs = Object.fromEntries((asset?.content?.metadata?.attributes ?? []).map(a => [String(a.trait_type ?? '').toLowerCase(), a.value]));
  const category = attrs.category ?? attrs.game ?? null;
  const grade = gradeFromTitle(`${name} ${attrs.grade ?? ''} ${attrs['grading company'] ?? ''}`);

  const ips = category && CATEGORY_TO_IP[category] ? [CATEGORY_TO_IP[category]] : ['PKMN', 'OP', 'YGO'];
  let card_id = null;
  for (const ip of ips) {
    card_id = matchListing(name, universe[ip] ?? []);
    if (card_id) break;
  }
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, category, grade, first_seen, last_seen)
     VALUES (?, 'collectorcrypt', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET card_id = COALESCE(nft_registry.card_id, excluded.card_id), last_seen = excluded.last_seen`
  ).run(mint, card_id, name, category, grade, today, today);
  return card_id ? { card_id, grade, how: 'das' } : null;
}

// ---------- main ----------

export async function runSolanaIndexer(db, { dry = false, backfill = false, maxPages = Number(process.env.HELIUS_MAX_PAGES ?? 10), helius = null } = {}) {
  const { gradeFromTitle } = await import('./adapters/collectorcrypt.js');
  const h = helius ?? makeHelius();
  const universe = universeByIp(db);
  const getState = (k) => db.prepare(`SELECT value FROM indexer_state WHERE key = ?`).get(k)?.value ?? null;
  const setState = (k, v) => db.prepare(`INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  const insSale = db.prepare(
    `INSERT OR IGNORE INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
     VALUES (?, ?, ?, 'USD', ?, 'collectorcrypt', ?)`
  );
  const newestSeen = getState('cc_newest_sig');
  const backfillCursor = getState('cc_backfill_before');
  const notAssetCache = new Set(); // listing PDAs etc. — non-assets, per run

  const summary = { pages: 0, txs: 0, decoded: 0, attributed: 0, inserted: 0, unattributed: 0, dryExamples: [] };
  const diag = dry ? { types: {}, sources: {}, withTokenTransfers: 0, withNftEvents: 0, withCompressed: 0, timeSpan: [null, null], rawSaleSamples: [] } : null;
  let before = backfill ? (backfillCursor ?? undefined) : undefined;
  let newestThisRun = null;
  let reachedKnown = false;

  for (let page = 0; page < maxPages && !reachedKnown; page++) {
    let txs;
    // type=NFT_SALE server-side filter (the program firehose is ~94% bid
    // noise). Windows with no matches return a continuation signature via 404;
    // follow it — each hop still counts as a page to bound API spend.
    try {
      txs = await h.parsedTxs(CC_MARKETPLACE_PROGRAM, { before, type: 'NFT_SALE' });
      if (txs?._continueBefore !== undefined) {
        if (!txs._continueBefore) { if (backfill) setState('cc_backfill_done', '1'); break; }
        before = txs._continueBefore;
        summary.pages++;
        continue;
      }
    } catch (e) { console.warn(`[solana] page fetch failed: ${e.message}`); break; }
    if (!txs.length) { if (backfill) setState('cc_backfill_done', '1'); break; }
    summary.pages++;
    summary.txs += txs.length;
    newestThisRun ??= txs[0]?.signature;

    for (const tx of txs) {
      if (!backfill && newestSeen && tx.signature === newestSeen) { reachedKnown = true; break; }
      if (diag) {
        diag.types[tx.type] = (diag.types[tx.type] ?? 0) + 1;
        diag.sources[tx.source] = (diag.sources[tx.source] ?? 0) + 1;
        if (tx.tokenTransfers?.length) diag.withTokenTransfers++;
        if (tx.events?.nft) diag.withNftEvents++;
        if (tx.events?.compressed?.length) diag.withCompressed++;
        if (tx.timestamp) {
          if (!diag.timeSpan[1]) diag.timeSpan[1] = tx.timestamp;
          diag.timeSpan[0] = tx.timestamp;
        }
      }
      const sale = decodeSale(tx);
      if (diag && tx.type === 'NFT_SALE' && !sale && diag.rawSaleSamples.length < 3) {
        // Surgical dump for UNDECODED sales: where does the slab's identity live?
        const cc = (tx.instructions ?? []).find(i => i.programId === CC_MARKETPLACE_PROGRAM);
        diag.rawSaleSamples.push({
          signature: tx.signature?.slice(0, 24),
          description: tx.description?.slice(0, 140),
          events: tx.events ?? null,
          ccInstructionAccounts: cc?.accounts ?? null,
          ccInnerPrograms: (cc?.innerInstructions ?? []).map(i => i.programId),
          allAccounts: (tx.accountData ?? []).map(a => a.account),
        });
      }
      if (!sale || !sale.sold_at) continue;
      summary.decoded++;

      if (dry) {
        if (summary.dryExamples.length < 8) {
          const resolved = sale.mint
            ? { mint: sale.mint, how: 'direct' }
            : await resolveCandidates(db, h, sale.candidates ?? [], notAssetCache).then(r => ({ mint: r.mint, how: r.mint ? 'resolved' : 'unresolved', asset_name: r.asset?.content?.metadata?.name }));
          const reg = resolved.mint ? db.prepare(`SELECT card_id, item_name, grade FROM nft_registry WHERE mint = ?`).get(resolved.mint) : null;
          summary.dryExamples.push({
            ...sale,
            mint: resolved.mint?.slice(0, 12) ?? null,
            resolution: resolved.how,
            asset_name: resolved.asset_name ?? undefined,
            candidates: sale.candidates?.map(c => c.slice(0, 8)),
            registry: reg ?? 'not-in-registry',
          });
        }
        continue;
      }

      let mint = sale.mint, preloadedAsset = null;
      if (!mint && sale.candidates?.length) {
        const r = await resolveCandidates(db, h, sale.candidates, notAssetCache);
        mint = r.mint;
        preloadedAsset = r.asset;
      }
      if (!mint) { summary.unattributed++; continue; }

      const attr = await attributeMint(db, h, mint, universe, gradeFromTitle, preloadedAsset);
      if (!attr) { summary.unattributed++; continue; }
      summary.attributed++;
      const r = insSale.run(attr.card_id, attr.grade, sale.price_cents, sale.sold_at, sale.signature);
      if (Number(r.changes) > 0) summary.inserted++;
    }
    before = txs.at(-1)?.signature;
  }

  if (!dry) {
    if (backfill && before) setState('cc_backfill_before', before);
    if (!backfill && newestThisRun) setState('cc_newest_sig', newestThisRun);
    if (summary.inserted > 0) {
      // Recompute outliers + marks over affected range (cheap: set-based pass).
      const range = db.prepare(`SELECT MIN(date(sold_at)) lo, MAX(date(sold_at)) hi FROM sales WHERE source = 'collectorcrypt'`).get();
      refreshOutlierFlags(db);
      if (range?.lo) {
        const dates = [];
        for (let t = new Date(range.lo).getTime(); t <= new Date(range.hi).getTime(); t += 86_400_000) {
          dates.push(new Date(t).toISOString().slice(0, 10));
        }
        refreshOracle(db, dates);
      }
    }
  }
  if (diag) {
    diag.timeSpan = diag.timeSpan.map(t => t ? new Date(t * 1000).toISOString() : null);
    console.log('[solana:diag]', JSON.stringify(diag, null, 1));
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync('data', { recursive: true });
      writeFileSync('data/solana-diag.json', JSON.stringify(diag, null, 2));
      console.log('[solana:diag] full dump also written to data/solana-diag.json');
    } catch { /* best effort */ }
  }
  console.log('[solana]', JSON.stringify(summary, null, dry ? 1 : 0));
  return summary;
}

/** Registry upsert used by ingest's listings step — every listed slab is remembered. */
export function registerListings(db, listings, matches) {
  const today = new Date().toISOString().slice(0, 10);
  const ins = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, category, grade, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       card_id = COALESCE(excluded.card_id, nft_registry.card_id),
       item_name = excluded.item_name, grade = excluded.grade, last_seen = excluded.last_seen`
  );
  let n = 0;
  for (const l of listings) {
    if (!l.nft_address) continue;
    ins.run(l.nft_address, l.platform, matches.get(l.external_id) ?? null, l.item_name, l.category, l.grade, today, today);
    n++;
  }
  return n;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  runSolanaIndexer(db, {
    dry: process.argv.includes('--dry'),
    backfill: process.argv.includes('--backfill'),
  }).catch(e => { console.error(e); process.exit(1); });
}
