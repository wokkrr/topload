/**
 * Pokémon TCG API adapter (free, metadata only): seeds the PKMN card universe.
 * Never a price source. Docs: https://pokemontcg.io
 * X-Api-Key (POKEMONTCG_API_KEY) optional but raises rate limits.
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

  return {
    name: 'pokemontcg',

    /** Chase cards across the configured sets, shaped as CardRecords. */
    async listCards() {
      const out = [];
      for (const set of sets) {
        let page = 1, more = true;
        while (more) {
          const url = `${baseUrl}/cards?q=${encodeURIComponent(`set.id:${set.ptcgioId}`)}&page=${page}&pageSize=250`;
          const res = await fetchImpl(url, { headers });
          if (!res.ok) throw new Error(`pokemontcg ${set.ptcgioId} p${page} → ${res.status}`);
          const { data, totalCount } = await res.json();
          for (const c of data) {
            if (!rarityAllow.includes(c.rarity)) continue;
            out.push({
              id: `pkmn-${c.set.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${c.number}`,
              ip: 'PKMN',
              name: c.name,
              set_name: c.set.name,
              number: `${c.number}/${c.set.printedTotal}`,
              variant: c.rarity,
              external_ids: {
                ptcgio: c.id,
                // Seed queries for downstream resolution/search:
                pcQuery: `${c.name} ${c.number} ${c.set.name} pokemon`,
                ebayQuery: `pokemon ${c.name} ${c.number}/${c.set.printedTotal} ${c.set.name}`,
              },
            });
          }
          more = page * 250 < totalCount;
          page++;
        }
      }
      return out;
    },

    async fetchSales() { return []; }, // metadata source only
  };
}
