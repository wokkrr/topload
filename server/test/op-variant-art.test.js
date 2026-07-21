import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { indexSnapshot, pickArt, opVariantArt } from '../seed-op-variant-art.js';

// Mirrors the real snapshot shape (seed/onepiece-catalog.json, verified
// 2026-07-21: OP13-118 base + _p1.._p4, manga art = rarity 'Special').
const SNAP_EN = { cards: {
  'OP13-118': { name: 'Monkey.D.Luffy', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-118.png' },
  'OP13-118_p1': { name: 'Monkey.D.Luffy', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-118_p1.png' },
  'OP13-118_p2': { name: 'Monkey.D.Luffy', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-118_p2.png' },
  'OP13-118_p4': { name: 'Monkey.D.Luffy', rarity: 'Special', img_url: 'https://en.op.example/OP13-118_p4.png' },
  'OP01-025': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://en.op.example/OP01-025.png' },
  'OP01-025_p1': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://en.op.example/OP01-025_p1.png' },
  'ST01-001': { name: 'Monkey.D.Luffy', rarity: 'Leader', img_url: 'https://en.op.example/ST01-001.png' },
} };
const SNAP_JA = { cards: {
  'OP01-025': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://ja.op.example/OP01-025.png' },
  'OP01-025_p1': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://ja.op.example/OP01-025_p1.png' },
} };

describe('pickArt', () => {
  const en = indexSnapshot(SNAP_EN);
  it('manga label → the unique Special parallel', () => {
    expect(pickArt('Monkey.D.Luffy [Red Manga]', en.get('OP13-118'))).toBe('https://en.op.example/OP13-118_p4.png');
  });
  it('edition-style label → base artwork', () => {
    expect(pickArt('Monkey.D.Luffy [Winner]', en.get('ST01-001'))).toBe('https://en.op.example/ST01-001.png');
    expect(pickArt('Monkey.D.Luffy [Tournament Pack]', en.get('OP13-118'))).toBe('https://en.op.example/OP13-118.png');
  });
  it('single-parallel code → that parallel for any variant label', () => {
    expect(pickArt('Boa Hancock [Alternate Art]', en.get('OP01-025'))).toBe('https://en.op.example/OP01-025_p1.png');
  });
  it('multi-parallel non-manga label → ambiguous, no assignment', () => {
    expect(pickArt('Monkey.D.Luffy [Alternate Art]', en.get('OP13-118'))).toBeNull();
  });
});

describe('opVariantArt', () => {
  function makeDb() {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO cards (id, ip, name, set_name, number, language, image, external_ids)
       VALUES (?, 'OP', ?, ?, ?, ?, NULL, '{}')`
    );
    ins.run('op-pc1', 'Monkey.D.Luffy [Red Manga]', 'One Piece Carrying on His Will', 'OP13-118', 'English');
    ins.run('op-pc2', 'Boa Hancock [Alternate Art]', 'One Piece Romance Dawn', 'OP01-025', 'Japanese'); // JA art
    ins.run('op-pc3', 'Monkey.D.Luffy [Alternate Art]', 'One Piece Carrying on His Will', 'OP13-118', 'English'); // ambiguous
    ins.run('op-pc4', 'Nami [Box Topper]', 'One Piece Mystery Set', null, 'English'); // no code anywhere
    return db;
  }

  it('assigns unambiguous variants, JA rows from the JA snapshot, skips the rest', () => {
    const db = makeDb();
    const res = opVariantArt(db, { snapEn: SNAP_EN, snapJa: SNAP_JA });
    expect(res).toMatchObject({ targets: 4, assigned: 2, ambiguous: 1, noCode: 1 });
    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('op-pc1')).toEqual({ image: 'https://en.op.example/OP13-118_p4.png', image_kind: 'borrowed' });
    expect(img('op-pc2')).toEqual({ image: 'https://ja.op.example/OP01-025_p1.png', image_kind: 'borrowed' });
    expect(img('op-pc3').image).toBeNull();
  });

  it('dry run writes nothing', () => {
    const db = makeDb();
    expect(opVariantArt(db, { dry: true, snapEn: SNAP_EN, snapJa: SNAP_JA }).assigned).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE image IS NOT NULL`).get().n).toBe(0);
  });
});
