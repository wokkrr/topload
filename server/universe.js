/**
 * The tracked card universe. Rules-based baskets choose FROM this set; this
 * file only decides what we bother ingesting (storage/rate-limit scope, not
 * editorial index picks).
 *
 * PKMN: whole sets seeded from pokemontcg.io metadata (free), then filtered to
 * chase cards by rarity. OP: manual seed list — no free One Piece metadata API
 * worth depending on yet; entries carry their own PriceCharting search queries.
 */

export const PKMN_SETS = [
  { ptcgioId: 'sv3pt5', label: '151' },
  { ptcgioId: 'swsh7',  label: 'Evolving Skies' },
  { ptcgioId: 'swsh11', label: 'Lost Origin' },
  { ptcgioId: 'swsh12', label: 'Silver Tempest' },
  { ptcgioId: 'sv2',    label: 'Paldea Evolved' },
];

/** Rarities worth tracking (chase cards — the liquid end of the market). */
export const PKMN_RARITY_ALLOW = [
  'Special Illustration Rare', 'Illustration Rare', 'Hyper Rare',
  'Rare Secret', 'Rare Rainbow', 'Rare Ultra', 'Amazing Rare',
  'Rare Holo VMAX', 'Rare Holo V', 'Rare Holo VSTAR',
];

export const OP_CARDS = [
  { id: 'op-shanks-alt-op01-120',        name: 'Shanks (Alt Art)',         set_name: 'OP-01', number: 'OP01-120', pcQuery: 'shanks op01-120 alternate art one piece' },
  { id: 'op-luffy-alt-st01-012',         name: 'Monkey D. Luffy (Alt Art)',set_name: 'ST-01', number: 'ST01-012', pcQuery: 'monkey d luffy st01-012 alternate one piece' },
  { id: 'op-nami-alt-op01-016',          name: 'Nami (Alt Art)',           set_name: 'OP-01', number: 'OP01-016', pcQuery: 'nami op01-016 alternate art one piece' },
  { id: 'op-yamato-alt-op01-121',        name: 'Yamato (Alt Art)',         set_name: 'OP-01', number: 'OP01-121', pcQuery: 'yamato op01-121 alternate art one piece' },
  { id: 'op-zoro-manga-op06-118',        name: 'Zoro (Manga Art)',         set_name: 'OP-06', number: 'OP06-118', pcQuery: 'roronoa zoro op06-118 manga one piece' },
  { id: 'op-boa-hancock-alt-op07-051',   name: 'Boa Hancock (Alt)',        set_name: 'OP-07', number: 'OP07-051', pcQuery: 'boa hancock op07-051 alternate one piece' },
  { id: 'op-ace-alt-op02-013',           name: 'Portgas D. Ace (Alt Art)', set_name: 'OP-02', number: 'OP02-013', pcQuery: 'portgas d ace op02-013 alternate one piece' },
  { id: 'op-sabo-alt-op04-083',          name: 'Sabo (Alt Art)',           set_name: 'OP-04', number: 'OP04-083', pcQuery: 'sabo op04-083 alternate one piece' },
  { id: 'op-kaido-alt-op01-094',         name: 'Kaido (Alt Art)',          set_name: 'OP-01', number: 'OP01-094', pcQuery: 'kaido op01-094 alternate one piece' },
  { id: 'op-law-manga-op05-069',         name: 'Trafalgar Law (Manga)',    set_name: 'OP-05', number: 'OP05-069', pcQuery: 'trafalgar law op05-069 manga one piece' },
];

export function opCardRecords() {
  return OP_CARDS.map(c => ({
    id: c.id, ip: 'OP', name: c.name, set_name: c.set_name, number: c.number,
    variant: '', external_ids: { pcQuery: c.pcQuery },
  }));
}
