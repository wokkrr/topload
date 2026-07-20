import { describe, it, expect } from 'vitest';
import { mapCard } from '../adapters/punk-records.js';

const packs = {
  '569207': { id: '569207', raw_title: '-500 YEARS IN THE FUTURE- [OP-07]', title_parts: { label: 'OP-07', prefix: 'BOOSTER', title: '500 Years in the Future' } },
  '569001': { id: '569001', title_parts: { label: 'ST-01', prefix: 'STARTER DECK', title: 'Straw Hat Crew' } },
};

describe('punk-records mapCard', () => {
  it('maps a card with universal OP code, name, set, image', () => {
    const r = mapCard({ card_id: 'OP07-109', name: 'Monkey D. Luffy', pack_id: '569207', img_url: 'https://x/OP07-109.png', rarity: 'SR' }, packs);
    expect(r.id).toBe('op-op07-109');
    expect(r.ip).toBe('OP');
    expect(r.name).toBe('Monkey D. Luffy');
    expect(r.number).toBe('OP07-109');
    expect(r.set_name).toBe('One Piece 500 Years in the Future');
    expect(r.language).toBe('English');
    expect(r.external_ids.punkrecords).toBe('OP07-109');
  });
  it('handles promos (P-prefix) and starter decks', () => {
    expect(mapCard({ card_id: 'P-001', name: 'Shanks', pack_id: 'x' }, packs).id).toBe('op-p-001');
    expect(mapCard({ card_id: 'ST01-004', name: 'Zoro', pack_id: '569001' }, packs).set_name).toBe('One Piece Straw Hat Crew');
  });
  it('tags language for Japanese/Chinese imports', () => {
    expect(mapCard({ card_id: 'OP07-109', name: 'Luffy', pack_id: '569207' }, packs, { language: 'Japanese' }).language).toBe('Japanese');
  });
  it('drops rows missing code or name', () => {
    expect(mapCard({ card_id: null, name: 'x' }, packs)).toBeNull();
    expect(mapCard({ card_id: 'OP07-109', name: null }, packs)).toBeNull();
  });
});
