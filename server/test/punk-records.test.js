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

import { buildJapaneseRows, JP_ONLY_NAMES } from '../adapters/punk-records.js';
import { matchListing } from '../match.js';

describe('Japanese pass: buildJapaneseRows (recon 2026-07-20)', () => {
  const jpPacks = { '9': { title_parts: { label: 'P', title: 'Promotion Cards' } } };
  const enCards = {
    'EB01-006': { card_id: 'EB01-006', name: 'Nami', pack_id: 'x' },
  };
  it('emits JP-exclusive parallels with the inherited English name and base-code number', () => {
    const jp = { 'EB01-006_p4': { card_id: 'EB01-006_p4', name: 'ナミ', pack_id: '9', img_url: 'https://x/p4.png' } };
    const [r] = buildJapaneseRows(jp, jpPacks, enCards);
    expect(r.id).toBe('op-eb01-006_p4');
    expect(r.name).toBe('Nami');                 // inherited, never kanji
    expect(r.number).toBe('EB01-006');           // base code = matchable
    expect(r.variant).toBe('JP parallel p4');
    expect(r.language).toBe('Japanese');
  });
  it('emits the 22 JP-only promos with romanized names; skips shared codes and unknowns', () => {
    const jp = {
      'P-080': { card_id: 'P-080', name: 'モンキー・D・ルフィ', pack_id: '9' },
      'EB01-006': { card_id: 'EB01-006', name: 'ナミ', pack_id: '9' },       // shared → skipped
      'P-999': { card_id: 'P-999', name: '謎のカード', pack_id: '9' },       // unknown → skipped, never guessed
    };
    const rows = buildJapaneseRows(jp, jpPacks, enCards);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Monkey D. Luffy');
    expect(rows[0].variant).toBe('JP promo');
    expect(Object.keys(JP_ONLY_NAMES).length).toBe(20); // 22 cards, 20 distinct base codes
  });
  it('parallel rows yield to the base card on equal match evidence', () => {
    const universe = [
      { id: 'op-eb01-006_p4', name: 'Nami', number: 'EB01-006', set_name: 'One Piece Promotion Cards' },
      { id: 'op-eb01-006', name: 'Nami', number: 'EB01-006', set_name: 'One Piece Promotion Cards' },
    ];
    expect(matchListing('One Piece Promotion Cards Nami EB01-006 PSA 10', universe)).toBe('op-eb01-006');
  });
});
