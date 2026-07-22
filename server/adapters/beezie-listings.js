/**
 * Beezie listings adapter — active marketplace listings from both of their
 * chain deployments (mapped live 2026-07-22 via their own web apps; the old
 * "backend 500s to outsiders" verdict was a malformed request, same lesson
 * as Phygitals).
 *
 *   POST https://api.beezie.com/dropItems/byCategory        (Base — the big side)
 *   POST https://flow-api.beezie.com/dropItems/byCategory   (Flow — legacy side)
 *   body: { categoryId:'1', page:'0', pageSize:'50', filters:[],
 *           saleStatus:'forSale', sellOrderDateOrder:'DESC' }
 *   → { dropItems:[…], total }
 *
 * Categories (probed live): 1 = Pokemon, 2 = One Piece, 3 = sports,
 * 5 = comics, 6 = video games, 8 = anime — only 1 & 2 are our universe.
 * No Yu-Gi-Oh category exists (consistent with YGO's on-chain absence).
 * Live counts at mapping time: Base 820 PKMN + 41 OP; Flow 18 + 2.
 *
 * Item shape (all verified live): SellOrder.amountUSDC = ask in dollars,
 * SellOrder.createdAt = listing time (epoch ms); metadata.attributes carry
 * year/grader/grade/language/set name/card number/serial (TAG-heavy —
 * Beezie is TAG Grading's partner); altFmv = same ALT integration as
 * Phygitals. Verified server-side from the droplet (no auth, no origin
 * gate). Listings are ASKING prices → gacha_listings only, never oracle.
 */
import { normalizeGrade, gradeFromTitle } from './collectorcrypt.js';
import { timedFetch } from '../net.js';

export const CHAINS = [
  { chain: 'base', api: 'https://api.beezie.com', site: 'https://beezie.com' },
  { chain: 'flow', api: 'https://flow-api.beezie.com', site: 'https://flow.beezie.com' },
];
export const CATEGORY_IDS = { PKMN: '1', OP: '2' };
const IP_LABEL = { PKMN: 'Pokemon', OP: 'One Piece' };

const MAX_PRICE_CENTS = 25_000_000;                    // $250k sanity cap

/** attributes [{trait_type, trait_value}] → plain object (lowercased keys). */
export const attrsOf = (item) => Object.fromEntries(
  (item?.metadata?.attributes ?? []).map(a => [String(a.trait_type ?? '').toLowerCase(), a.trait_value]));

/**
 * Their collectible-page slug, reconstructed from name + id (verified against
 * live URLs: '#OP03-047' → 'OP03047', 'Vol. 1' → 'Vol-1', 'BGS 9.5' → 'BGS-95'):
 * strip everything but letters/digits/spaces, spaces → dashes, append id.
 */
export const slugFor = (name, id) =>
  `${String(name ?? '').replace(/[^A-Za-z0-9 ]+/g, '').trim().replace(/\s+/g, '-')}-${id}`;

/** Map one dropItem → normalized listing row, or null (unsellable/unpriced). */
export function mapItem(item, ip, chain, site, seenAt) {
  if (!item?.id || !item.SellOrder) return null;
  const cents = Math.round(Number(item.SellOrder.amountUSDC) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) return null;

  const a = attrsOf(item);
  const name = item.metadata?.name ?? '';
  let grade = a.grader != null && a.grade != null ? normalizeGrade(a.grader, a.grade) : 'raw';
  if (grade === 'raw') grade = gradeFromTitle(name);

  const listedMs = Number(item.SellOrder.createdAt);
  // Photo indexes (verified live 2026-07-22, tokenId 15343): 0/1 = slab
  // front/back on a DARK tile (clashes on our light desk — Kaleb), 2/3 =
  // the same slab scans on WHITE. Prefer white; ~1-in-12 items lack idx
  // 2/3, so the client imgFallback retries the dark set on 404.
  const img = (idx) => item.tokenId != null ? `https://images.beezie.com/${chain}/${item.tokenId}/${idx}/original.jpg` : null;
  return {
    platform: 'beezie',
    external_id: `beezie:${chain}:${item.id}`,
    item_name: name,
    category: IP_LABEL[ip],
    ip,
    grade,
    price_cents: cents,
    currency: 'USDC',
    listed_at: Number.isFinite(listedMs) && listedMs > 0 ? new Date(listedMs).toISOString() : seenAt ?? null,
    image: img(2) ?? item.metadata?.image ?? null,
    image_back: img(3),
    nft_address: item.tokenId != null ? `${chain}:${item.tokenId}` : null,
    cert: a.serial != null && String(a.serial).trim() !== '' ? String(a.serial).trim() : null,
    // proof carries chain + site slug → listingUrl() rebuilds the exact page.
    // Their collectible URLs key on the TOKEN id, not the item id (item.id
    // 404s — live 2026-07-22, the Eevee Kaleb clicked).
    slug: `${chain}:${slugFor(name, item.tokenId ?? item.id)}`,
    language: a.language ?? null,
    fmv_usd: Number.isFinite(Number(item.altFmv)) && Number(item.altFmv) > 0 ? Number(item.altFmv) : null,
    seen_at: seenAt ?? null,
  };
}

export function makeBeezieListingsAdapter({ fetchImpl = timedFetch, perPage = 50, maxPages = 40, chains = CHAINS } = {}) {
  return {
    name: 'beezie',
    async fetchListings({ seenAt } = {}) {
      const out = [];
      for (const { chain, api, site } of chains) {
        for (const [ip, categoryId] of Object.entries(CATEGORY_IDS)) {
          for (let page = 0; page < maxPages; page++) {
            const res = await fetchImpl(`${api}/dropItems/byCategory`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
              body: JSON.stringify({
                categoryId, page: String(page), pageSize: String(perPage),
                filters: [], saleStatus: 'forSale', sellOrderDateOrder: 'DESC',
              }),
            });
            if (!res.ok) throw new Error(`beezie listings HTTP ${res.status} (${chain} ${ip} p${page})`);
            const j = await res.json();
            const batch = j?.dropItems ?? [];
            for (const item of batch) {
              const row = mapItem(item, ip, chain, site, seenAt);
              if (row) out.push(row);
            }
            if (batch.length < perPage) break;
          }
        }
      }
      return out;
    },
    async listCards() { return []; },
    async fetchSales() { return []; },   // Base sales = on-chain indexer; Flow sales = Aug (Alchemy CU)
  };
}
