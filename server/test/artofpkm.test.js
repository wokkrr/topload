import { describe, it, expect } from 'vitest';
import { parseSlug, tokenKey, squashName, aliasFor, parseSetPage, importArtofpkm } from '../seed-artofpkm-art.js';
import { openDb } from '../db.js';

describe('parseSlug — filename identity (live shapes, 2026-07-22)', () => {
  it('vintage name+digits, nameless codes, modern set_num_rand', () => {
    expect(parseSlug('bulbasaur1.png')).toEqual({ name: 'bulbasaur', num: '1' });
    expect(parseSlug('mr-mime2.png')).toEqual({ name: 'mrmime', num: '2' });
    expect(parseSlug('1stp002.png')).toEqual({ name: null, num: null });      // code stem, no name
    expect(parseSlug('mf_002_vq19w0yr.png')).toEqual({ name: null, num: '2' });
    expect(parseSlug('sheet1.png').name).toBeNull();                          // set logo noise
    expect(parseSlug('Base%20Set.png').name).toBeNull();
    expect(parseSlug('unnumberedpromo.png').name).toBeNull();
  });
});

describe('name keys', () => {
  it('tokenKey is order-insensitive; squashName drops punctuation and brackets', () => {
    expect(tokenKey('Pikachu Illustrator')).toBe(tokenKey('Illustrator Pikachu'));
    expect(squashName('Mr. Mime')).toBe('mrmime');
    expect(squashName('Charizard [No Rarity]')).toBe('charizard');
  });
});

describe('aliasFor — their h1 → our PC set key', () => {
  const ours = ['expansion pack', 'vending', 'promo', 'jungle', 'team rocket', 'mysterious mountains', 'expedition expansion pack'];
  it('curated overrides + auto containment', () => {
    expect(aliasFor('Base Set', ours)).toBe('expansion pack');
    expect(aliasFor('Expansion Sheet No. 1 (Blue Version)', ours)).toBe('vending');
    expect(aliasFor('PMCG Promos', ours)).toBe('promo');
    expect(aliasFor('Rocket Gang', ours)).toBe('team rocket');
    expect(aliasFor('Mysterious Mountains', ours)).toBe('mysterious mountains');
    expect(aliasFor('Base Expansion Pack', ours)).toBe('expedition expansion pack');   // e-Card, NOT base
    expect(aliasFor('Some Unknown Deck', ours)).toBeNull();
  });
});

describe('parseSetPage — card-cut images only, href + filename per card', () => {
  it('extracts blocks and h1; ignores logo images', () => {
    const html = `
      <h1 class="x">Base Set</h1>
      <img class="w-auto h-10 object-contain" src="/rails/active_storage/representations/redirect/AAA/logo.png" />
      <a href="/cards/123"><img class="w-full card-cut card-ratio" src="/rails/active_storage/representations/redirect/BBB/bulbasaur1.png"></a>
      <a href="/cards/124"><img class="w-full card-cut card-ratio" src="https://www.artofpkm.com/rails/active_storage/representations/redirect/CCC/charizard6.png"></a>`;
    const { h1, cards } = parseSetPage(html);
    expect(h1).toBe('Base Set');
    expect(cards).toEqual([
      { href: '/cards/123', img: 'https://www.artofpkm.com/rails/active_storage/representations/redirect/BBB/bulbasaur1.png', filename: 'bulbasaur1.png' },
      { href: '/cards/124', img: 'https://www.artofpkm.com/rails/active_storage/representations/redirect/CCC/charizard6.png', filename: 'charizard6.png' },
    ]);
  });
});

describe('importArtofpkm e2e (stub fetch, dry)', () => {
  it('aliases the set, matches by name, gives all bracket variants the image, honors tiering', async () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, image, image_kind, external_ids) VALUES (?, 'PKMN', ?, ?, ?, 'Japanese', ?, ?, '{}')`);
    ins.run('pk-z1', 'Charizard [No Rarity]', 'Pokemon Japanese Expansion Pack', '6', 'https://pc/photo.jpg', 'pricecharting'); // upgradeable
    ins.run('pk-z2', 'Charizard', 'Pokemon Japanese Expansion Pack', '6', null, null);                                          // artless
    ins.run('pk-z3', 'Charizard', 'Pokemon Japanese Expansion Pack', '6', 'https://official/z.png', null);                      // official → excluded
    ins.run('pk-b1', 'Bulbasaur', 'Pokemon Japanese Expansion Pack', '44', null, null);
    const SET = `
      <h1>Base Set</h1>
      <a href="/cards/1"><img class="card-cut" src="/rails/active_storage/representations/redirect/X/charizard6.png"></a>
      <a href="/cards/2"><img class="card-cut" src="/rails/active_storage/representations/redirect/Y/1stp002.png"></a>`;
    const stub = async (url) => url.endsWith('/sets/6') ? SET : '<html></html>';
    const res = await importArtofpkm(db, { sets: ['6'], dry: true, fetchImpl: stub, log: () => {} });
    expect(res.setsAliased).toBe(1);
    expect(res.matched).toBe(1);                 // charizard6 → both upgradeable Charizards (one match unit)
    expect(res.nameless).toBe(1);                // 1stp002 skipped without --deep
    expect(res.samples[0]).toMatch(/pk-z[12]\+pk-z[12] ←/);
    expect(res.samples[0]).not.toContain('pk-z3');   // official art never targeted
  });
});
