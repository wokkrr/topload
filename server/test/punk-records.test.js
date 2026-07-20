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

import { openDb } from '../db.js';
import { seedOnePiece } from '../seed-onepiece.js';

describe('seedOnePiece migration (FK-safe)', () => {
  it('re-points sales from old OP cards to canonical, purges the rest', () => {
    const db = openDb(':memory:');
    // old PC-derived OP card with an on-chain sale + a canonical card sharing the code
    db.prepare(`INSERT INTO cards (id, ip, name, number, external_ids) VALUES ('op-pc99','OP','Luffy Old','OP07-109','{}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, number, external_ids) VALUES ('op-pc-orphan','OP','No Sales','OP01-001','{}')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id)
                VALUES ('op-pc99','raw',5000,'USD','2026-07-01','mnstr','tx:1')`).run();
    const rows = [
      { id: 'op-op07-109', name: 'Monkey D. Luffy', set_name: 'One Piece 500 Years', number: 'OP07-109', variant: '', image: null, language: 'English', external_ids: { punkrecords: 'OP07-109' } },
    ];
    const res = seedOnePiece(db, rows);
    expect(res.seeded).toBe(1);
    // the sale re-pointed to the canonical card
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:1'`).get().card_id).toBe('op-op07-109');
    // orphan old card (no sales, not canonical) purged; old-with-sales purged after re-point
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id LIKE 'op-pc%'`).get().n).toBe(0);
    expect(res.salesRepointed).toBe(1);
  });
});
