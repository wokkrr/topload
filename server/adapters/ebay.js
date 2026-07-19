/**
 * eBay solds adapter (live). Primary solds source for the oracle.
 * Requires EBAY_APP_ID (+ OAuth for Browse API).
 *
 * Notes for implementation pass:
 *  - Sold/completed data: Marketplace Insights API is gated; the practical path
 *    is Browse API + item filters where available, or the Finding API
 *    (findCompletedItems) on legacy access. Terapeak-style scraping is off the
 *    table (ToS). Design so the source can be swapped when access improves.
 *  - Query per card via cards.external_ids.ebayQuery (curated search string +
 *    negative keywords), filter category + grade tokens ('PSA 10' etc.),
 *    dedupe on itemId → external_id.
 *  - Affiliate: attach EPN campaign id to outbound deep links (aggregator side,
 *    not this adapter).
 */
export function makeEbayAdapter({ appId = process.env.EBAY_APP_ID } = {}) {
  if (!appId) throw new Error('EBAY_APP_ID not set — use the demo adapter or provide a key');

  return {
    name: 'ebay',

    async listCards() {
      // eBay doesn't define the card universe; cards are seeded from metadata
      // (Pokémon TCG API / manual OP list) and this adapter only fetches sales.
      return [];
    },

    async fetchSales(_cardIds, _sinceISO) {
      throw new Error('TODO: implement Browse/Finding solds fetch with grade parsing');
    },
  };
}
