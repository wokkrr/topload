/**
 * Solana discovery probe — step one of the on-chain sales indexer.
 *
 * Samples slab NFTs from gacha_listings and asks Helius for their parsed
 * transaction history, then prints a compact report: transaction types,
 * marketplaces/programs involved, sale-shaped transactions (NFT moves one
 * way, USDC moves the other), and history depth. Paste the output to Claude —
 * it determines how Collector Crypt sales are decoded for the real indexer.
 *
 * Run on a machine with network: npm run probe:solana
 */
import { openDb } from './db.js';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('HELIUS_API_KEY not set in .env'); process.exit(1); }

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const db = openDb();
const mints = db.prepare(
  `SELECT nft_address, item_name FROM gacha_listings
   WHERE nft_address IS NOT NULL AND length(nft_address) > 30
   ORDER BY price_cents DESC LIMIT 6`
).all();
if (!mints.length) { console.error('no nft addresses in gacha_listings — run ingest first'); process.exit(1); }

const typeCounts = {};
const sourceCounts = {};
const programCounts = {};
const saleExamples = [];
const unknownSaleShaped = [];

for (const { nft_address, item_name } of mints) {
  let txs = [];
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${nft_address}/transactions?api-key=${KEY}&limit=30`);
    if (!res.ok) { console.error(`  ${nft_address.slice(0, 8)}… → HTTP ${res.status}`); continue; }
    txs = await res.json();
  } catch (e) { console.error(`  ${nft_address.slice(0, 8)}… → ${e.message}`); continue; }
  console.error(`fetched ${txs.length} txs for ${item_name?.slice(0, 40)} (${nft_address.slice(0, 8)}…)`);

  for (const tx of txs) {
    typeCounts[tx.type] = (typeCounts[tx.type] ?? 0) + 1;
    sourceCounts[tx.source] = (sourceCounts[tx.source] ?? 0) + 1;
    for (const ins of tx.instructions ?? []) {
      programCounts[ins.programId] = (programCounts[ins.programId] ?? 0) + 1;
    }

    if (tx.type === 'NFT_SALE' && saleExamples.length < 3) {
      saleExamples.push({
        signature: tx.signature?.slice(0, 20), timestamp: tx.timestamp, source: tx.source,
        nft: tx.events?.nft ? {
          amount: tx.events.nft.amount, buyer: tx.events.nft.buyer?.slice(0, 8),
          seller: tx.events.nft.seller?.slice(0, 8), nfts: tx.events.nft.nfts?.map(n => n.mint?.slice(0, 8)),
        } : null,
        description: tx.description?.slice(0, 120),
      });
    }

    // Sale-shaped UNKNOWNs: this NFT transferred AND USDC moved in the same tx.
    if (tx.type !== 'NFT_SALE' && unknownSaleShaped.length < 3) {
      const tt = tx.tokenTransfers ?? [];
      const nftMove = tt.find(t => t.mint === nft_address);
      const usdcMoves = tt.filter(t => t.mint === USDC);
      if (nftMove && usdcMoves.length) {
        unknownSaleShaped.push({
          signature: tx.signature?.slice(0, 20), timestamp: tx.timestamp,
          type: tx.type, source: tx.source,
          nft: { from: nftMove.fromUserAccount?.slice(0, 8), to: nftMove.toUserAccount?.slice(0, 8) },
          usdc: usdcMoves.map(u => ({ from: u.fromUserAccount?.slice(0, 8), to: u.toUserAccount?.slice(0, 8), amount: u.tokenAmount })),
          topPrograms: [...new Set((tx.instructions ?? []).map(i => i.programId))].slice(0, 4),
          description: tx.description?.slice(0, 120),
        });
      }
    }
  }
  await sleep(400);
}

// History depth for the first mint (how far back can we backfill?)
let depth = null;
try {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mints[0].nft_address, { limit: 1000 }] }),
  });
  const json = await res.json();
  const sigs = json.result ?? [];
  depth = { signatures: sigs.length, capped: sigs.length === 1000, oldest: sigs.at(-1)?.blockTime ? new Date(sigs.at(-1).blockTime * 1000).toISOString() : null };
} catch (e) { depth = { error: e.message }; }

console.log('\n===== PASTE EVERYTHING BELOW TO CLAUDE =====');
console.log(JSON.stringify({
  mintsSampled: mints.length,
  txTypes: typeCounts,
  sources: sourceCounts,
  topPrograms: Object.fromEntries(Object.entries(programCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  parsedSaleExamples: saleExamples,
  saleShapedUnknowns: unknownSaleShaped,
  historyDepthFirstMint: depth,
}, null, 1));
