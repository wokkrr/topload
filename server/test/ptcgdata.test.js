import { describe, it, expect } from 'vitest';
import { mapCard } from '../adapters/ptcgdata.js';

const set = { id: 'base1', name: 'Base', printedTotal: 102, total: 102, series: 'Base' };

describe('ptcgdata mapCard', () => {
  it('maps a standard card with collector number = number/printedTotal', () => {
    const r = mapCard({ id: 'base1-4', name: 'Charizard', number: '4', rarity: 'Rare Holo', images: { large: 'https://x/base1-4.png' } }, set);
    expect(r.id).toBe('pkmn-base1-4');
    expect(r.ip).toBe('PKMN');
    expect(r.name).toBe('Charizard');
    expect(r.number).toBe('4/102');
    expect(r.set_name).toBe('Base');
    expect(r.variant).toBe('Rare Holo');
    expect(r.language).toBe('English');
    expect(r.external_ids.ptcgdata).toBe('base1-4');
    expect(r.external_ids.ptcgio).toBe('base1-4');
  });
  it('keeps alnum promo/subset numbers without a denominator', () => {
    const r = mapCard({ id: 'swshp-SWSH001', name: 'Pikachu', number: 'SWSH001', images: {} }, { id: 'swshp', name: 'SWSH Black Star Promos' });
    expect(r.number).toBe('SWSH001');
  });
  it('falls back to small image and tags language', () => {
    const r = mapCard({ id: 'base1-5', name: 'Ninetales', number: '5', images: { small: 'https://x/s.png' } }, set, { language: 'Japanese' });
    expect(r.image).toBe('https://x/s.png');
    expect(r.language).toBe('Japanese');
  });
  it('drops rows missing id or name', () => {
    expect(mapCard({ id: null, name: 'x' }, set)).toBeNull();
    expect(mapCard({ id: 'base1-1', name: null }, set)).toBeNull();
  });
});

import { openDb } from '../db.js';
import { seedPokemon } from '../seed-pokemon.js';

describe('seedPokemon migration (FK-safe)', () => {
  it('re-points sales from an old PC card to canonical, purges orphans, keeps unmatched-with-sales', () => {
    const db = openDb(':memory:');
    // Old PriceCharting-style card ("#4", set "Pokemon Base Set") WITH a sale.
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc7','PKMN','Charizard','4','Pokemon Base Set','{"pricecharting":"7"}')`).run();
    // Old orphan card (no sales) — should be purged.
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc-orphan','PKMN','Pidgey','16','Pokemon Base Set','{}')`).run();
    // Old card with a sale that WON'T match any canonical — must be kept (FK-safe).
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc-nomatch','PKMN','Mystery Promo','999','Unknown Set','{}')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id) VALUES ('pkmn-pc7','raw',500000,'USD','2026-07-01','mnstr','tx:1')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id) VALUES ('pkmn-pc-nomatch','raw',100,'USD','2026-07-02','mnstr','tx:2')`).run();

    const rows = [
      { id: 'pkmn-base1-4', name: 'Charizard', set_name: 'Base', number: '4/102', variant: 'Rare Holo', image: null, language: 'English', external_ids: { ptcgdata: 'base1-4', ptcgio: 'base1-4' } },
    ];
    const res = seedPokemon(db, rows);
    expect(res.seeded).toBe(1);
    // Charizard sale re-pointed onto the canonical card.
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:1'`).get().card_id).toBe('pkmn-base1-4');
    expect(res.salesRepointed).toBe(1);
    // Orphan (no sales) purged; the unmatched-with-sales card kept (never a FK crash).
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='pkmn-pc-orphan'`).get().n).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='pkmn-pc-nomatch'`).get().n).toBe(1);
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:2'`).get().card_id).toBe('pkmn-pc-nomatch');
  });
});
