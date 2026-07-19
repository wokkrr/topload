/**
 * PriceCharting adapter (live). Requires PRICECHARTING_API_KEY (~$10/mo tier).
 * Docs: https://www.pricecharting.com/api-documentation
 *
 * Notes for implementation pass:
 *  - /api/products?q=... to resolve card ids; cache into cards.external_ids.pricecharting
 *  - /api/product?id=... returns current prices by condition/grade — PriceCharting
 *    exposes *computed* prices, not raw solds, so treat these as a secondary
 *    cross-check series, not primary oracle input. Primary solds come from eBay.
 */
export function makePriceChartingAdapter({ apiKey = process.env.PRICECHARTING_API_KEY } = {}) {
  if (!apiKey) throw new Error('PRICECHARTING_API_KEY not set — use the demo adapter or provide a key');
  const base = 'https://www.pricecharting.com/api';

  return {
    name: 'pricecharting',

    async listCards() {
      throw new Error('TODO: seed card list from a curated query set, then resolve ids via /api/products');
    },

    async fetchSales(_cardIds, _sinceISO) {
      throw new Error('TODO: map /api/product prices to secondary marks (not raw solds)');
    },
  };
}
