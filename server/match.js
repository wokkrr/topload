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

// Dots become spaces so "Monkey.D.Luffy" ≡ "Monkey D. Luffy" (MNSTR writes
// One Piece names both ways). '#' and '/' are kept — they carry number meaning.
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9/#\s]/g, ' ').replace(/\s+/g, ' ').trim();

const SET_STOPWORDS = new Set([
  'pokemon', 'japanese', 'chinese', 'korean', 'card', 'cards', 'game', 'tcg',
  'one', 'piece', 'yugioh', 'yu', 'gi', 'oh', 'the', 'and', 'of', 'edition', 'set',
]);

const GRADE_RE = /\b(psa|cgc|bgs|sgc|beckett|ace)\s*[0-9]/;

const stripZeros = (s) => s.replace(/\b0+(\d)/g, '$1');

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Distinctive set evidence, compiled once per set name. Tokens must match as
 * WHOLE WORDS in the title — substring matching let 'poke' (Poke Card
 * Creator) hide inside 'pokemon' and 'on' (Town on No Map) inside anything,
 * which comped $35 promo Pikachus against a $10k Poke Card Creator Pikachu
 * (live counterexamples, 2026-07-20). The collapsed form ('op 01' → 'op01')
 * stays a substring test on the squashed title so hyphen/space variants hit.
 */
const EVIDENCE_CACHE = new Map();
function setEvidence(setName) {
  const key = setName ?? '';
  let ev = EVIDENCE_CACHE.get(key);
  if (ev) return ev;
  const n = norm(key);
  if (!n) { ev = { res: [], collapsed: null }; EVIDENCE_CACHE.set(key, ev); return ev; }
  const tokens = n.split(' ').filter(t => t.length >= 2 && !SET_STOPWORDS.has(t));
  const collapsed = n.replace(/[\s]/g, '');
  ev = {
    res: tokens.map(t => new RegExp(`\\b${escRe(t)}\\b`)),
    collapsed: collapsed.length >= 4 && tokens.length !== 1 ? collapsed : null,
  };
  EVIDENCE_CACHE.set(key, ev);
  return ev;
}

/**
 * Per-card compiled matching data, cached for the card object's lifetime.
 * A rematch/ingest runs the SAME universe rows against thousands of titles;
 * before this cache, every (listing × card) pair re-normalized strings and
 * constructed up to four RegExps — at 20k+ canonical cards per franchise that
 * ballooned into billions of regex compilations and pinned the droplet's CPU
 * long enough to drop SSH sessions (live incident, 2026-07-20). WeakMap keyed
 * on the row object: reused across calls, GC'd with the universe.
 */
const COMPILED = new WeakMap();
function compileCard(card) {
  let c = COMPILED.get(card);
  if (c) return c;
  const name = norm(stripParen(card.name ?? ''));
  const nameRe = name && name.length < 5 ? new RegExp(`(^|\\s)${escRe(name)}(\\s|$)`) : null;
  const rawNum = norm(card.number ?? '');
  const numFull = stripZeros(rawNum);
  const numShort = stripZeros(numFull.split('/')[0] ?? '');
  const numShortRe = numShort ? new RegExp(`\\b${escRe(numShort)}\\b`) : null;
  // One Piece-style split/concatenated forms ("Op07 … #109", "#OP02120").
  const op = /^([a-z]{1,3}\d{0,3})[\s-]([a-z]?\d{1,4})$/.exec(rawNum);
  const opc = op ? {
    prefix: op[1],                                   // "op07"
    suffixRaw: op[2],                                // "015" (padded)
    suffixNoZero: stripZeros(op[2]),                 // "15"
    suffixRe: new RegExp(`\\b${escRe(stripZeros(op[2]))}\\b`),
  } : null;
  // Regional-infix set codes (LOB-001 ≡ LOB-E001 ≡ LOB-EN001).
  const yg = /^([a-z]{2,5}\d{0,2})\s([a-z]{1,2})?(\d{2,4})$/.exec(rawNum);
  let ygc = null;
  if (yg) {
    const core = yg[3].replace(/^0+/, '') || yg[3];  // "001" → "1"
    ygc = {
      re: new RegExp(`\\b${escRe(yg[1])}[\\s-]?(?:[a-z]{1,2})?0*${core}\\b`),
      codeEvidence: yg[1].length >= 3,
    };
  }
  c = { name, nameRe, numFull, numShort, numShortRe, op: opc, yg: ygc };
  COMPILED.set(card, c);
  return c;
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
  const titleSquashed = title.replace(/\s/g, '');
  const gradeMatch = GRADE_RE.exec(title);
  const gradePos = gradeMatch ? gradeMatch.index : Infinity;

  let best = null, bestScore = 0;
  for (const card of cards) {
    const cc = compileCard(card);
    const name = cc.name;
    if (!name) continue;

    // 1. Name present — whole-word for short names — and BEFORE the grade.
    let nameIdx = -1;
    if (cc.nameRe) {
      const m = cc.nameRe.exec(title);
      nameIdx = m ? m.index + (m[1] ? 1 : 0) : -1;
    } else {
      nameIdx = title.indexOf(name);
    }
    if (nameIdx < 0 || nameIdx >= gradePos) continue;

    // 2. Collector number, zero-insensitive.
    let numberHit =
      (cc.numFull && titleZ.includes(cc.numFull)) ? 2 :
      (cc.numShort && (titleZ.includes(`#${cc.numShort}`) || cc.numShortRe.test(titleZ))) ? 1 : 0;

    // One Piece / set-prefixed numbers ("OP07-109"): marketplaces write these
    // split ("Op07-500 Years… #109") or concatenated ("#OP02120"), so the
    // contiguous "op07-109" never appears. Accept when the set prefix AND the
    // card-number suffix both hit. Set evidence (rule 3) still guards
    // against cross-set collisions.
    if (!numberHit && cc.op) {
      const { prefix, suffixRaw, suffixNoZero, suffixRe } = cc.op;
      const splitHit = title.includes(`#${suffixRaw}`)
        || titleZ.includes(`#${suffixNoZero}`)
        || suffixRe.test(titleZ);
      if (title.includes(prefix + suffixRaw)) numberHit = 2;         // "#op07015"
      else if (title.includes(prefix) && splitHit) numberHit = 2;    // "op07 … #109"
    }
    // Regional-infix set codes (LOB-001 ≡ LOB-E001 ≡ LOB-EN001): accept prefix
    // + digits with ANY (or no) 1–2 letter infix, zero-insensitive. A globally
    // unique ≥3-char code found in the title also stands as SET EVIDENCE
    // (graded YGO titles often carry the code but not the set name). Runs
    // regardless of which path matched the number.
    let codeEvidence = false;
    if (cc.yg && cc.yg.re.test(title)) {
      if (!numberHit) numberHit = 2;
      codeEvidence = cc.yg.codeEvidence;
    }
    if (!numberHit) continue;

    // 3. Set evidence — required whenever the card declares a set.
    const evidence = setEvidence(card.set_name);
    let setHits = 0;
    if (evidence.res.length || evidence.collapsed) {
      setHits = evidence.res.filter(re => re.test(title)).length
        + (evidence.collapsed && titleSquashed.includes(evidence.collapsed) ? 1 : 0);
      if (setHits === 0 && !codeEvidence) continue;
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
