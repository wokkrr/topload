/**
 * pokemon-tcg-data → canonical Pokémon card catalog (the "Topload Card Database"
 * spine for PKMN). Source: github.com/PokemonTCG/pokemon-tcg-data — the OFFICIAL
 * open-source data behind pokemontcg.io, published as static JSON on GitHub and
 * updated as new sets drop (English). We vendor it: fetch from GitHub raw +
 * snapshot into seed/, so the catalog is an asset we OWN, not a live API call.
 *
 * Why this over the live pokemontcg.io API: (1) ownership — a committed snapshot
 * survives the upstream going away, (2) completeness — the full ~20k-card
 * catalog (every rarity, every set back to Base 1999), not the thin high-rarity
 * slice the old adapter pulled, (3) currency — the repo lands new sets within
 * days of release. card.id here IS the pokemontcg.io id, so the linkage is free.
 *
 * Japanese printings are a later pass (TCGdex, whose JA data needs a heavier
 * parse). English names + collector numbers carry matching today; when JA lands,
 * those cards get an English/romanized name + language='Japanese' tag so the
 * user never has to read kanji (Kaleb's display model).
 */

const RAW = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';

/**
 * Pure: one pokemon-tcg-data card + its set metadata → a Topload card record.
 * The per-set card files omit set info, so `set` (from sets/en.json) is joined
 * in by the caller.
 * @param {object} card  a card object from cards/en/<setId>.json
 * @param {object} set   the matching set object from sets/en.json
 */
export function mapCard(card, set, { language = 'English' } = {}) {
  if (!card?.id || !card?.name) return null;
  const printedTotal = set?.printedTotal ?? set?.total ?? null;
  // Collector number as it reads on the card + in listings ("4/102"); promos and
  // subsets keep their alnum localId ("TG01", "SWSH001") with no denominator.
  const number = printedTotal && /^\d+$/.test(String(card.number))
    ? `${card.number}/${printedTotal}`
    : String(card.number ?? '');
  const setName = set?.name ?? '';
  return {
    id: `pkmn-${card.id}`,                         // pkmn-base1-4 (dedup-stable = the ptcgio id)
    ip: 'PKMN',
    name: card.name,
    set_name: setName,
    number,
    variant: card.rarity ?? '',                    // rarity carries the parallel/chase signal
    image: card.images?.large ?? card.images?.small ?? null,
    language,
    external_ids: {
      ptcgdata: card.id,
      ptcgio: card.id,                             // same id — free pokemontcg.io linkage
      pcQuery: `${card.name} ${card.number} ${setName} pokemon`,
      ebayQuery: `pokemon ${card.name} ${number} ${setName}`,
    },
  };
}

/**
 * Fetch the full English Pokémon catalog (every set) from the vendored GitHub
 * source. Returns { rows, setCount, cardCount, rawSets, rawCards } — the raw
 * payloads are handed back so the seed can snapshot them verbatim (ownership).
 */
export async function fetchPokemonCatalog({ fetchImpl = fetch, concurrency = 8 } = {}) {
  const H = { 'User-Agent': 'Topload-catalog/1.0' };
  const sets = await fetchImpl(`${RAW}/sets/en.json`, { headers: H })
    .then(r => { if (!r.ok) throw new Error(`sets ${r.status}`); return r.json(); });
  const setsById = Object.fromEntries(sets.map(s => [s.id, s]));

  // Fetch each set's card file with bounded concurrency (174 files off the CDN).
  const rawCards = {};
  const queue = [...sets];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      const cards = await fetchImpl(`${RAW}/cards/en/${s.id}.json`, { headers: H })
        .then(r => { if (!r.ok) throw new Error(`cards ${s.id} ${r.status}`); return r.json(); });
      rawCards[s.id] = cards;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const rows = [];
  for (const [setId, cards] of Object.entries(rawCards))
    for (const c of cards) { const m = mapCard(c, setsById[setId]); if (m) rows.push(m); }

  return { rows, setCount: sets.length, cardCount: rows.length, rawSets: sets, rawCards };
}
