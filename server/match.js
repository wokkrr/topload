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
  // A STRUCTURED number ("4/102", "OP07-109", "SWSH001") is distinctive enough
  // for a plain substring hit. A bare numeric ("4") is not — it hides inside
  // years ("2024") and other numbers, which mis-comped a remnant Charizard #4
  // over canonical 4/102 (live, 2026-07-20). Bare numerics only match via the
  // boundary/# path below.
  const numFullStrong = numFull && (numFull.includes('/') || /[a-z]/.test(numFull)) ? numFull : null;
  const numShort = stripZeros(numFull.split('/')[0] ?? '');
  const numShortRe = numShort ? new RegExp(`\\b${escRe(numShort)}\\b`) : null;
  // PriceCharting-derived remnant ids ("pkmn-pc7309838") yield to canonical
  // catalog cards on equal evidence — same physical card, one spine.
  const remnant = /^[a-z]+-pc\d+$/.test(card.id ?? '');
  // JP-exclusive parallel/reprint rows ("op-eb01-006_p4-ja") share their base
  // card's number — on equal evidence the BASE wins (listings that don't
  // distinguish an alt-art attribute conservatively to the base printing).
  const parallel = /_[pr]\d+(-ja)?$/.test(card.id ?? '');
  // Language-variant routing (Kaleb, 2026-07-20): EN and JA printings of the
  // same code are different MARKETS. Titles declare Japanese-ness explicitly
  // ("Pokemon Japanese …", "One Piece JPN …"); a mismatch between the title's
  // language and the row's language costs enough to lose any tie against the
  // right-language sibling, but not enough to block a match when only one
  // language variant exists (JP listing → EN row beats no attribution — the
  // pre-JA-pass status quo).
  const ja = (card.language ?? 'English') === 'Japanese';
  // One Piece-style split/concatenated forms ("Op07 … #109", "#OP02120"), and
  // no-separator promo codes ("SWSH285", "SVP077", "TG01") which titles write
  // as set words + a bare number ("Swsh Black Star Promo … #285").
  const op = /^([a-z]{1,3}\d{0,3})[\s-]([a-z]?\d{1,4})$/.exec(rawNum)
    ?? /^([a-z]{2,5})(\d{2,4})$/.exec(rawNum);
  const opc = op ? {
    prefix: op[1],                                   // "op07" / "swsh"
    prefixRe: new RegExp(`\\b${escRe(op[1])}`),      // word-start guard for the split form
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
  c = { name, nameRe, numFullStrong, numShort, numShortRe, op: opc, yg: ygc, remnant, parallel, ja };
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
  const titleJa = /\b(japanese|jpn|jp)\b/.test(title);
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
      (cc.numFullStrong && titleZ.includes(cc.numFullStrong)) ? 2 :
      (cc.numShort && (titleZ.includes(`#${cc.numShort}`) || cc.numShortRe.test(titleZ))) ? 1 : 0;

    // One Piece / set-prefixed numbers ("OP07-109"): marketplaces write these
    // split ("Op07-500 Years… #109") or concatenated ("#OP02120"), so the
    // contiguous "op07-109" never appears. Accept when the set prefix AND the
    // card-number suffix both hit. Set evidence (rule 3) still guards
    // against cross-set collisions.
    if (!numberHit && cc.op) {
      const { prefix, prefixRe, suffixRaw, suffixNoZero, suffixRe } = cc.op;
      const splitHit = title.includes(`#${suffixRaw}`)
        || titleZ.includes(`#${suffixNoZero}`)
        || suffixRe.test(titleZ);
      if (title.includes(prefix + suffixRaw)) numberHit = 2;         // "#op07015" / "swsh285"
      // Split form needs a DISTINCTIVE prefix: single letters are worthless
      // ('P' matched \bp inside 'piece'/'psa', gluing '#006' English listings
      // onto P-006 promo rows — live mis-tag, 2026-07-20). Real P-code
      // listings still match via the contiguous form above / numFullStrong.
      else if (prefix.length >= 2 && prefixRe.test(title) && splitHit) numberHit = 2;
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

    const score = numberHit + setHits * 2 + name.length / 100 - (cc.remnant ? 0.25 : 0) - (cc.parallel ? 0.1 : 0) - (titleJa !== cc.ja ? 0.6 : 0);
    if (score > bestScore) { best = card.id; bestScore = score; }
  }
  return best;
}

/** 'Umbreon VMAX (Alt Art)' → 'Umbreon VMAX' — parentheticals rarely appear in titles. */
function stripParen(name) {
  return name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Marketplace category string → franchise code, accent/punctuation-insensitive.
 * 'Pokémon' ≡ 'Pokemon'; 'Yu-Gi-Oh!' ≡ 'YuGiOh'; 'one_piece_english' ≡ 'One
 * Piece'. Seven hand-rolled maps drifted apart across indexers — rematch.js
 * lacked the accented spellings Courtyard emits, so its franchise-scoping
 * skipped (and thus NULLED) every Courtyard row on every run: the live 2%
 * Courtyard match-rate bug (2026-07-20). One shared mapper, no dialects.
 */
export function categoryToIp(category) {
  const k = (category ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  if (k.startsWith('pokemon')) return 'PKMN';
  if (k.startsWith('onepiece')) return 'OP';
  if (k.startsWith('yugioh')) return 'YGO';
  return null;
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
