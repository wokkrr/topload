import { describe, it, expect } from 'vitest';
import { splitProductName, importCsv, labelOf } from '../import-pricecharting-csv.js';
import { repairVariantMarks } from '../repair-variant-marks.js';
import { openDb } from '../db.js';

const CSV_HEADER = 'id,product-name,console-name,genre,sales-volume,loose-price,graded-price,manual-only-price,box-only-price,bgs-10-price,condition-17-price,condition-18-price';
const csvOf = (rows) => [CSV_HEADER, ...rows].join('\n');
// Live corruption case 2026-07-22: [Regional Championships Staff] claimed
// canonical Dawn #87 and its $585 became the base card's mark.
const STAFF_ROW = '12579797,Dawn [Regional Championships Staff] #87,Pokemon Phantasmal Flames,Pokemon Card,25,$585.00,,,,,,';
const BASE_ROW = '11069999,Dawn #87,Pokemon Phantasmal Flames,Pokemon Card,25,$33.00,,,,,,';

describe('importCsv variant-label gate (2026-07-22)', () => {
  it('bracketed products become satellites; only the base product merges onto the canonical', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('pkmn-me2-87', 'PKMN', 'Dawn', 'Phantasmal Flames', '87/94', 'English', '{}')`).run();
    const res = importCsv(db, { text: csvOf([STAFF_ROW, BASE_ROW]), ip: 'PKMN', asOf: '2026-07-22', minVolume: 1, minPriceCents: 1 });
    expect(res.merged).toBe(1);                                       // ONLY the base row merged
    const canon = db.prepare(`SELECT json_extract(external_ids, '$.pricecharting') pc FROM cards WHERE id = 'pkmn-me2-87'`).get();
    expect(canon.pc).toBe('11069999');                                // …and it's the BASE product id
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id = 'pkmn-pc12579797'`).get().n).toBe(1);  // staff promo = satellite
    const mark = db.prepare(`SELECT price_cents FROM external_marks WHERE card_id = 'pkmn-me2-87' AND grade = 'raw'`).get();
    expect(mark.price_cents).toBe(3300);                              // canonical wears the $33 base price, not $585
  });
  it('labelOf normalizes', () => {
    expect(labelOf('Dawn [Regional Championships Staff] #87')).toBe('regional championships staff');
    expect(labelOf('Dawn #87')).toBe('');
  });
});

describe('repairVariantMarks (undo pre-gate corruption)', () => {
  it('moves the variant marks to a satellite, detaches, frees the canonical', () => {
    const db = openDb(':memory:');
    // Corrupted state: canonical carries the STAFF product's id + marks.
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('pkmn-me2-87', 'PKMN', 'Dawn', 'Phantasmal Flames', '87/94', 'English', '{"pricecharting":"12579797"}')`).run();
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', 'pkmn-me2-87', 'raw', '2026-07-21', 58500)`).run();
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('tcgplayer', 'pkmn-me2-87', 'raw', '2026-07-21', 3000)`).run();
    const res = repairVariantMarks(db, { csvs: [{ text: csvOf([STAFF_ROW, BASE_ROW]), ip: 'PKMN' }] });
    expect(res.corrupted).toBe(1);
    expect(res.satellitesMade).toBe(1);
    expect(db.prepare(`SELECT json_extract(external_ids, '$.pricecharting') pc FROM cards WHERE id = 'pkmn-me2-87'`).get().pc).toBeNull();
    expect(db.prepare(`SELECT card_id FROM external_marks WHERE source = 'pricecharting'`).get().card_id).toBe('pkmn-pc12579797');
    // Non-PC marks stay put — only the poisoned stream moves.
    expect(db.prepare(`SELECT card_id FROM external_marks WHERE source = 'tcgplayer'`).get().card_id).toBe('pkmn-me2-87');
  });
});

describe('splitProductName — promo codes', () => {
  it('extracts single-letter P- promo codes (were dropped → null)', () => {
    expect(splitProductName('Boa Hancock P-066')).toEqual({ name: 'Boa Hancock', number: 'P-066' });
    expect(splitProductName('Arlong [Live Action] P-048')).toEqual({ name: 'Arlong [Live Action]', number: 'P-048' });
    expect(splitProductName('Boa Hancock [V Jump] P-115')).toEqual({ name: 'Boa Hancock [V Jump]', number: 'P-115' });
  });
  it('still handles set codes and # and slash numbers', () => {
    expect(splitProductName('Bartholomew Kuma OP12-119')).toEqual({ name: 'Bartholomew Kuma', number: 'OP12-119' });
    expect(splitProductName('Backlight ST11-003')).toEqual({ name: 'Backlight', number: 'ST11-003' });
    expect(splitProductName('Charizard #6')).toEqual({ name: 'Charizard', number: '6' });
    expect(splitProductName('Pikachu 58/102')).toEqual({ name: 'Pikachu', number: '58/102' });
  });
  it('leaves a plain name with no number', () => {
    expect(splitProductName('Monkey D. Luffy')).toEqual({ name: 'Monkey D. Luffy', number: null });
  });
});

describe('released_at enrichment from PC release-date (2026-07-22)', () => {
  it('fills satellites and never overwrites an existing date', async () => {
    const { importCsv } = await import('../import-pricecharting-csv.js');
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, released_at, external_ids)
                VALUES ('pk-dated', 'PKMN', 'Mew', 'Promo', '9', 'English', '1999-01-01', '{}')`).run();
    const header = 'id,product-name,console-name,genre,sales-volume,loose-price,release-date';
    const text = [header,
      '111,Illustrator Pikachu,Pokemon Japanese Promo,Pokemon Card,25,$100.00,1998-01-15',
      '222,Mew #9,Promo,Pokemon Card,25,$50.00,2001-06-01',
    ].join('\n');
    importCsv(db, { text, ip: 'PKMN', asOf: '2026-07-22' });
    expect(db.prepare(`SELECT released_at FROM cards WHERE id = 'pkmn-pc111'`).get().released_at).toBe('1998-01-15');
    expect(db.prepare(`SELECT released_at FROM cards WHERE id = 'pk-dated'`).get().released_at).toBe('1999-01-01');  // COALESCE holds
  });
});

describe('THE SPINE RULE — gates protect marks, not existence (2026-07-22)', () => {
  it('a thin vintage product gets a ROW but no marks until it earns them', async () => {
    const { importCsv } = await import('../import-pricecharting-csv.js');
    const db = openDb(':memory:');
    const header = 'id,product-name,console-name,genre,sales-volume,loose-price';
    const text = [header,
      '901,Ooyama Pikachu #25,Pokemon Japanese Vending,Pokemon Card,2,$150.00',   // volume 2 < 10 → gated
      '902,Pikachu #58,Pokemon Base Set,Pokemon Card,50,$5.00',                   // passes → marks
    ].join('\n');
    const res = importCsv(db, { text, ip: 'PKMN', asOf: '2026-07-22' });
    expect(res.kept).toBe(2);
    expect(res.gated).toBe(1);
    const row = db.prepare(`SELECT name, set_name FROM cards WHERE id = 'pkmn-pc901'`).get();
    expect(row).toEqual({ name: 'Ooyama Pikachu', set_name: 'Pokemon Japanese Vending' });   // it EXISTS
    expect(db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE card_id = 'pkmn-pc901'`).get().n).toBe(0);  // unpriced
    expect(db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE card_id = 'pkmn-pc902'`).get().n).toBeGreaterThan(0);
  });
});
