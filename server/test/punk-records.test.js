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

describe('Japanese pass: language-variant rows (Kaleb, 2026-07-20)', () => {
  const jpPacks = { '9': { title_parts: { label: 'EB-01', title: 'メモリアルコレクション' } } };
  const enPacks = { '8': { title_parts: { label: 'EB-01', title: 'MEMORIAL COLLECTION' } } };
  const enCards = { 'EB01-006': { card_id: 'EB01-006', name: 'Nami', pack_id: '8' } };

  it('every JP printing gets a -ja sibling row: shared code, parallel, promo', () => {
    const jp = {
      'EB01-006': { card_id: 'EB01-006', name: 'ナミ', pack_id: '9', img_url: 'https://x/a.png' },
      'EB01-006_p4': { card_id: 'EB01-006_p4', name: 'ナミ', pack_id: '9', img_url: 'https://x/p4.png' },
      'P-080': { card_id: 'P-080', name: 'モンキー・D・ルフィ', pack_id: '9' },
      'P-999': { card_id: 'P-999', name: '謎のカード', pack_id: '9' },     // unknown → skipped, never guessed
    };
    const rows = buildJapaneseRows(jp, jpPacks, enCards, enPacks);
    expect(rows.length).toBe(3);
    const shared = rows.find(r => r.id === 'op-eb01-006-ja');
    expect(shared.name).toBe('Nami');                    // inherited, never kanji
    expect(shared.number).toBe('EB01-006');
    expect(shared.set_name).toBe('One Piece MEMORIAL COLLECTION'); // EN pack title via label
    expect(shared.language).toBe('Japanese');
    const par = rows.find(r => r.id === 'op-eb01-006_p4-ja');
    expect(par.variant).toBe('JP parallel p4');
    expect(par.number).toBe('EB01-006');
    const promo = rows.find(r => r.id === 'op-p-080-ja');
    expect(promo.name).toBe('Monkey D. Luffy');
    expect(Object.keys(JP_ONLY_NAMES).length).toBe(20);  // 22 cards, 20 distinct base codes
  });

  it('language routing: a Japanese-titled listing matches the -ja sibling; plain matches EN', () => {
    const universe = [
      { id: 'op-eb01-006', name: 'Nami', number: 'EB01-006', set_name: 'One Piece MEMORIAL COLLECTION', language: 'English' },
      { id: 'op-eb01-006-ja', name: 'Nami', number: 'EB01-006', set_name: 'One Piece MEMORIAL COLLECTION', language: 'Japanese' },
    ];
    expect(matchListing('2024 One Piece Japanese Memorial Collection Nami EB01-006 PSA 10', universe))
      .toBe('op-eb01-006-ja');
    expect(matchListing('2024 One Piece Memorial Collection Nami EB01-006 PSA 10', universe))
      .toBe('op-eb01-006');
  });

  it('a JP-titled listing still matches an EN row when no -ja sibling exists (pre-pass status quo)', () => {
    const universe = [
      { id: 'op-eb01-006', name: 'Nami', number: 'EB01-006', set_name: 'One Piece MEMORIAL COLLECTION', language: 'English' },
    ];
    expect(matchListing('One Piece Japanese Memorial Collection Nami EB01-006 PSA 10', universe))
      .toBe('op-eb01-006');
  });

  it('parallel -ja rows yield to the plain -ja sibling on equal evidence', () => {
    const universe = [
      { id: 'op-eb01-006_p4-ja', name: 'Nami', number: 'EB01-006', set_name: 'One Piece MEMORIAL COLLECTION', language: 'Japanese' },
      { id: 'op-eb01-006-ja', name: 'Nami', number: 'EB01-006', set_name: 'One Piece MEMORIAL COLLECTION', language: 'Japanese' },
    ];
    expect(matchListing('One Piece Japanese Memorial Collection Nami EB01-006 PSA 10', universe))
      .toBe('op-eb01-006-ja');
  });
});

describe('EN listings must never be grabbed by -ja promo rows (live mis-tag, 2026-07-20)', () => {
  it('bare "#006 … One Piece Promos" English title refuses the P-006 -ja row', () => {
    const universe = [
      { id: 'op-p-006-ja', name: 'Monkey D. Luffy', number: 'P-006', set_name: 'One Piece Luffy 7 vol.1', language: 'Japanese' },
    ];
    // 'P' is a 1-char prefix: split-form number matching must not fire off
    // \b p inside 'piece'/'psa'; set evidence must also be required.
    expect(matchListing('2024 #006 Monkey D. Luffy PSA 10 One Piece Promos', universe)).toBeNull();
  });
  it('a real contiguous P-code listing still matches', () => {
    const universe = [
      { id: 'op-p-006-ja', name: 'Monkey D. Luffy', number: 'P-006', set_name: 'One Piece Luffy 7 vol.1', language: 'Japanese' },
    ];
    expect(matchListing('One Piece Japanese Luffy 7 vol.1 Monkey D. Luffy P-006 PSA 10', universe)).toBe('op-p-006-ja');
  });
});

