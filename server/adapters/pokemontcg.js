/**
 * Pokémon TCG API adapter (free): seeds the PKMN card universe AND supplies
 * the free-tier price bootstrap — pokemontcg.io bundles TCGplayer *market
 * price* snapshots with card metadata. Those are asking-adjacent (not solds),
 * raw-condition only, so they enter external_marks as source 'tcgplayer' and
 * the oracle discounts them harder than PriceCharting (see EXTERNAL_SOURCES).
 * Docs: https://pokemontcg.io — X-Api-Key optional but raises rate limits.
 */
import { PKMN_SETS, PKMN_RARITY_ALLOW } from '../universe.js';

export function makePokemonTcgAdapter({
  apiKey = process.env.POKEMONTCG_API_KEY,
  baseUrl = 'https://api.pokemontcg.io/v2',
  fetchImpl = fetch,
  sets = PKMN_SETS,
  rarityAllow = PKMN_RARITY_ALLOW,
} = {}) {
  const headers = apiKey ? { 'X-Api-Key': apiKey } : {};

  /** Pull the best available TCGplayer market price (USD) from a card payload. */
  function marketPrice(c) {
    const prices = c.tcgplayer?.prices;
    if (!prices) return null;
    for (const variant of ['holofoil', 'normal', 'reverseHolofoil', 'unlimitedHolofoil', '1stEditionHolofoil']) {
      const m = prices[variant]?.market;
      if (typeof m === 'number' && m > 0) return m;
    }
    // Fall back to any variant that has a market price.
    for (const v of Object.values(prices)) {
      if (typeof v?.market === 'number' && v.market > 0) return v.market;
    }
    return null;
  }

  async function* pages() {
    for (const set of sets) {
      let page = 1, more = true;
      while (more) {
        const url = `${baseUrl}/cards?q=${encodeURIComponent(`set.id:${set.ptcgioId}`)}&page=${page}&pageSize=250`;
        const res = await fetchImpl(url, { headers });
        if (!res.ok) throw new Error(`pokemontcg ${set.ptcgioId} p${page} → ${res.status}`);
        const { data, totalCount } = await res.json();
        yield data;
        more = page * 250 < totalCount;
        page++;
      }
    }
  }

  const cardId = (c) => `pkmn-${c.set.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${c.number}`;

  return {
    name: 'pokemontcg',

    /** Chase cards across the configured sets, shaped as CardRecords. */
    async listCards() {
      const out = [];
      for await (const data of pages()) {
          for (const c of data) {
            if (!rarityAllow.includes(c.rarity)) continue;
            out.push({
              id: cardId(c),
              ip: 'PKMN',
              name: c.name,
              set_name: c.set.name,
              number: `${c.number}/${c.set.printedTotal}`,
              variant: c.rarity,
              image: c.images?.large ?? c.images?.small ?? null,
              external_ids: {
                ptcgio: c.id,
                // Seed queries for downstream resolution/search:
                pcQuery: `${c.name} ${c.number} ${c.set.name} pokemon`,
                ebayQuery: `pokemon ${c.name} ${c.number}/${c.set.printedTotal} ${c.set.name}`,
              },
            });
          }
      }
      return out;
    },

    /**
     * Free price bootstrap: TCGplayer market-price snapshots (raw only).
     * Returns external-mark observations for source 'tcgplayer'.
     * @param {{id:string}[]} cards tracked cards (filters the sweep)
     * @param {string} asOf ISO date for the observation
     */
    async fetchExternalMarks(cards, asOf) {
      const tracked = new Set(cards.map(c => c.id));
      const out = [];
      for await (const data of pages()) {
        for (const c of data) {
          const id = cardId(c);
          if (!tracked.has(id)) continue;
          const usd = marketPrice(c);
          if (usd == null) continue;
          out.push({ source: 'tcgplayer', card_id: id, grade: 'raw', as_of: asOf, price_cents: Math.round(usd * 100) });
        }
      }
      return out;
    },

    async fetchSales() { return []; }, // never raw solds
  };
}
