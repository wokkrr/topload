/**
 * Collector Crypt adapter (Solana) — the first gacha/vault platform integration.
 *
 * Official marketplace API, no key required:
 *   GET https://api.collectorcrypt.com/marketplace?page=N&step=100
 * Response: { filterNFtCard: [...], totalPages, ... } — current listings only.
 * Listings are ASKING prices → gacha_listings table, never the oracle.
 *
 * Sales history lives on-chain (Solana) — future work: index the marketplace
 * program's buy transactions via an RPC/indexer for self-collected raw solds.
 */

export function makeCollectorCryptAdapter({
  baseUrl = 'https://api.collectorcrypt.com',
  fetchImpl = fetch,
  throttleMs = 500,
} = {}) {
  let lastCall = 0;
  async function getJson(path) {
    const wait = lastCall + throttleMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    const res = await fetchImpl(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`collectorcrypt ${path} → ${res.status}`);
    return res.json();
  }

  return {
    name: 'collectorcrypt',

    /**
     * Fetch current listings (paginated). Filters to listed cards in the given
     * categories. Returns normalized listing records for gacha_listings.
     * @param {{categories?: string[], maxPages?: number, seenAt?: string}} opts
     */
    async fetchListings({ categories = ['Pokemon', 'One Piece'], maxPages = 20, seenAt } = {}) {
      const out = [];
      let page = 1, totalPages = 1;
      while (page <= Math.min(maxPages, totalPages)) {
        const json = await getJson(`/marketplace?page=${page}&step=100`);
        totalPages = json.totalPages ?? 1;
        for (const c of json.filterNFtCard ?? []) {
          if (!c.listing) continue;                      // browsing includes unlisted vault cards
          if (categories.length && !categories.includes(c.category)) continue;
          const priceNum = parseFloat(c.listing.price);
          if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
          out.push({
            platform: 'collectorcrypt',
            external_id: String(c.nftAddress ?? c.id),
            item_name: c.itemName ?? '',
            category: c.category ?? null,
            grade: normalizeGrade(c.gradingCompany, c.gradeNum ?? c.grade),
            price_cents: Math.round(priceNum * 100),    // USDC ≈ USD
            currency: c.listing.currency ?? 'USDC',
            listed_at: c.listing.createdAt ?? null,
            image: c.images?.frontM ?? c.images?.front ?? null,
            nft_address: c.nftAddress ?? null,
            seen_at: seenAt ?? new Date().toISOString().slice(0, 10),
          });
        }
        page++;
      }
      return out;
    },

    // Adapter contract: listings platform, no card universe, no raw solds (yet).
    async listCards() { return []; },
    async fetchSales() { return []; },
  };
}

/** 'PSA' + 10 → 'PSA10'; 'CGC' + 9.5 → 'CGC9.5'; missing → 'raw'. */
export function normalizeGrade(company, gradeNum) {
  if (!company || gradeNum == null || gradeNum === '') return 'raw';
  const n = typeof gradeNum === 'number' ? gradeNum : parseFloat(gradeNum);
  if (!Number.isFinite(n)) return 'raw';
  return `${String(company).toUpperCase().replace(/[^A-Z]/g, '')}${n % 1 === 0 ? n : n.toFixed(1)}`;
}
