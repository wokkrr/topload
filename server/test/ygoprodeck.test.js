import { describe, it, expect } from 'vitest';
import { mapCard } from '../adapters/ygoprodeck-catalog.js';

// Fixture in YGOPRODeck cardinfo.php shape (verify against live samples on the
// first server run — the seed prints them).
const blueEyes = {
  id: 89631139,
  name: 'Blue-Eyes White Dragon',
  type: 'Normal Monster',
  race: 'Dragon',
  card_sets: [
    { set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB-001', set_rarity: 'Ultra Rare' },
    { set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB-EN001', set_rarity: 'Ultra Rare' },
    { set_name: 'Starter Deck: Kaiba Reloaded', set_code: 'YSKR-EN001', set_rarity: 'Common' },
    { set_name: 'Starter Deck: Kaiba Reloaded', set_code: 'YSKR-EN001', set_rarity: 'Ultimate Rare' },
  ],
  card_images: [{ image_url: 'https://images.ygoprodeck.com/images/cards/89631139.jpg' }],
};

describe('ygoprodeck mapCard (printing explosion)', () => {
  it('explodes one card into one row per EN printing, dedup by set_code', () => {
    const rows = mapCard(blueEyes);
    expect(rows.length).toBe(3); // LOB-001, LOB-EN001, YSKR-EN001 (merged rarities)
    const lob = rows.find(r => r.number === 'LOB-001');
    expect(lob.id).toBe('ygo-lob-001');
    expect(lob.ip).toBe('YGO');
    expect(lob.name).toBe('Blue-Eyes White Dragon');
    expect(lob.set_name).toBe('Legend of Blue Eyes White Dragon');
    expect(lob.variant).toBe('Ultra Rare');
    expect(lob.language).toBe('English');
    expect(lob.external_ids.ygoprodeck).toBe('89631139');
  });
  it('merges multi-rarity printings of the same set_code into variant', () => {
    const yskr = mapCard(blueEyes).find(r => r.number === 'YSKR-EN001');
    expect(yskr.variant).toBe('Common/Ultimate Rare');
  });
  it('falls back to constructed image URL and skips cards with no printings', () => {
    const rows = mapCard({ id: 5, name: 'X', card_sets: [{ set_code: 'ABC-EN001', set_name: 'S' }] });
    expect(rows[0].image).toBe('https://images.ygoprodeck.com/images/cards/5.jpg');
    expect(mapCard({ id: 6, name: 'OCG Only' })).toEqual([]);
    expect(mapCard({ id: 7, name: 'Empty Sets', card_sets: [] })).toEqual([]);
  });
});

import { openDb } from '../db.js';
import { seedYugioh } from '../seed-yugioh.js';

describe('seedYugioh migration (FK-safe)', () => {
  it('re-points sales via regional-infix matching, purges orphans, keeps unmatched-with-sales', () => {
    const db = openDb(':memory:');
    // Old PC card written regionless ("LOB-001") WITH a sale; canonical is LOB-EN001-style.
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('ygo-pc42','YGO','Blue-Eyes White Dragon','LOB-001','YuGiOh Legend of Blue Eyes','{"pricecharting":"42"}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('ygo-pc-orphan','YGO','Kuriboh','MRD-071','YuGiOh Metal Raiders','{}')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id) VALUES ('ygo-pc42','PSA9',250000,'USD','2026-07-01','mnstr','tx:9')`).run();

    const rows = mapCard(blueEyes);
    const res = seedYugioh(db, rows);
    expect(res.seeded).toBe(3);
    // Sale re-pointed onto a canonical printing (regionless LOB-001 exists as its own canonical row here).
    const saleCard = db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:9'`).get().card_id;
    expect(saleCard.startsWith('ygo-lob-')).toBe(true);
    expect(res.salesRepointed).toBe(1);
    // Orphan purged; old card gone after re-point freed it.
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id LIKE 'ygo-pc%'`).get().n).toBe(0);
  });

  it('upsert-only mode touches nothing but canonical', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('ygo-pc42','YGO','Old Card','XXX-001','Some Set','{}')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id) VALUES ('ygo-pc42','raw',100,'USD','2026-07-01','mnstr','tx:1')`).run();
    const res = seedYugioh(db, mapCard(blueEyes), { migrate: false });
    expect(res.mode).toBe('upsert-only');
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='ygo-pc42'`).get().n).toBe(1);
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:1'`).get().card_id).toBe('ygo-pc42');
  });
});
