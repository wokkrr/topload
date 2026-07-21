import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { findLanguageSiblings } from '../language-siblings.js';

function makeDb() {
  const db = openDb(':memory:');
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, language, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, '{}')`
  );
  // OP: EN and JP share printed codes — the canonical sibling pair.
  ins.run('op-en-1', 'OP', 'Sabo [Alternate Art]', 'Carrying on His Will', 'OP13-120', 'English');
  ins.run('op-ja-1', 'OP', 'Sabo [Alternate Art]', 'Carrying on His Will JP', 'OP13-120', 'Japanese');
  ins.run('op-ja-2', 'OP', 'Sabo [Red Manga]', 'Carrying on His Will JP', 'OP13-120', 'Japanese');
  // PKMN: same number in DIFFERENT sets with different names → must NOT pair.
  ins.run('pk-en-1', 'PKMN', 'Umbreon VMAX', 'Evolving Skies', '95', 'English');
  ins.run('pk-ja-1', 'PKMN', 'Umbreon VMAX', 'Eevee Heroes', '95', 'Japanese');
  ins.run('pk-ja-x', 'PKMN', 'Charizard', 'Base Expansion', '95', 'Japanese'); // number collision, wrong card
  // Number-less promo: falls back to exact-name matching.
  ins.run('pr-en-1', 'PKMN', 'Pikachu Promo', 'Promo', null, 'English');
  ins.run('pr-ja-1', 'PKMN', 'Pikachu Promo', 'Promo JP', null, 'Japanese');
  const mark = db.prepare(
    `INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, sales_7d, sales_30d, is_top)
     VALUES (?, ?, '2026-07-21', ?, 0.9, 'solds', 1, 3, ?)`
  );
  mark.run('op-ja-1', 'PSA 10', 41200, 1);
  mark.run('op-ja-1', 'raw', 9900, 0);
  mark.run('pk-ja-1', 'raw', 12000, 1);
  return db;
}

const card = (db, id) => db.prepare(`SELECT id, ip, name, number, language FROM cards WHERE id = ?`).get(id);

describe('findLanguageSiblings', () => {
  it('pairs EN↔JP by ip+number+base-name, exact variant label preferred, top mark attached', () => {
    const db = makeDb();
    const sibs = findLanguageSiblings(db, card(db, 'op-en-1'));
    expect(sibs).toEqual([{
      id: 'op-ja-1', language: 'Japanese', name: 'Sabo [Alternate Art]',
      set_name: 'Carrying on His Will JP', number: 'OP13-120',
      grade: 'PSA 10', price_cents: 41200,        // the is_top row, not raw
    }]);
  });

  it('works in the JP→EN direction and returns null price for unpriced siblings', () => {
    const db = makeDb();
    const sibs = findLanguageSiblings(db, card(db, 'op-ja-1'));
    expect(sibs).toEqual([{
      id: 'op-en-1', language: 'English', name: 'Sabo [Alternate Art]',
      set_name: 'Carrying on His Will', number: 'OP13-120',
      grade: null, price_cents: null,
    }]);
  });

  it('different variant of the same code still pairs (base identity), variant-exact wins when both exist', () => {
    const db = makeDb();
    const sibs = findLanguageSiblings(db, card(db, 'op-ja-2')); // JP [Red Manga] → EN has only [Alternate Art]
    expect(sibs.map(s => s.id)).toEqual(['op-en-1']);
  });

  it('number collisions across different cards do NOT pair (base-name gate)', () => {
    const db = makeDb();
    const sibs = findLanguageSiblings(db, card(db, 'pk-en-1'));
    expect(sibs.map(s => s.id)).toEqual(['pk-ja-1']);          // Eevee Heroes yes, Charizard no
  });

  it('number-less cards fall back to exact-name pairing', () => {
    const db = makeDb();
    const sibs = findLanguageSiblings(db, card(db, 'pr-en-1'));
    expect(sibs.map(s => s.id)).toEqual(['pr-ja-1']);
  });

  it('no siblings → empty array, and malformed input is safe', () => {
    const db = makeDb();
    expect(findLanguageSiblings(db, card(db, 'pk-ja-x'))).toEqual([]);
    expect(findLanguageSiblings(db, null)).toEqual([]);
    expect(findLanguageSiblings(db, {})).toEqual([]);
  });
});
