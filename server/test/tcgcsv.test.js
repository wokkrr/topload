import { describe, it, expect } from 'vitest';
import { toCents, productLabel, baseName, mapGroupProducts } from '../adapters/tcgcsv.js';
import { numberKey, matchProducts, markPrice } from '../import-tcgcsv.js';

// Live shapes captured from tcgcsv.com 2026-07-21 (OP cat 68, group 23213).
const GROUP = { groupId: 23213, name: 'Awakening of the New Era', abbreviation: 'OP05' };
const PRODUCTS = [
  { productId: 527007, name: 'Sabo (001) (Alternate Art)', url: 'https://www.tcgplayer.com/product/527007/x',
    extendedData: [{ name: 'Rarity', value: 'L' }, { name: 'Number', value: 'OP05-001' }] },
  { productId: 498801, name: 'Monkey.D.Luffy (119)', url: 'https://www.tcgplayer.com/product/498801/x',
    extendedData: [{ name: 'Rarity', value: 'SEC' }, { name: 'Number', value: 'OP05-119' }] },
  { productId: 498735, name: 'Awakening of the New Era - Booster Box Case', url: 'x', extendedData: [] },
];
const PRICES = [
  { productId: 527007, subTypeName: 'Normal', marketPrice: 27.48, lowPrice: 25.98, midPrice: 32, highPrice: 99.99, directLowPrice: null },
  { productId: 498801, subTypeName: 'Normal', marketPrice: 118.5, lowPrice: 104.97, midPrice: 120, highPrice: 300, directLowPrice: 111.11 },
  { productId: 498735, subTypeName: 'Normal', marketPrice: 12106.99, lowPrice: 15969.69, midPrice: 18944.44, highPrice: 199999.99, directLowPrice: null },
];

describe('tcgcsv mapping', () => {
  it('cents conversion is float-safe and null-safe', () => {
    expect(toCents(27.48)).toBe(2748);
    expect(toCents(118.5)).toBe(11850);
    expect(toCents(null)).toBeNull();
    expect(toCents(0)).toBeNull();
  });
  it('productLabel drops numeric index parens, keeps variant words', () => {
    expect(productLabel('Sabo (001) (Alternate Art)')).toBe('alternate art');
    expect(productLabel('Monkey.D.Luffy (119)')).toBe('');
    expect(productLabel('Nami (Manga) (105a)')).toBe('manga');
    expect(baseName('Sabo (001) (Alternate Art)')).toBe('Sabo');
  });
  it('mapGroupProducts keeps numbered+priced cards, drops sealed', () => {
    const rows = mapGroupProducts(PRODUCTS, PRICES, GROUP);
    expect(rows.map(r => r.number)).toEqual(['OP05-001', 'OP05-119']);
    expect(rows[0].prices.Normal.market_cents).toBe(2748);
    expect(rows[1].prices.Normal.direct_low_cents).toBe(11111);
    expect(rows[0].label).toBe('alternate art');
  });
});

describe('numberKey', () => {
  it('normalizes per game', () => {
    expect(numberKey('OP', 'OP05-119')).toBe('OP05-119');
    expect(numberKey('PKMN', '095/203')).toBe('95');
    expect(numberKey('PKMN', '95')).toBe('95');
    expect(numberKey('YGO', 'LOB-EN001')).toBe('LOB-001');
    expect(numberKey('YGO', 'LOB-001')).toBe('LOB-001');
  });
});

describe('matchProducts', () => {
  const mapped = mapGroupProducts(PRODUCTS, PRICES, GROUP);
  it('OP: exact code + variant label routes base vs satellite; canonical beats satellite', () => {
    const cards = [
      { id: 'op-sabo', name: 'Sabo', number: 'OP05-001', set_name: 'Awakening of the New Era', language: 'English' },
      { id: 'op-pc9', name: 'Sabo [Alternate Art]', number: 'OP05-001', set_name: 'One Piece Awakening', language: 'English' },
      { id: 'op-luffy', name: 'Monkey.D.Luffy', number: 'OP05-119', set_name: 'Awakening of the New Era', language: 'English' },
      { id: 'op-luffy-ja', name: 'Monkey.D.Luffy', number: 'OP05-119', set_name: 'Awakening JA', language: 'Japanese' },
    ];
    const { hits, misses } = matchProducts(mapped, cards, 'OP');
    expect(misses).toEqual([]);
    const byId = Object.fromEntries(hits.map(h => [h.product.product_id, h.card.id]));
    expect(byId[527007]).toBe('op-pc9');    // alt-art label → the satellite carrying it
    expect(byId[498801]).toBe('op-luffy');  // base → base, EN preferred over JA
  });
  it('PKMN: number collisions across sets blocked by name+set gates', () => {
    const prods = [{
      product_id: 1, url: 'x', name: 'Umbreon VMAX', label: '', number: '095/203',
      group_name: 'Evolving Skies', group_abbr: 'EVS', prices: { Normal: { market_cents: 5000 } },
    }];
    const cards = [
      { id: 'pk-1', name: 'Umbreon VMAX', number: '95', set_name: 'Evolving Skies', language: 'English' },
      { id: 'pk-x', name: 'Charizard', number: '95', set_name: 'Base Expansion', language: 'English' },
    ];
    const { hits } = matchProducts(prods, cards, 'PKMN');
    expect(hits.map(h => h.card.id)).toEqual(['pk-1']);
    const wrongSet = [{ ...cards[0], set_name: 'Fusion Strike' }, cards[1]];
    expect(matchProducts(prods, wrongSet, 'PKMN').hits).toEqual([]);   // set gate holds
  });
  it('ambiguous label with multiple candidates stays unmatched (honest)', () => {
    const prods = [{
      product_id: 2, url: 'x', name: 'Sabo', label: 'weird promo', number: 'OP05-001',
      group_name: 'Awakening', group_abbr: 'OP05', prices: { Normal: { market_cents: 100 } },
    }];
    const cards = [
      { id: 'a', name: 'Sabo', number: 'OP05-001', set_name: 's', language: 'English' },
      { id: 'b', name: 'Sabo [Alternate Art]', number: 'OP05-001', set_name: 's', language: 'English' },
    ];
    expect(matchProducts(prods, cards, 'OP').misses.length).toBe(1);
  });
});

describe('markPrice', () => {
  it('Normal by default, Foil for foil-labeled cards, fallback when only one subtype', () => {
    const p = { prices: { Normal: { market_cents: 1000 }, Foil: { market_cents: 2500 } } };
    expect(markPrice(p, 'Pikachu')).toBe(1000);
    expect(markPrice(p, 'Pikachu [Reverse Holo]')).toBe(2500);
    expect(markPrice({ prices: { Foil: { market_cents: 900 } } }, 'Pikachu')).toBe(900);
  });
});
