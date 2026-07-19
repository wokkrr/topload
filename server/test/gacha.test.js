import { describe, it, expect } from 'vitest';
import { makeCollectorCryptAdapter, normalizeGrade, gradeFromTitle } from '../adapters/collectorcrypt.js';
import { matchListing } from '../match.js';

const jsonRes = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('collectorcrypt adapter (fixtures)', () => {
  const page = {
    totalPages: 1,
    filterNFtCard: [
      { id: 'a1', itemName: '2023 Pokemon 151 Charizard ex #199 PSA 10', nftAddress: 'MINT1',
        category: 'Pokemon', gradeNum: 10, gradingCompany: 'PSA',
        listing: { price: '825.5', currency: 'USDC', createdAt: '2026-07-01T00:00:00Z' },
        images: { frontM: 'https://img/x.jpg' } },
      { id: 'a2', itemName: 'Unlisted vault card', category: 'Pokemon', gradeNum: 9, gradingCompany: 'CGC' }, // no listing
      { id: 'a3', itemName: 'Michael Jordan rookie PSA 8', nftAddress: 'MINT3', category: 'Basketball',
        gradeNum: 8, gradingCompany: 'PSA', listing: { price: '5000', currency: 'USDC' } }, // filtered category
      { id: 'a4', itemName: 'Shanks OP01-120 Alt CGC 9.5', nftAddress: 'MINT4', category: 'One Piece',
        gradeNum: 9.5, gradingCompany: 'CGC', listing: { price: '610', currency: 'USDC' } },
    ],
  };

  it('keeps only listed cards in target categories, normalized', async () => {
    const cc = makeCollectorCryptAdapter({ fetchImpl: () => jsonRes(page), throttleMs: 0 });
    const listings = await cc.fetchListings({ seenAt: '2026-07-19' });
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      platform: 'collectorcrypt', external_id: 'MINT1', grade: 'PSA10',
      price_cents: 82550, currency: 'USDC', image: 'https://img/x.jpg', seen_at: '2026-07-19',
    });
    expect(listings[1]).toMatchObject({ external_id: 'MINT4', grade: 'CGC9.5', price_cents: 61000 });
  });

  it('normalizes grades', () => {
    expect(normalizeGrade('PSA', 10)).toBe('PSA10');
    expect(normalizeGrade('CGC', 9.5)).toBe('CGC9.5');
    expect(normalizeGrade('psa', '9')).toBe('PSA9');
    expect(normalizeGrade('Beckett', 9.5)).toBe('BGS9.5');
    expect(normalizeGrade(null, 10)).toBe('raw');
    expect(normalizeGrade('PSA', null)).toBe('raw');
  });

  it('falls back to parsing the grade from the title', () => {
    expect(gradeFromTitle('2022 #001 Monkey D. Luffy PSA 10 One Piece Starter Deck')).toBe('PSA10');
    expect(gradeFromTitle('Zoro MANGA ART SEC BGS 9.5 Wings of the Captain')).toBe('BGS9.5');
    expect(gradeFromTitle('Charizard Base Set near mint')).toBe('raw');
  });

  it('title-grade fallback applies when structured fields are missing', async () => {
    const page = { totalPages: 1, filterNFtCard: [
      { id: 'x1', itemName: '2022 #001 Luffy PSA 10 One Piece', nftAddress: 'M1', category: 'One Piece',
        listing: { price: '3550', currency: 'USDC' } }, // no gradingCompany/gradeNum
    ]};
    const cc = makeCollectorCryptAdapter({ fetchImpl: () => jsonRes(page), throttleMs: 0 });
    const [l] = await cc.fetchListings({ seenAt: '2026-07-19' });
    expect(l.grade).toBe('PSA10');
  });
});

describe('listing→card matcher', () => {
  const cards = [
    { id: 'pkmn-sv3pt5-charizard-ex-199', name: 'Charizard ex', number: '199/165', set_name: '151' },
    { id: 'pkmn-sv3pt5-mew-ex-205', name: 'Mew ex', number: '205/165', set_name: '151' },
    { id: 'pkmn-swsh7-umbreon-vmax-215', name: 'Umbreon VMAX', number: '215/203', set_name: 'Evolving Skies' },
    { id: 'op-shanks-alt-op01-120', name: 'Shanks (Alt Art)', number: 'OP01-120', set_name: 'OP-01' },
  ];

  it('matches name + full collector number', () => {
    expect(matchListing('2021 Pokemon Evolving Skies Umbreon VMAX 215/203 Alt Art PSA 10', cards))
      .toBe('pkmn-swsh7-umbreon-vmax-215');
  });

  it('matches name + #number form', () => {
    expect(matchListing('2023 Pokemon 151 Charizard ex #199 PSA 10', cards))
      .toBe('pkmn-sv3pt5-charizard-ex-199');
  });

  it('ignores parentheticals in card names', () => {
    expect(matchListing('One Piece Shanks OP01-120 Alternate Art CGC 9.5', cards))
      .toBe('op-shanks-alt-op01-120');
  });

  it('refuses to match on name alone (number required)', () => {
    expect(matchListing('Pokemon Charizard ex holo rare', cards)).toBeNull();
  });

  it('does not cross-match different cards sharing a number token', () => {
    // 'Mew ex' title must not match Charizard even though both are 151 cards.
    expect(matchListing('Pokemon 151 Mew ex #205 PSA 10', cards)).toBe('pkmn-sv3pt5-mew-ex-205');
  });

  it('short names only match as whole words (the trainer-N bug)', () => {
    const withN = [...cards, { id: 'pkmn-trainer-n', name: 'N', number: '100/101', set_name: 'Noble Victories' }];
    // 'Nami' contains 'n' but must NOT match the trainer card N.
    expect(matchListing('2022 #OP01016 Nami ALT ART BGS 10 One Piece Romance Dawn 100', withN)).toBeNull();
    // Genuine whole-word N listing still matches.
    expect(matchListing('Pokemon Noble Victories N #100/101 Trainer PSA 10', withN)).toBe('pkmn-trainer-n');
  });
});
