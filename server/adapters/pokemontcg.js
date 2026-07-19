/**
 * Pokémon TCG API adapter (free, metadata only): card names, sets, numbers,
 * images, ids. Seeds the PKMN card universe; never a price source.
 * Docs: https://pokemontcg.io  (X-Api-Key optional but raises rate limits)
 */
export function makePokemonTcgAdapter({ apiKey = process.env.POKEMONTCG_API_KEY } = {}) {
  const base = 'https://api.pokemontcg.io/v2';
  const headers = apiKey ? { 'X-Api-Key': apiKey } : {};

  return {
    name: 'pokemontcg',

    /** Fetch cards for a set query, e.g. 'set.id:sv3pt5' (151). */
    async listCards(q = 'set.id:sv3pt5') {
      const res = await fetch(`${base}/cards?q=${encodeURIComponent(q)}&pageSize=250`, { headers });
      if (!res.ok) throw new Error(`pokemontcg ${res.status}`);
      const { data } = await res.json();
      return data.map(c => ({
        id: `pkmn-${c.set.id}-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${c.number}`,
        ip: 'PKMN',
        name: c.name,
        set_name: c.set.name,
        number: `${c.number}/${c.set.printedTotal}`,
        variant: '',
        external_ids: { ptcgio: c.id },
      }));
    },

    async fetchSales() { return []; }, // metadata source only
  };
}
