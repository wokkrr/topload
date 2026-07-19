/**
 * Generic Solana discovery probe — point it at ANY address (a card's mint, a
 * wallet, or a suspected marketplace program) and it maps the surroundings:
 * parsed transaction types, marketplace sources, involved programs, sale
 * shapes, and (if the address is an asset) its metadata.
 *
 * This is how new platforms get discovered (Phygitals, MNSTR, …):
 *   1. Open the platform's site, click any card, copy the long address from
 *      the URL or the card page ("mint"/"token"/"asset").
 *   2. npm run probe:mint -- <that-address>
 *   3. Paste the output to Claude.
 *
 * The programs list reveals the platform's marketplace program; from there the
 * indexer workflow (dry → verify → backfill) is the same as Collector Crypt's.
 */
const KEY = process.env.HELIUS_API_KEY;
const addr = process.argv[2];
if (!KEY) { console.error('HELIUS_API_KEY not set in .env'); process.exit(1); }
if (!addr || addr.length < 30) { console.error('Usage: npm run probe:mint -- <solana-address>'); process.exit(1); }

const out = { address: addr };

// 1. Is it an asset? (DAS metadata — works for regular NFTs, pNFTs, Core)
try {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: addr } }),
  });
  const json = await res.json();
  const a = json.result;
  out.asset = a ? {
    interface: a.interface,
    name: a.content?.metadata?.name ?? null,
    symbol: a.content?.metadata?.symbol ?? null,
    collection: a.grouping?.find(g => g.group_key === 'collection')?.group_value ?? null,
    attributes: (a.content?.metadata?.attributes ?? []).slice(0, 10),
  } : 'not-an-asset';
} catch (e) { out.asset = `ERROR: ${e.message}`; }

// 2. Parsed transaction history around the address
try {
  const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${KEY}&limit=50`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const txs = await res.json();
  const types = {}, sources = {}, programs = {};
  const saleSamples = [];
  for (const tx of txs) {
    types[tx.type] = (types[tx.type] ?? 0) + 1;
    sources[tx.source] = (sources[tx.source] ?? 0) + 1;
    for (const i of tx.instructions ?? []) programs[i.programId] = (programs[i.programId] ?? 0) + 1;
    if ((tx.type === 'NFT_SALE' || tx.events?.nft?.amount) && saleSamples.length < 2) {
      saleSamples.push({
        signature: tx.signature?.slice(0, 20), type: tx.type, source: tx.source,
        description: tx.description?.slice(0, 140),
        event: tx.events?.nft ? {
          amount: tx.events.nft.amount, saleType: tx.events.nft.saleType,
          buyer: tx.events.nft.buyer?.slice(0, 8), seller: tx.events.nft.seller?.slice(0, 8),
          nfts: (tx.events.nft.nfts ?? []).map(n => n.mint?.slice(0, 8)),
        } : null,
        tokenTransfers: (tx.tokenTransfers ?? []).slice(0, 4).map(t => ({
          mint: t.mint?.slice(0, 8), amt: t.tokenAmount, from: t.fromUserAccount?.slice(0, 8), to: t.toUserAccount?.slice(0, 8),
        })),
      });
    }
  }
  out.txSummary = {
    fetched: txs.length,
    timeSpan: [txs.at(-1)?.timestamp, txs[0]?.timestamp].map(t => t ? new Date(t * 1000).toISOString() : null),
    types, sources,
    topPrograms: Object.fromEntries(Object.entries(programs).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    saleSamples,
  };
} catch (e) { out.txSummary = `ERROR: ${e.message}`; }

console.log('\n===== PASTE EVERYTHING BELOW TO CLAUDE =====');
console.log(JSON.stringify(out, null, 1));
