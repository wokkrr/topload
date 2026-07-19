/**
 * Conservative listing→card matcher. A wrong match poisons a comp-delta (and,
 * worse, a sale attribution), so matching errs hard toward "no match":
 *
 *  1. The card's name must appear in the title BEFORE any grade token —
 *     deck/lot names after the grade ("... PSA 10 Charizard EX Deck") must
 *     never match the deck's namesake.
 *  2. The collector number must appear (zero-insensitive: #011 ≡ 11).
 *  3. If the card has a set, the title must carry distinctive set evidence —
 *     name+number collide across sets constantly (Pikachu #51 exists in
 *     dozens); without set evidence the honest answer is no comp.
 *
 * Live counterexamples that shaped these rules (2026-07-19): $5 Electrode
 * comped as $7,730 Charizard via deck name; $450 Celebrations Umbreon Gold
 * Star comped as the $107k 2005 original; $75 novelty Mew comped at $90k.
 */

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9/#\s.]/g, ' ').replace(/\s+/g, ' ').trim();

const SET_STOPWORDS = new Set([
  'pokemon', 'japanese', 'chinese', 'korean', 'card', 'cards', 'game', 'tcg',
  'one', 'piece', 'yugioh', 'yu', 'gi', 'oh', 'the', 'and', 'of', 'edition', 'set',
]);

const GRADE_RE = /\b(psa|cgc|bgs|sgc|beckett|ace)\s*[0-9]/;

const stripZeros = (s) => s.replace(/\b0+(\d)/g, '$1');

/** Distinctive set tokens + collapsed variant ('op-01' → 'op01'). */
function setEvidence(setName) {
  const n = norm(setName ?? '');
  if (!n) return [];
  const tokens = n.split(' ').filter(t => t.length >= 2 && !SET_STOPWORDS.has(t));
  const collapsed = n.replace(/[\s]/g, '');
  const out = [...tokens];
  if (collapsed.length >= 4 && tokens.length !== 1) out.push(collapsed);
  return out;
}

/**
 * @param {string} itemName listing title
 * @param {{id:string, name:string, number:string|null, set_name:string|null}[]} cards tracked universe
 * @returns {string|null} card_id or null
 */
export function matchListing(itemName, cards) {
  const title = norm(itemName);
  if (!title) return null;
  const titleZ = stripZeros(title);
  const gradeMatch = GRADE_RE.exec(title);
  const gradePos = gradeMatch ? gradeMatch.index : Infinity;

  let best = null, bestScore = 0;
  for (const card of cards) {
    const name = norm(stripParen(card.name ?? ''));
    if (!name) continue;

    // 1. Name present — whole-word for short names — and BEFORE the grade.
    let nameIdx = -1;
    if (name.length < 5) {
      const m = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).exec(title);
      nameIdx = m ? m.index + (m[1] ? 1 : 0) : -1;
    } else {
      nameIdx = title.indexOf(name);
    }
    if (nameIdx < 0 || nameIdx >= gradePos) continue;

    // 2. Collector number, zero-insensitive: full form, '#N', or word-bounded N.
    const numFull = stripZeros(norm(card.number ?? ''));
    const numShort = stripZeros(numFull.split('/')[0] ?? '');
    const numberHit =
      (numFull && titleZ.includes(numFull)) ? 2 :
      (numShort && (titleZ.includes(`#${numShort}`) || new RegExp(`\\b${numShort}\\b`).test(titleZ))) ? 1 : 0;
    if (!numberHit) continue;

    // 3. Set evidence — required whenever the card declares a set.
    const evidence = setEvidence(card.set_name);
    let setHits = 0;
    if (evidence.length) {
      setHits = evidence.filter(t => title.includes(t)).length;
      if (setHits === 0) continue;
    }

    const score = numberHit + setHits * 2 + name.length / 100;
    if (score > bestScore) { best = card.id; bestScore = score; }
  }
  return best;
}

/** 'Umbreon VMAX (Alt Art)' → 'Umbreon VMAX' — parentheticals rarely appear in titles. */
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
