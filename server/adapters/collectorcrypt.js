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
          if (c.type && c.type !== 'Card') continue;     // skip cases/boxes/sealed
          const priceNum = parseFloat(c.listing.price);
          if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
          // Structured grade fields are missing on some listings — fall back to
          // parsing the title ('... PSA 10 ...') before giving up and calling it raw.
          let grade = normalizeGrade(c.gradingCompany, c.gradeNum ?? c.grade);
          if (grade === 'raw') grade = gradeFromTitle(c.itemName);
          out.push({
            platform: 'collectorcrypt',
            external_id: String(c.nftAddress ?? c.id),
            item_name: c.itemName ?? '',
            category: c.category ?? null,
            grade,
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

const COMPANY_ALIASES = { BECKETT: 'BGS' };

/** 'PSA' + 10 → 'PSA10'; 'Beckett' + 9.5 → 'BGS9.5'; missing → 'raw'. */
export function normalizeGrade(company, gradeNum) {
  if (!company || gradeNum == null || gradeNum === '') return 'raw';
  const n = typeof gradeNum === 'number' ? gradeNum : parseFloat(gradeNum);
  if (!Number.isFinite(n)) return 'raw';
  let co = String(company).toUpperCase().replace(/[^A-Z]/g, '');
  co = COMPANY_ALIASES[co] ?? co;
  return `${co}${n % 1 === 0 ? n : n.toFixed(1)}`;
}

/** Parse 'PSA 10' / 'BGS 9.5' / 'CGC 10' out of a listing title; else 'raw'. */
export function gradeFromTitle(title) {
  const m = /\b(PSA|BGS|CGC|SGC|BECKETT)\s*([0-9]{1,2}(?:\.5)?)\b/i.exec(title ?? '');
  if (!m) return 'raw';
  return normalizeGrade(m[1], parseFloat(m[2]));
}
