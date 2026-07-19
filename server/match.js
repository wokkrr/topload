/**
 * Conservative listing→card matcher. A wrong match poisons a comp-delta, so we
 * only match when both the card name AND its collector number appear in the
 * listing title. Unmatched listings still display — just without a comp.
 */

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9/#\s.]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {string} itemName listing title, e.g. "2023 Pokemon 151 Charizard ex #199 PSA 10"
 * @param {{id:string, name:string, number:string|null, set_name:string|null}[]} cards tracked universe
 * @returns {string|null} card_id or null
 */
export function matchListing(itemName, cards) {
  const title = norm(itemName);
  if (!title) return null;
  let best = null, bestScore = 0;
  for (const card of cards) {
    const name = norm(stripParen(card.name ?? ''));
    if (!name || !title.includes(name)) continue;

    // Collector number: our format '199/165' — accept '199/165', '#199', ' 199 '.
    const numFull = norm(card.number ?? '');
    const numShort = numFull.split('/')[0];
    const numberHit =
      (numFull && title.includes(numFull)) ? 2 :
      (numShort && (title.includes(`#${numShort}`) || new RegExp(`\\b${numShort}\\b`).test(title))) ? 1 : 0;
    if (!numberHit) continue;

    const setHit = card.set_name && title.includes(norm(card.set_name)) ? 1 : 0;
    const score = numberHit + setHit + name.length / 100; // prefer longer (more specific) names
    if (score > bestScore) { best = card.id; bestScore = score; }
  }
  return best;
}

/** 'Umbreon VMAX (Alt Art)' → 'umbreon vmax' — parentheticals rarely appear in titles. */
function stripParen(name) {
  return name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Match a batch of listings; returns Map external_id → card_id. */
export function matchListings(listings, cards) {
  const m = new Map();
  for (const l of listings) {
    const id = matchListing(l.item_name, cards);
    if (id) m.set(l.external_id, id);
  }
  return m;
}