describe('exact P-code = set evidence (promo pack names never appear in titles)', () => {
  const universe = [
    { id: 'op-p-006', name: 'Monkey D. Luffy', number: 'P-006', set_name: 'One Piece Luffy 7 vol.1', language: 'English' },
    { id: 'op-p-006-ja', name: 'Monkey D. Luffy', number: 'P-006', set_name: 'One Piece Luffy 7 vol.1', language: 'Japanese' },
  ];
  it('routes real promo listings by language when the full code is present', () => {
    expect(matchListing('2023 One Piece Japanese Promos Monkey.D.Luffy P-006 PSA 10', universe)).toBe('op-p-006-ja');
    expect(matchListing('2023 One Piece Promo Monkey D. Luffy P-006 PSA 10', universe)).toBe('op-p-006');
  });
  it('still refuses the bare-number shape that caused the mis-tag', () => {
    expect(matchListing('2024 #006 Monkey D. Luffy PSA 10 One Piece Promos', universe)).toBeNull();
  });
});

import { tagLanguages } from '../seed-language-tags.js';

describe('language-tag migration (JP Pokémon/YGO via PC satellites)', () => {
  it('tags Japanese/Chinese satellites by set name, leaves English alone, idempotent', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc1','PKMN','Aroma Lady','86','Pokemon Japanese Eevee Heroes','{}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc2','PKMN','Ponyta','1','Pokemon Chinese Gem Pack','{}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-base1-4','PKMN','Charizard','4/102','Base','{}')`).run();
    const r1 = tagLanguages(db);
    expect(r1.Japanese).toBe(1);
    expect(r1.Chinese).toBe(1);
    expect(db.prepare(`SELECT language FROM cards WHERE id='pkmn-pc1'`).get().language).toBe('Japanese');
    expect(db.prepare(`SELECT language FROM cards WHERE id='pkmn-base1-4'`).get().language).toBe('English');
    const r2 = tagLanguages(db);
    expect(r2.Japanese).toBe(0);    // idempotent
  });

  it('after tagging, language routing steers JP Pokémon listings to the satellite (with its comps)', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, external_ids) VALUES ('pkmn-pc1','PKMN','Aroma Lady','86','Pokemon Japanese Eevee Heroes','{}')`).run();
    tagLanguages(db);
    const uni = db.prepare(`SELECT id, name, number, set_name, language FROM cards`).all();
    expect(matchListing('2021 Pokemon Japanese Eevee Heroes #086 Aroma Lady PSA 10', uni)).toBe('pkmn-pc1');
  });
});

import { mopupOpSatellites } from '../mopup-op-satellites.js';

describe('JA-3: OP satellite mop-up (marks/sales/pc → canonical, retire satellite)', () => {
  const setup = () => {
    const db = openDb(':memory:');
    // canonical EN + JA siblings
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, language, external_ids) VALUES
      ('op-op02-120','OP','Uta','OP02-120','One Piece PARAMOUNT WAR','English','{"punkrecords":"OP02-120"}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, language, external_ids) VALUES
      ('op-op02-120-ja','OP','Uta','OP02-120','One Piece PARAMOUNT WAR','Japanese','{"punkrecords_ja":"OP02-120"}')`).run();
    // JP satellite with marks + a sale + a listing pointer
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, language, external_ids) VALUES
      ('op-pc555','OP','Uta','OP02-120','One Piece Japanese Paramount War','Japanese','{"pricecharting":"555"}')`).run();
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting','op-pc555','PSA10','2026-07-20',48000)`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, currency, sold_at, source, external_id) VALUES ('op-pc555','PSA10',45000,'USD','2026-07-01','mnstr','tx:m1')`).run();
    db.prepare(`INSERT INTO gacha_listings (platform, external_id, card_id, item_name, category, price_cents, currency, seen_at) VALUES ('mnstr','L9','op-pc555','x','One Piece',50000,'USDm',1721000000)`).run();
    // unmatched satellite (odd set) — must be KEPT
    db.prepare(`INSERT INTO cards (id, ip, name, number, set_name, language, external_ids) VALUES
      ('op-pc777','OP','Mystery Item','','One Piece Japanese Something Odd','Japanese','{"pricecharting":"777"}')`).run();
    return db;
  };

  it('dry run reports without writing', () => {
    const db = setup();
    const r = mopupOpSatellites(db, { dry: true });
    expect(r.matched).toBe(1);
    expect(r.keptUnmatched).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='op-pc555'`).get().n).toBe(1); // untouched
  });

  it('migrates marks/sales/listings/pc-id to the -ja sibling and retires the satellite', () => {
    const db = setup();
    const r = mopupOpSatellites(db);
    expect(r.matched).toBe(1);
    expect(r.retired).toBe(1);
    expect(r.keptUnmatched).toBe(1);
    // language routing sent the JP satellite to the -ja row
    expect(db.prepare(`SELECT card_id FROM external_marks WHERE source='pricecharting'`).get().card_id).toBe('op-op02-120-ja');
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='tx:m1'`).get().card_id).toBe('op-op02-120-ja');
    expect(db.prepare(`SELECT card_id FROM gacha_listings WHERE external_id='L9'`).get().card_id).toBe('op-op02-120-ja');
    expect(JSON.parse(db.prepare(`SELECT external_ids FROM cards WHERE id='op-op02-120-ja'`).get().external_ids).pricecharting).toBe('555');
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='op-pc555'`).get().n).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='op-pc777'`).get().n).toBe(1); // kept
  });
});
