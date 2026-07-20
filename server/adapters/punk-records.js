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
export async function fetchOnePieceCatalog({ lang = 'english', fetchImpl = fetch } = {}) {
  const [cards, packs] = await Promise.all([
    fetchImpl(`${RAW}/${lang}/index/cards_by_id.json`).then(r => { if (!r.ok) throw new Error(`cards ${r.status}`); return r.json(); }),
    fetchImpl(`${RAW}/${lang}/packs.json`).then(r => { if (!r.ok) throw new Error(`packs ${r.status}`); return r.json(); }),
  ]);
  const language = lang === 'japanese' ? 'Japanese' : lang.startsWith('chinese') ? 'Chinese' : 'English';
  const rows = Object.values(cards).map(c => mapCard(c, packs, { language })).filter(Boolean);
  return { rows, cardCount: Object.keys(cards).length, packCount: Object.keys(packs).length };
}
