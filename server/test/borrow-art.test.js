import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { borrowArt } from '../seed-borrow-art.js';

function makeDb() {
  const db = openDb(':memory:');
  const ins = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, language, image, image_kind, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`
  );
  // Canonical donors (own art)
  ins.run('pkmn-base1-4', 'PKMN', 'Charizard', 'Base', '4', 'English', 'https://img/base1-4.png', null);
  ins.run('op-op01-001', 'OP', 'Roronoa Zoro', 'One Piece Romance Dawn', 'OP01-001', 'English', 'https://img/op01-001.png', null);
  // Artless PC satellites
  ins.run('pkmn-pc1', 'PKMN', 'Charizard [1st Edition]', 'Pokemon Base Set', '4', 'English', null, null);           // safe variant → borrow
  ins.run('pkmn-pc2', 'PKMN', 'Charizard [Alternate Art]', 'Pokemon Base Set', '4', 'English', null, null);          // different artwork → skip
  ins.run('pkmn-pc3', 'PKMN', 'Illustrator Pikachu', 'Pokemon Japanese Promo', null, 'Japanese', null, null);        // JP, no JP donor → unmatched
  ins.run('op-pc1', 'OP', 'Roronoa Zoro [1st Edition]', 'One Piece Romance Dawn', 'OP01-001', 'English', null, null);
  // A previously-borrowed row must never act as a donor
  ins.run('pkmn-pc4', 'PKMN', 'Blastoise [1st Edition]', 'Pokemon Base Set', '2', 'English', 'https://img/borrowed.png', 'borrowed');
  // Descriptive bracket: Gold Star IS the card at that number (2026-07-22)
  ins.run('pkmn-hp-104', 'PKMN', 'Pikachu Star', 'Holon Phantoms', '104', 'English', 'https://img/hp-104.png', null);
  ins.run('pkmn-pc5', 'PKMN', 'Pikachu [Gold Star]', 'Pokemon Holon Phantoms', '104', 'English', null, null);
  return db;
}

describe('borrowArt', () => {
  it('borrows same-artwork variants, skips different-art variants, never crosses language', () => {
    const db = makeDb();
    const res = borrowArt(db);
    expect(res).toMatchObject({ borrowed: 3, skippedVariant: 1 });
    expect(res.unmatched).toBeGreaterThanOrEqual(1);     // the JP Pikachu

    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('pkmn-pc1')).toEqual({ image: 'https://img/base1-4.png', image_kind: 'borrowed' });
    expect(img('op-pc1')).toEqual({ image: 'https://img/op01-001.png', image_kind: 'borrowed' });
    expect(img('pkmn-pc5')).toEqual({ image: 'https://img/hp-104.png', image_kind: 'borrowed' });   // [Gold Star] ← canonical Star
    expect(img('pkmn-pc2').image).toBeNull();            // alt art stays honest-empty
    expect(img('pkmn-pc3').image).toBeNull();            // EN art never labeled as JP printing
  });

  it('dry run reports without writing', () => {
    const db = makeDb();
    const res = borrowArt(db, { dry: true });
    expect(res.borrowed).toBe(3);
    expect(db.prepare(`SELECT image FROM cards WHERE id = 'pkmn-pc1'`).get().image).toBeNull();
  });

  it('is idempotent — borrowed rows leave the target set', () => {
    const db = makeDb();
    borrowArt(db);
    expect(borrowArt(db).borrowed).toBe(0);
  });
});
