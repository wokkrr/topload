import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { mopupSatellites } from '../mopup-satellites.js';

/**
 * The Phantasmal Flames scenario, live 2026-07-22: PC raced our catalog on a
 * new set → unmatched products became satellites → catalog caught up →
 * duplicate identities, both marked.
 */
function makeDb() {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Canonical + its duplicate satellite (the Charizard 130/94 case).
  card.run('pkmn-me2-130', 'PKMN', 'Mega Charizard X ex', 'Phantasmal Flames', '130/94', 'English', '{}');
  card.run('pkmn-pc11069012', 'PKMN', 'Mega Charizard X ex', 'Pokemon Phantasmal Flames', '130', 'English', '{"pricecharting":"11069012"}');
  // Bracketed variant satellite — must be KEPT (separate promo product).
  card.run('pkmn-pc11069136', 'PKMN', 'Suicune [Gamestop]', 'Pokemon Phantasmal Flames', '26', 'English', '{"pricecharting":"11069136"}');
  card.run('pkmn-me2-26', 'PKMN', 'Suicune', 'Phantasmal Flames', '26/94', 'English', '{}');
  // Same name+number, DIFFERENT set — set gate must block the merge.
  card.run('pkmn-sv3pt5-6', 'PKMN', 'Charizard', '151', '6/165', 'English', '{}');
  card.run('pkmn-pc7569343', 'PKMN', 'Charizard', 'Pokemon Mega Brave', '6', 'English', '{"pricecharting":"7569343"}');
  // YGO prefix-set duplicate.
  card.run('ygo-soi-en041', 'YGO', 'Phantasmal Martyrs', 'Shadow of Infinity', 'SOI-EN041', 'English', '{}');
  card.run('ygo-pc2546876', 'YGO', 'Phantasmal Martyrs', 'YuGiOh Shadow of Infinity', 'SOI-EN041', 'English', '{"pricecharting":"2546876"}');

  const mark = db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', ?, ?, '2026-07-22', ?)`);
  mark.run('pkmn-pc11069012', 'BGS10', 526000);
  mark.run('pkmn-me2-130', 'BGS10', 526000);        // canonical already has the same-grade mark → satellite's is the dup
  mark.run('pkmn-pc11069012', 'PSA9', 100000);      // grade only the satellite has → must MOVE
  db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('pkmn-pc11069012', 'PSA10', 500000, '2026-07-20', 'collectorcrypt', 's1')`).run();
  return db;
}

describe('mopupSatellites', () => {
  it('absorbs exact duplicates, keeps variants and cross-set collisions', () => {
    const db = makeDb();
    const pk = mopupSatellites(db, { ip: 'PKMN' });
    expect(pk.matched).toBe(1);                         // only the Charizard dup
    expect(pk.keptVariant).toBe(1);                     // [Gamestop] survives
    expect(pk.keptUnmatched).toBe(1);                   // Mega Brave ≠ 151 (set gate)
    expect(pk.retired).toBe(1);                         // sale re-pointed FIRST, so the satellite is safely deletable
    const ids = db.prepare(`SELECT id FROM cards WHERE ip='PKMN' ORDER BY id`).all().map(r => r.id);
    expect(ids).not.toContain('pkmn-pc11069012');
    expect(ids).toContain('pkmn-pc11069136');
    expect(ids).toContain('pkmn-pc7569343');
    // Sale + unique-grade mark moved; duplicate-grade mark dropped, not doubled.
    expect(db.prepare(`SELECT card_id FROM sales WHERE external_id='s1'`).get().card_id).toBe('pkmn-me2-130');
    const marks = db.prepare(`SELECT grade, COUNT(*) n FROM external_marks WHERE card_id='pkmn-me2-130' GROUP BY grade`).all();
    expect(Object.fromEntries(marks.map(m => [m.grade, m.n]))).toEqual({ BGS10: 1, PSA9: 1 });
    // PC id merged onto canonical without overwriting anything.
    const ext = JSON.parse(db.prepare(`SELECT external_ids FROM cards WHERE id='pkmn-me2-130'`).get().external_ids);
    expect(ext.pricecharting).toBe('11069012');

    const yg = mopupSatellites(db, { ip: 'YGO' });
    expect(yg.matched).toBe(1);                         // YuGiOh-prefix set gate passes
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='ygo-pc2546876'`).get().n).toBe(0);
  });

  it('dry run reports without writing', () => {
    const db = makeDb();
    const res = mopupSatellites(db, { ip: 'PKMN', dry: true });
    expect(res.matched).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE id='pkmn-pc11069012'`).get().n).toBe(1);
  });
});
