/**
 * PriceCharting adapter (live) — PRIMARY BOOTSTRAP price source.
 *
 * Why primary: eBay's Finding API was decommissioned Feb 2025, Browse API has
 * no solds, and Marketplace Insights is partner-gated. PriceCharting prices
 * are derived from actual sold listings and split by grade, so until we have
 * raw solds access this feeds `external_marks` (never `sales` — that table is
 * raw solds only). Oracle marks built from these carry basis='external' and
 * discounted confidence.
 *
 * Requires PRICECHARTING_API_KEY (paid tier, ~$10/mo).
 * Docs: https://www.pricecharting.com/api-documentation
 *
 * GRADE FIELD MAPPING — verify on first live run with `npm run probe:pricecharting`.
 * PriceCharting reuses its video-game price fields for cards; the documented
 * card meanings are:
 *   loose-price      → ungraded ('raw')
 *   graded-price     → PSA 9 equivalent
 *   manual-only-price→ PSA 10
 *   box-only-price   → Grade 9.5 (BGS/CGC)
 *   bgs-10-price     → BGS 10
 *   condition-17-price / condition-18-price → CGC 10 / SGC 10 (when present)
 * Prices arrive in pennies (integer cents) already.
 */

import { timedFetch } from '../net.js';

const FIELD_TO_GRADE = {
  'loose-price': 'raw',
  'graded-price': 'PSA9',
  'manual-only-price': 'PSA10',
  'box-only-price': 'G9.5',
  'bgs-10-price': 'BGS10',
};

export function makePriceChartingAdapter({
  apiKey = process.env.PRICECHARTING_API_KEY,
  baseUrl = 'https://www.pricecharting.com',
  fetchImpl = timedFetch,
  throttleMs = Number(process.env.PC_THROTTLE_MS ?? 1100), // be a polite API citizen
} = {}) {
  if (!apiKey) throw new Error('PRICECHARTING_API_KEY not set');
  let lastCall = 0;

  async function getJson(path, params) {
    const wait = lastCall + throttleMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();

    const url = new URL(path, baseUrl);
    url.searchParams.set('t', apiKey);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`pricecharting ${path} → ${res.status}`);
    const json = await res.json();
    if (json.status === 'error') throw new Error(`pricecharting: ${json['error-message']}`);
    return json;
  }

  return {
    name: 'pricecharting',

    /** Resolve a PriceCharting product id for a card by search query. */
    async resolveProduct(query) {
      const json = await getJson('/api/products', { q: query });
      return (json.products ?? []).map(p => ({
        pcId: p.id,
        productName: p['product-name'],
        consoleName: p['console-name'], // set name lives here for cards
      }));
    },

    /**
     * Fetch current per-grade prices for cards that carry external_ids.pricecharting.
     * Returns external-mark observations (NOT sales).
     * @param {{id:string, external_ids:{pricecharting?:string}}[]} cards
     * @param {string} asOf ISO date for the observation
     */
    async fetchExternalMarks(cards, asOf) {
      const out = [];
      for (const card of cards) {
        const pcId = card.external_ids?.pricecharting;
        if (!pcId) continue;
        const json = await getJson('/api/product', { id: pcId });
        for (const [field, grade] of Object.entries(FIELD_TO_GRADE)) {
          const cents = json[field];
          if (typeof cents === 'number' && cents > 0) {
            out.push({ source: 'pricecharting', card_id: card.id, grade, as_of: asOf, price_cents: cents });
          }
        }
      }
      return out;
    },

    // Adapter contract compliance: PriceCharting never supplies raw sales.
    async listCards() { return []; },
    async fetchSales() { return []; },
  };
}

export { FIELD_TO_GRADE };
