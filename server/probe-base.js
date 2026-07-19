/**
 * Base-chain discovery probe — step one of the Beezie indexer (and the tooling
 * Courtyard/Polygon will reuse). Asks Alchemy about the Beezie Collectibles
 * ERC-721 on Base: recent transfers, whether the parsed NFT-sales endpoint
 * covers Base, and what token metadata looks like (matcher food).
 *
 * Run on a machine with network: npm run probe:base — paste output to Claude.
 */
const KEY = process.env.ALCHEMY_API_KEY;
if (!KEY) { console.error('ALCHEMY_API_KEY not set in .env'); process.exit(1); }

export const BEEZIE_BASE_CONTRACT = '0xbb5ec6fd4b61723bd45c399840f1d868840ca16f';
// Generalized: `npm run probe:evm -- <network> <contract>` for any Alchemy
// chain (e.g. polygon-mainnet 0x251be3a1… for Courtyard). Defaults = Beezie.
const NETWORK = process.argv[2] ?? 'base-mainnet';
const CONTRACT = (process.argv[3] ?? BEEZIE_BASE_CONTRACT).toLowerCase();
const RPC = `https://${NETWORK}.g.alchemy.com/v2/${KEY}`;
const NFT_API = `https://${NETWORK}.g.alchemy.com/nft/v3/${KEY}`;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method} → ${JSON.stringify(json.error).slice(0, 200)}`);
  return json.result;
}

const out = { chain: NETWORK, contract: CONTRACT };

// 1. Connectivity + chain head
try {
  out.blockNumber = parseInt(await rpc('eth_blockNumber', []), 16);
} catch (e) { out.blockNumber = `ERROR: ${e.message}`; }

// 2. Recent transfers of Beezie Collectibles (sales candidates + volume feel)
try {
  const r = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: 'latest',
    contractAddresses: [CONTRACT],
    category: ['erc721'], order: 'desc', maxCount: '0x32', withMetadata: true,
  }]);
  const t = r.transfers ?? [];
  out.transfers = {
    returned: t.length,
    timeSpan: [t.at(-1)?.metadata?.blockTimestamp, t[0]?.metadata?.blockTimestamp],
    samples: t.slice(0, 4).map(x => ({
      hash: x.hash?.slice(0, 18), tokenId: x.tokenId ? parseInt(x.tokenId, 16) : x.erc721TokenId,
      from: x.from?.slice(0, 10), to: x.to?.slice(0, 10), at: x.metadata?.blockTimestamp,
    })),
  };
} catch (e) { out.transfers = `ERROR: ${e.message}`; }

// 3. Parsed NFT sales endpoint — the shortcut if Alchemy supports it on Base
try {
  const res = await fetch(`${NFT_API}/getNFTSales?contractAddress=${CONTRACT}&order=desc&limit=10`);
  if (!res.ok) {
    out.salesEndpoint = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } else {
    const json = await res.json();
    const sales = json.nftSales ?? [];
    out.salesEndpoint = {
      returned: sales.length,
      samples: sales.slice(0, 4).map(s => ({
        marketplace: s.marketplace, tokenId: s.tokenId,
        seller: s.sellerAddress?.slice(0, 10), buyer: s.buyerAddress?.slice(0, 10),
        price: s.sellerFee ? { amount: s.sellerFee.amount, symbol: s.sellerFee.symbol, decimals: s.sellerFee.decimals } : null,
        protocolFee: s.protocolFee?.amount ?? null, blockNumber: s.blockNumber,
      })),
    };
  }
} catch (e) { out.salesEndpoint = `ERROR: ${e.message}`; }

// 4. Metadata for a recent token — what the matcher would work with
try {
  const tid = out.transfers?.samples?.[0]?.tokenId;
  if (tid != null) {
    const res = await fetch(`${NFT_API}/getNFTMetadata?contractAddress=${CONTRACT}&tokenId=${tid}`);
    const json = await res.json();
    out.metadataSample = {
      tokenId: tid,
      name: json.name ?? json.raw?.metadata?.name ?? null,
      description: (json.description ?? '').slice(0, 120),
      attributes: (json.raw?.metadata?.attributes ?? []).slice(0, 12),
      image: json.image?.cachedUrl ? 'yes' : (json.raw?.metadata?.image ? 'raw-only' : 'none'),
    };
  }
} catch (e) { out.metadataSample = `ERROR: ${e.message}`; }

// 5. Receipt anatomy for distinct recent txs — distinguishes marketplace sales
//    (USDC buyer→seller) from Claw pulls (payment→treasury, cards from vault).
const STABLES = {
  'base-mainnet': ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
  'polygon-mainnet': ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'], // USDC + USDC.e
};
const USDC_SET = new Set(STABLES[NETWORK] ?? STABLES['base-mainnet']);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
try {
  const r = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: 'latest',
    contractAddresses: [CONTRACT],
    category: ['erc721'], order: 'desc', maxCount: '0x28', withMetadata: true,
  }]);
  const hashes = [...new Set((r.transfers ?? []).map(t => t.hash))].slice(0, 6);
  out.receipts = [];
  for (const hash of hashes) {
    const rec = await rpc('eth_getTransactionReceipt', [hash]);
    const logs = rec?.logs ?? [];
    const usdc = logs
      .filter(l => USDC_SET.has(l.address?.toLowerCase()) && l.topics?.[0] === TRANSFER_TOPIC)
      .map(l => ({
        from: '0x' + l.topics[1].slice(26, 34),
        to: '0x' + l.topics[2].slice(26, 34),
        usd: parseInt(l.data, 16) / 1e6,
      }));
    const beezieMoves = logs.filter(l =>
      l.address?.toLowerCase() === CONTRACT && l.topics?.[0] === TRANSFER_TOPIC).length;
    const otherLogAddrs = [...new Set(logs
      .map(l => l.address?.toLowerCase())
      .filter(a => !USDC_SET.has(a) && a !== CONTRACT))].slice(0, 4);
    out.receipts.push({
      hash: hash.slice(0, 18),
      txTo: rec?.to?.slice(0, 14),          // the contract users called — marketplace? claw?
      nftMoves: beezieMoves,
      usdcFlows: usdc.slice(0, 5),
      otherContracts: otherLogAddrs.map(a => a.slice(0, 14)),
    });
  }
} catch (e) { out.receipts = `ERROR: ${e.message}`; }

console.log('\n===== PASTE EVERYTHING BELOW TO CLAUDE =====');
console.log(JSON.stringify(out, null, 1));
