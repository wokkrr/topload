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
 * Japanese pass: from the JP catalog, emit ONLY the rows the EN catalog lacks
 * — JP-exclusive parallels (`_p`/`_r` suffixed codes whose base exists in EN;
 * English name inherited from the base) and the 22 JP-only promos (names from
 * JP_ONLY_NAMES). Shared codes are the SAME card and get no duplicate row
 * (Kaleb's display model: one canonical card; "· Japanese" is a listing-level
 * tag). `number` is the BASE code so the matcher can hit it; parallels yield
 * to the base card on score ties (match.js parallel penalty) so listings that
 * don't distinguish an alt-art attribute conservatively to the base.
 */
export function buildJapaneseRows(jpCards, jpPacks, enCards) {
  const enCodes = new Set(Object.values(enCards).map(c => c.card_id));
  const enNameByBase = new Map();
  for (const c of Object.values(enCards)) {
    const base = c.card_id.split('_')[0];
    if (!enNameByBase.has(base)) enNameByBase.set(base, c.name);
  }
  const rows = [];
  for (const c of Object.values(jpCards)) {
    const code = c.card_id;
    if (!code || enCodes.has(code)) continue;            // shared identity — no duplicate row
    const base = code.split('_')[0];
    const name = enNameByBase.get(base) ?? JP_ONLY_NAMES[base] ?? null;
    if (!name) continue;                                 // unknown JP-only card — surface via recon, never guess
    const suffix = code.slice(base.length);              // '_p4' | '_r2' | ''
    const mapped = mapCard({ ...c, name }, jpPacks, { language: 'Japanese' });
    if (!mapped) continue;
    mapped.number = base;                                // matchable; full code stays in external_ids
    mapped.variant = suffix
      ? `JP ${suffix.startsWith('_r') ? 'reprint' : 'parallel'} ${suffix.slice(1)}`
      : (mapped.variant || 'JP promo');
    rows.push(mapped);
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
