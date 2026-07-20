/**
 * punk-records → canonical One Piece card catalog (the "Topload Card Database"
 * spine for OP). Source: github.com/buhbbl/punk-records — a static, versioned
 * JSON dataset generated FROM OFFICIAL Bandai sources (vegapull), multi-
 * language. We vendor it: import into OUR db + snapshot into seed/, so the
 * catalog is an asset we OWN, not a live dependency.
 *
 * The English index (english/index/cards_by_id.json, ~4,672 cards) is the
 * authoritative English catalog and — because One Piece card codes (OP07-109)
 * are universal across languages — it's also what English-text Japanese
 * listings match against. Japanese-printing records/tagging come in a later
 * pass; codes + English names carry the matching today.
 */

import { timedFetch } from '../net.js';

const RAW = 'https://raw.githubusercontent.com/buhbbl/punk-records/main';

/** Pure: one punk-records card + pack lookup → a Topload card record. */
export function mapCard(card, packsById, { language = 'English' } = {}) {
  const code = card.card_id;                       // 'OP07-109', 'P-001', 'ST01-004'
  if (!code || !card.name) return null;
  const pack = packsById?.[card.pack_id];
  const label = pack?.title_parts?.label;          // 'OP-07'
  const title = pack?.title_parts?.title;          // '500 Years in the Future'
  const set_name = title ? `One Piece ${title}` : label ? `One Piece ${label}` : 'One Piece';
  return {
    id: `op-${code.toLowerCase()}`,                // op-op07-109 (dedup-stable)
    ip: 'OP',
    name: card.name,
    set_name,
    number: code,                                  // universal OP code — the match key
    variant: (card.rarity ?? '') === 'Leader' ? 'Leader' : '',
    image: card.img_url ?? null,
    language,
    external_ids: { punkrecords: code, pack_id: card.pack_id ?? null },
  };
}

/** Fetch the English One Piece catalog (cards + packs) from the vendored source. */
/**
 * The 22 truly-Japanese-only cards (all promos, all famous characters) —
 * official romanized spellings matching the EN catalog's conventions.
 * Everything else in the JP catalog inherits its English name by code.
 * (Recon 2026-07-20: claude/JAPANESE_PASS.md.)
 */
export const JP_ONLY_NAMES = {
  'P-038': 'Trafalgar Law', 'P-040': 'Kaido', 'P-064': 'Kouzuki Momonosuke',
  'P-066': 'Boa Hancock', 'P-067': 'Eustass Kid', 'P-080': 'Monkey D. Luffy',
  'P-086': 'Trafalgar Law', 'P-087': 'Nico Robin', 'P-094': 'Roronoa Zoro',
  'P-095': 'Sanji', 'P-108': 'Monkey D. Luffy', 'P-109': 'Portgas D. Ace',
  'P-110': 'Monkey D. Luffy', 'P-114': 'Roronoa Zoro', 'P-116': 'Nico Robin',
  'P-118': 'Lilith', 'P-120': 'Sanji', 'P-121': 'Brook', 'P-150': 'Kuzan',
  'P-151': 'Smoker',
};

/**
 * Japanese pass — LANGUAGE-VARIANT ROWS (Kaleb, 2026-07-20): the same code in
 * English and Japanese is one card IDENTITY but two MARKETS — EN and JA
 * printings price differently (PriceCharting/Card Ladder model them as
 * separate products). Every JP printing therefore gets its own row:
 *
 *   id      op-<code>-ja           (sibling of the EN row; uniform -ja suffix)
 *   name    English, always — inherited by exact code, then base code, then
 *           JP_ONLY_NAMES. Unknown JP-only codes are SKIPPED, never guessed.
 *   number  base code (matchable; listings never write _p/_r suffixes)
 *   set     the EN pack title looked up by pack label (JP pack titles are
 *           kanji; display must read English)
 *   language 'Japanese' — drives matcher routing, filters, and the UI tag.
 *
 * Comps need no schema change: -ja rows accrue their own marks (JP
 * PriceCharting products merge into them via language routing) → own
 * latest_marks → correct JP comps.
 */
export function buildJapaneseRows(jpCards, jpPacks, enCards, enPacks) {
  // EN set titles keyed by NORMALIZED label ('OP-07' → 'OP07') — resolved from
  // the CARD CODE's set prefix, because JP pack metadata often lacks labels
  // (first dry run left -ja rows with bare set names, so EN siblings out-scored
  // them on set evidence and language routing lost the tie it should win).
  // EN sibling rows by code — -ja rows inherit the sibling's set_name so they
  // carry the SAME set-evidence discipline as English rows. Bare set names
  // exempted promo -ja rows from rule 3 and made them LESS conservative than
  // their EN siblings: an English "#006 … One Piece Promos" listing was
  // grabbed by op-p-006-ja (live mis-tag, 2026-07-20).
  const enRowByCode = new Map();
  const enRowByBase = new Map();
  for (const c of Object.values(enCards)) {
    const row = mapCard(c, enPacks, { language: 'English' });
    if (!row) continue;
    enRowByCode.set(c.card_id, row);
    const b = c.card_id.split('_')[0];
    if (!enRowByBase.has(b)) enRowByBase.set(b, row);
  }
  const rows = [];
  for (const c of Object.values(jpCards)) {
    const code = c.card_id;
    if (!code) continue;
    const base = code.split('_')[0];
    const sib = enRowByCode.get(code) ?? enRowByBase.get(base) ?? null;
    const name = sib?.name ?? JP_ONLY_NAMES[base] ?? null;
    if (!name) continue;                                 // unknown JP-only — surface via recon, never guess
    // Inherit the EN sibling's set_name (identical evidence rules for both
    // languages). The 22 JP-only promos have no sibling: explicit promo set —
    // conservative (may under-match odd promo phrasings; never mis-grabs).
    const set_name = sib?.set_name ?? 'One Piece Promotion Cards';
    const suffix = code.slice(base.length);              // '_p4' | '_r2' | ''
    rows.push({
      id: `op-${code.toLowerCase()}-ja`,
      ip: 'OP',
      name,
      set_name,
      number: base,
      variant: suffix ? `JP ${suffix.startsWith('_r') ? 'reprint' : 'parallel'} ${suffix.slice(1)}` : '',
      image: c.img_url ?? null,
      language: 'Japanese',
      external_ids: { punkrecords_ja: code, pack_id: c.pack_id ?? null },
    });
  }
  return rows;
}

export async function fetchOnePieceCatalog({ lang = 'english', fetchImpl = timedFetch } = {}) {
  const [cards, packs] = await Promise.all([
    fetchImpl(`${RAW}/${lang}/index/cards_by_id.json`).then(r => { if (!r.ok) throw new Error(`cards ${r.status}`); return r.json(); }),
    fetchImpl(`${RAW}/${lang}/packs.json`).then(r => { if (!r.ok) throw new Error(`packs ${r.status}`); return r.json(); }),
  ]);
  const language = lang === 'japanese' ? 'Japanese' : lang.startsWith('chinese') ? 'Chinese' : 'English';
  const rows = Object.values(cards).map(c => mapCard(c, packs, { language })).filter(Boolean);
  return { rows, cardCount: Object.keys(cards).length, packCount: Object.keys(packs).length };
}
