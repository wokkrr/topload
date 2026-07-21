import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { indexSnapshot, pickArt, labelKey, opVariantArt } from '../seed-op-variant-art.js';

// Mirrors the real snapshot shape. Live lesson baked in (2026-07-21, Sabo
// OP13-120 vs TCGplayer): rarity does NOT identify artwork — the red-manga
// art was _p3 (rarity SecretRare) while _p4 carried rarity 'Special' but a
// DIFFERENT (wanted-poster) artwork. Hence: curation or single-parallel only.
const SNAP_EN = { cards: {
  'OP13-120': { name: 'Sabo', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-120.png' },
  'OP13-120_p1': { name: 'Sabo', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-120_p1.png' },
  'OP13-120_p3': { name: 'Sabo', rarity: 'SecretRare', img_url: 'https://en.op.example/OP13-120_p3.png' },
  'OP13-120_p4': { name: 'Sabo', rarity: 'Special', img_url: 'https://en.op.example/OP13-120_p4.png' },
  'OP01-025': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://en.op.example/OP01-025.png' },
  'OP01-025_p1': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://en.op.example/OP01-025_p1.png' },
  'ST01-001': { name: 'Monkey.D.Luffy', rarity: 'Leader', img_url: 'https://en.op.example/ST01-001.png' },
} };
const SNAP_JA = { cards: {
  'OP01-025': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://ja.op.example/OP01-025.png' },
  'OP01-025_p1': { name: 'Boa Hancock', rarity: 'SuperRare', img_url: 'https://ja.op.example/OP01-025_p1.png' },
} };
const CURATED = { 'OP13-120|red manga': 'p3' };

describe('pickArt', () => {
  const en = indexSnapshot(SNAP_EN);
  it('curated map wins and is the ONLY path to a multi-parallel assignment', () => {
    expect(pickArt('Sabo [Red Manga]', en.get('OP13-120'), 'OP13-120', CURATED)).toBe('https://en.op.example/OP13-120_p3.png');
    // Same label WITHOUT curation → ambiguous, no rarity guessing (the old
    // rarity rule would have wrongly returned _p4 here).
    expect(pickArt('Sabo [Red Manga]', en.get('OP13-120'), 'OP13-120', {})).toBeNull();
  });
  it('edition-style label → base artwork', () => {
    expect(pickArt('Monkey.D.Luffy [Winner]', en.get('ST01-001'), 'ST01-001')).toBe('https://en.op.example/ST01-001.png');
    expect(pickArt('Sabo [Tournament Pack]', en.get('OP13-120'), 'OP13-120')).toBe('https://en.op.example/OP13-120.png');
  });
  it('single-parallel code → that parallel for any variant label', () => {
    expect(pickArt('Boa Hancock [Alternate Art]', en.get('OP01-025'), 'OP01-025')).toBe('https://en.op.example/OP01-025_p1.png');
  });
  it('labelKey normalizes bracket labels', () => {
    expect(labelKey('Sabo [Red Manga]')).toBe('red manga');
    expect(labelKey('no brackets')).toBe('');
  });
});

describe('opVariantArt', () => {
  function makeDb() {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO cards (id, ip, name, set_name, number, language, image, image_kind, external_ids)
       VALUES (?, 'OP', ?, ?, ?, ?, ?, ?, '{}')`
    );
    ins.run('op-pc1', 'Sabo [Red Manga]', 'One Piece Carrying on His Will', 'OP13-120', 'English', null, null);
    ins.run('op-pc2', 'Boa Hancock [Alternate Art]', 'One Piece Romance Dawn', 'OP01-025', 'Japanese', null, null); // JA art
    ins.run('op-pc3', 'Sabo [Alternate Art]', 'One Piece Carrying on His Will', 'OP13-120', 'English', null, null); // ambiguous
    ins.run('op-pc4', 'Nami [Box Topper]', 'One Piece Mystery Set', null, 'English', null, null); // no code anywhere
    // A stale assignment from a previous run under old rules → must be re-derived away
    ins.run('op-pc5', 'Zoro [Manga]', 'One Piece Mystery Set', 'OP99-001', 'English', 'https://stale/wrong.png', 'variant');
    return db;
  }

  it('assigns curated + unambiguous, resets stale prior assignments, skips the rest', () => {
    const db = makeDb();
    const res = opVariantArt(db, { snapEn: SNAP_EN, snapJa: SNAP_JA, curated: CURATED });
    // assigned = curated Sabo + single-parallel JA Boa; the reset Zoro row has
    // no snapshot entry so it re-lands in the ambiguous bucket, not assigned.
    expect(res).toMatchObject({ curatedEntries: 1, noCode: 1, assigned: 2, ambiguous: 2 });
    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('op-pc1')).toEqual({ image: 'https://en.op.example/OP13-120_p3.png', image_kind: 'variant' }); // curated
    expect(img('op-pc2')).toEqual({ image: 'https://ja.op.example/OP01-025_p1.png', image_kind: 'variant' });
    expect(img('op-pc3').image).toBeNull();               // multi-parallel stays honest-empty
    expect(img('op-pc5').image).toBeNull();               // stale old-rule assignment wiped
  });

  it('dry run writes nothing and preserves stale rows for inspection', () => {
    const db = makeDb();
    opVariantArt(db, { dry: true, snapEn: SNAP_EN, snapJa: SNAP_JA, curated: CURATED });
    expect(db.prepare(`SELECT image FROM cards WHERE id = 'op-pc5'`).get().image).toBe('https://stale/wrong.png');
    expect(db.prepare(`SELECT image FROM cards WHERE id = 'op-pc2'`).get().image).toBeNull();
  });
});

describe('verified conventions (2026-07-21 visual pass)', () => {
  const en = indexSnapshot({ cards: {
    'OP07-051': { rarity: 'SuperRare', img_url: 'https://e/OP07-051.png' },
    'OP07-051_p1': { rarity: 'SuperRare', img_url: 'https://e/OP07-051_p1.png' },
    'OP07-051_p2': { rarity: 'SuperRare', img_url: 'https://e/OP07-051_p2.png' },
    'OP07-051_p3': { rarity: 'Special', img_url: 'https://e/OP07-051_p3.png' },
  } });
  it("bare '[Alternate Art]' → _p1 (the standard alt-art slot)", () => {
    expect(pickArt('Boa Hancock [Alternate Art]', en.get('OP07-051'), 'OP07-051')).toBe('https://e/OP07-051_p1.png');
  });
  it("'[SP Foil]' → the unique Special-rarity parallel", () => {
    expect(pickArt('Boa Hancock [SP Foil]', en.get('OP07-051'), 'OP07-051')).toBe('https://e/OP07-051_p3.png');
  });
  it("'[Alternate Art Manga]' does NOT take the p1 path — curation only", () => {
    expect(pickArt('Boa Hancock [Alternate Art Manga]', en.get('OP07-051'), 'OP07-051')).toBeNull();
    expect(pickArt('Boa Hancock [Alternate Art Manga]', en.get('OP07-051'), 'OP07-051', { 'OP07-051|alternate art manga': 'p2' }))
      .toBe('https://e/OP07-051_p2.png');
  });
});
