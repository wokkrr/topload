/**
 * Beezie SOLANA recon (2026-07-23, Kaleb: "Beezie just added solana support…
 * to me would take priority over the Base and Flow").
 *
 * Hypothesis (confirmed to the door from the container): Beezie runs one API
 * host per chain with an identical shape — api.beezie.com (Base),
 * flow-api.beezie.com (Flow) — and solana-api.beezie.com is LIVE (Hono
 * banner at root). This probe walks through the door: same
 * POST /dropItems/byCategory the Base/Flow adapter speaks.
 *
 * What we need from the output:
 *   1. Are there live Solana listings? (totals per category)
 *   2. Item shape — same dropItem structure? What identifies the Solana
 *      token (mint address field?) for the cross-venue DOUBLE-SPEND GUARD
 *      (a Beezie-vaulted box mirrored on ME/Tensor must collapse by mint).
 *   3. SellOrder fields (amountUSDC? createdAt?) and altFmv presence.
 *   4. Anything pointing at the sales side (program/collection addresses).
 *
 *   node server/probe-beezie-solana.js
 */
const API = 'https://solana-api.beezie.com';
const BODY = (categoryId) => ({
  categoryId, page: '0', pageSize: '3', filters: [],
  saleStatus: 'forSale', sellOrderDateOrder: 'DESC',
});
const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };

const trim = (o, depth = 0) => {
  if (o == null || typeof o !== 'object') return o;
  if (depth >= 4) return Array.isArray(o) ? `[…${o.length}]` : '{…}';
  if (Array.isArray(o)) return o.slice(0, 6).map(x => trim(x, depth + 1));
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, trim(v, depth + 1)]));
};

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, text: text.slice(0, 300) }; }
}

console.log('[probe] root:', await (await fetch(API, { signal: AbortSignal.timeout(10_000) })).text());

for (const [label, categoryId] of [['Pokemon', '1'], ['One Piece', '2'], ['sports', '3']]) {
  try {
    const r = await post('/dropItems/byCategory', BODY(categoryId));
    if (r.json) {
      const items = r.json.dropItems ?? r.json.items ?? [];
      console.log(`\n[probe] cat ${categoryId} (${label}): HTTP ${r.status} · total=${r.json.total ?? '?'} · returned=${items.length}`);
      if (items[0]) {
        console.log('[probe] FIRST ITEM (trimmed):');
        console.log(JSON.stringify(trim(items[0]), null, 1));
        // The fields the double-spend guard + adapter care about:
        const i = items[0];
        console.log('[probe] key fields:', JSON.stringify({
          id: i.id, name: i.name ?? i.metadata?.name,
          mintish: i.mintAddress ?? i.mint ?? i.tokenAddress ?? i.nftAddress ?? i.tokenId ?? null,
          sellOrder: i.SellOrder ?? i.sellOrder ?? null,
          altFmv: i.altFmv ?? null,
          chainHints: Object.keys(i).filter(k => /chain|solana|mint|token|address/i.test(k)),
        }, null, 1));
      }
    } else {
      console.log(`\n[probe] cat ${categoryId} (${label}): HTTP ${r.status} · ${r.text}`);
    }
  } catch (e) {
    console.log(`\n[probe] cat ${categoryId} (${label}) FAILED: ${e.message}`);
  }
}
