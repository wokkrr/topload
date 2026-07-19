/**
 * eBay adapters — split by what eBay actually offers in 2026:
 *
 *  1. SOLDS (oracle input): Finding API decommissioned Feb 2025; Browse API has
 *     no completed items; Marketplace Insights API is limited-release and
 *     partner-gated. `makeEbayInsightsAdapter` is the ready slot for when (if)
 *     the application is approved — until then the oracle bootstraps from
 *     PriceCharting external marks.
 *
 *  2. LIVE LISTINGS (aggregator, build step 2): Browse API works with standard
 *     OAuth client credentials. `makeEbayBrowseAdapter` fetches active listings
 *     for comp-delta display + EPN affiliate deep links. Listings NEVER enter
 *     the oracle.
 *
 * Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET (Browse); EPN_CAMPAIGN_ID (affiliate).
 */

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

/** Parse a grade out of a listing title: 'PSA 10', 'BGS 9.5', 'CGC 10', else 'raw'. */
export function parseGrade(title) {
  const m = /\b(PSA|BGS|CGC|SGC)\s*([0-9]{1,2}(?:\.5)?)\b/i.exec(title ?? '');
  if (!m) return 'raw';
  return `${m[1].toUpperCase()}${m[2]}`;
}

export function makeEbayBrowseAdapter({
  clientId = process.env.EBAY_CLIENT_ID,
  clientSecret = process.env.EBAY_CLIENT_SECRET,
  epnCampaignId = process.env.EPN_CAMPAIGN_ID,
  fetchImpl = fetch,
} = {}) {
  if (!clientId || !clientSecret) throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set');
  let token = null, tokenExp = 0;

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const res = await fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });
    if (!res.ok) throw new Error(`ebay oauth → ${res.status}`);
    const json = await res.json();
    token = json.access_token;
    tokenExp = Date.now() + json.expires_in * 1000;
    return token;
  }

  return {
    name: 'ebay-browse',

    /**
     * Live listings for one card (aggregator feed — never oracle input).
     * @param {{id:string, external_ids:{ebayQuery?:string}, name:string}} card
     */
    async fetchListings(card, { limit = 50 } = {}) {
      const q = card.external_ids?.ebayQuery ?? card.name;
      const url = new URL(BROWSE_URL);
      url.searchParams.set('q', q);
      url.searchParams.set('category_ids', '183454'); // CCG Individual Cards
      url.searchParams.set('limit', String(limit));
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
      if (!res.ok) throw new Error(`ebay browse → ${res.status}`);
      const json = await res.json();
      return (json.itemSummaries ?? []).map(it => ({
        card_id: card.id,
        source: 'ebay',
        external_id: it.itemId,
        title: it.title,
        grade: parseGrade(it.title),
        price_cents: Math.round(parseFloat(it.price?.value ?? '0') * 100),
        currency: it.price?.currency ?? 'USD',
        url: epnCampaignId
          ? `${it.itemWebUrl}${it.itemWebUrl.includes('?') ? '&' : '?'}mkcid=1&mkrid=711-53200-19255-0&campid=${epnCampaignId}&toolid=10001`
          : it.itemWebUrl,
        image: it.image?.imageUrl ?? null,
        seller: it.seller?.username ?? null,
      }));
    },

    // Adapter contract: Browse supplies zero solds by design.
    async listCards() { return []; },
    async fetchSales() { return []; },
  };
}

/** Slot for eBay Marketplace Insights (partner-gated). Apply, then implement. */
export function makeEbayInsightsAdapter() {
  return {
    name: 'ebay-insights',
    async listCards() { return []; },
    async fetchSales() {
      throw new Error('Marketplace Insights access not granted yet — oracle uses PriceCharting bootstrap until then');
    },
  };
}
