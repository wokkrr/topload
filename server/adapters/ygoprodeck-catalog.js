/**
 * YGOPRODeck → canonical Yu-Gi-Oh card catalog (the "Topload Card Database"
 * spine for YGO). Source: db.ygoprodeck.com/api/v7/cardinfo.php — the full
 * dump, free, no key, updated on set release day, with per-printing `card_sets`
 * (set_code "LOB-EN001" — the printing identity graded listings carry).
 *
 * Vendoring note: unlike OP (punk-records) and PKMN (pokemon-tcg-data), there
 * is NO maintained GitHub mirror of this data (checked 2026-07-20; yaml-yugi's
 * TCG set data stalled at The Infinite Forbidden, July 2024 — two years stale,
 * fails the up-to-date bar; it stays useful later for ja_romaji names). So the
 * fetch happens where egress is open (the droplet), and the seed writes the
 * slimmed snapshot (seed/yugioh-catalog.json) which gets COMMITTED — after the
 * first server run, the catalog is ours like the others.
 *
 * YGO model: one Topload card per English PRINTING (card × set_code), because
 * a name spans wildly different values across printings (LOB-001 Blue-Eyes vs
 * a 2020s reprint). The set code is the number AND, being globally unique,
 * doubles as set evidence in the matcher (regional infix tolerated:
 * LOB-001 ≡ LOB-E001 ≡ LOB-EN001).
 */

const API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';

/**
 * Pure: one YGOPRODeck card object → Topload card records (one per EN printing).
 * Duplicate set_codes within a card (multi-rarity printings, catalog quirks)
 * are merged: rarities joined into variant, first set_name kept.
 */
export function mapCard(card, { language = 'English' } = {}) {
  if (!card?.name || !Array.isArray(card.card_sets) || card.card_sets.length === 0) return [];
  const image = card.card_images?.[0]?.image_url
    ?? (card.id ? `https://images.ygoprodeck.com/images/cards/${card.id}.jpg` : null);
  const byCode = new Map();
  for (const s of card.card_sets) {
    const code = (s?.set_code ?? '').trim();
    if (!code) continue;
    const prev = byCode.get(code.toUpperCase());
    if (prev) {
      if (s.set_rarity && !prev.rarities.includes(s.set_rarity)) prev.rarities.push(s.set_rarity);
    } else {
      byCode.set(code.toUpperCase(), { code, set_name: s.set_name ?? '', rarities: s.set_rarity ? [s.set_rarity] : [] });
    }
  }
  const out = [];
  for (const p of byCode.values()) {
    out.push({
      id: `ygo-${p.code.toLowerCase()}`,          // ygo-lob-en001 (dedup-stable printing id)
      ip: 'YGO',
      name: card.name,
      set_name: p.set_name,
      number: p.code,                              // the printing identity = the match key
      variant: p.rarities.join('/'),
      image,
      language,
      external_ids: { ygoprodeck: String(card.id ?? ''), konami_id: card.misc_info?.[0]?.konami_id ?? null },
    });
  }
  return out;
}

/**
 * Fetch the full Yu-Gi-Oh catalog. Returns { rows, cardCount, printingCount,
 * rawCards } — rawCards pre-slimmed for the committed snapshot (ownership).
 * NOTE: ~13k cards / tens of MB; run with --max-old-space-size on small boxes.
 */
export async function fetchYugiohCatalog({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API, { headers: { 'User-Agent': 'Topload-catalog/1.0' } });
  if (!res.ok) throw new Error(`ygoprodeck ${res.status}`);
  const body = await res.json();
  const cards = body?.data;
  if (!Array.isArray(cards)) throw new Error('ygoprodeck: unexpected shape (no data array)');

  // Slim to catalog fields for the snapshot — drop desc/atk/def/prices/etc.
  const rawCards = cards.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    race: c.race,
    attribute: c.attribute,
    card_sets: (c.card_sets ?? []).map(s => ({ set_code: s.set_code, set_name: s.set_name, set_rarity: s.set_rarity })),
    image_url: c.card_images?.[0]?.image_url ?? null,
  }));

  const rows = [];
  for (const c of rawCards) rows.push(...mapCard({ ...c, card_images: c.image_url ? [{ image_url: c.image_url }] : [] }));
  return { rows, cardCount: cards.length, printingCount: rows.length, rawCards };
}
