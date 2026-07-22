import { describe, it, expect } from 'vitest';
import { toCents, productLabel, baseName, mapGroupProducts, CATEGORY_IDS } from '../adapters/tcgcsv.js';
import { numberKey, matchProducts, markPrice, cardSetKey, TARGETS } from '../import-tcgcsv.js';

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
  it("baseName strips Mega-era ' - 003/084' suffixes but keeps real dashes (2026-07-22)", () => {
    expect(baseName('Fomantis - 003/084')).toBe('Fomantis');
    expect(baseName('Lurantis ex - 004/084')).toBe('Lurantis ex');
    expect(baseName('Rayquaza VMAX - TG20/TG30')).toBe('Rayquaza VMAX');
    expect(baseName('Magician of Dark Chaos - Black Chaos')).toBe('Magician of Dark Chaos - Black Chaos');
    expect(baseName('Luffy & Ace ST30-001')).toBe('Luffy & Ace ST30-001');   // codes untouched
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

describe('art fallback (importTcgcsv e2e with stub fetch)', () => {
  it('fills artless cards with the product image on EXACT label match only; never overwrites', async () => {
    const { openDb } = await import('../db.js');
    const { importTcgcsv } = await import('../import-tcgcsv.js');
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, image, image_kind, external_ids) VALUES (?, 'OP', ?, 's', ?, 'English', ?, ?, '{}')`);
    ins.run('op-a', 'Sabo [Alternate Art]', 'OP05-001', null, null);          // artless, label matches → fill
    ins.run('op-b', 'Monkey.D.Luffy', 'OP05-119', 'https://own/art.png', null); // has art → untouched
    ins.run('op-c', 'Nami', 'OP05-002', null, null);                          // artless but product has label → no fill
    const groups = [{ groupId: 1, name: 'Awakening', abbreviation: 'OP05' }];
    const products = [
      { productId: 11, name: 'Sabo (001) (Alternate Art)', url: 'x', extendedData: [{ name: 'Number', value: 'OP05-001' }] },
      { productId: 12, name: 'Monkey.D.Luffy (119)', url: 'x', extendedData: [{ name: 'Number', value: 'OP05-119' }] },
      { productId: 13, name: 'Nami (002) (Parallel)', url: 'x', extendedData: [{ name: 'Number', value: 'OP05-002' }] },
    ];
    const prices = products.map(p => ({ productId: p.productId, subTypeName: 'Normal', marketPrice: 5 }));
    const stub = async (url) => ({ ok: true, json: async () => url.includes('/groups') ? groups : url.includes('/products') ? products : prices });
    await importTcgcsv(db, { ips: ['OP'], asOf: '2026-07-21', delayMs: 0, fetchImpl: stub });
    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('op-a')).toEqual({ image: 'https://tcgplayer-cdn.tcgplayer.com/product/11_in_1000x1000.jpg', image_kind: 'tcgplayer' });
    expect(img('op-b')).toEqual({ image: 'https://own/art.png', image_kind: null });   // never overwrite
    expect(img('op-c').image).toBeNull();                                              // label mismatch → honest empty
  });
});

describe('cardSetKey — PC console names bridge to TCGplayer group names (2026-07-22)', () => {
  it('strips the franchise prefix so truncated PC names hit via containment', () => {
    expect(cardSetKey('Pokemon Chaos Rising')).toBe('chaos rising');
    expect(cardSetKey('Pokemon Japanese Mysterious Mo')).toBe('mysterious mo');   // PC truncation survives
    expect(cardSetKey('Holon Phantoms')).toBe('holon phantoms');                  // canonical names untouched
    expect(cardSetKey('Pokemon Japanese VS')).toBe('pokemon japanese vs');        // too short → unstripped fallback
  });
  it('bridges new-set English satellites and Pokemon Japan groups', () => {
    const prod = (group) => [{
      product_id: 1, url: 'x', name: 'Lurantis ex', label: '', number: '004/084',
      group_name: group, group_abbr: '', prices: { Normal: { market_cents: 5000 } },
    }];
    const cards = [{ id: 'pk-pc1', name: 'Lurantis ex', number: '4', set_name: 'Pokemon Chaos Rising', language: 'English' }];
    expect(matchProducts(prod('ME04: Chaos Rising'), cards, 'PKMN').hits.map(h => h.card.id)).toEqual(['pk-pc1']);
    const ja = [{ id: 'pk-pc2', name: 'Lurantis ex', number: '4', set_name: 'Pokemon Japanese Shiny Treasure', language: 'Japanese' }];
    expect(matchProducts(prod('SV4a: Shiny Treasure ex'), ja, 'PKMN').hits.map(h => h.card.id)).toEqual(['pk-pc2']);
  });
});

describe('PKMN_JA target — Japanese-only universe (category 85)', () => {
  it('is registered with a language-scoped universe', () => {
    expect(CATEGORY_IDS.PKMN_JA).toBe(85);
    expect(TARGETS.PKMN_JA).toEqual({ ip: 'PKMN', langs: ['Japanese'] });
    expect(TARGETS.PKMN.langs).toContain('English');                 // cat 3 can never touch JP rows
  });
  it('e2e: a Japan-category product fills the Japanese row, never its English twin', async () => {
    const { openDb } = await import('../db.js');
    const { importTcgcsv } = await import('../import-tcgcsv.js');
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, image, external_ids) VALUES (?, 'PKMN', ?, ?, ?, ?, NULL, '{}')`);
    ins.run('pk-en', 'Umbreon ex', 'Prismatic Evolutions', '161', 'English');
    ins.run('pk-ja', 'Umbreon ex', 'Pokemon Japanese Terastal Fest', '161', 'Japanese');
    const groups = [{ groupId: 9, name: 'SV8a: Terastal Fest ex', abbreviation: 'SV8a', publishedOn: '2024-12-06T00:00:00' }];
    const products = [{ productId: 77, name: 'Umbreon ex - 161/187', url: 'x', extendedData: [{ name: 'Number', value: '161/187' }] }];
    const prices = [{ productId: 77, subTypeName: 'Normal', marketPrice: 800 }];
    const stub = async (url) => ({ ok: true, json: async () => url.includes('/groups') ? groups : url.includes('/products') ? products : prices });
    const res = await importTcgcsv(db, { ips: ['PKMN_JA'], asOf: '2026-07-22', delayMs: 0, fetchImpl: stub });
    expect(res.PKMN_JA.matched).toBe(1);
    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('pk-ja')).toEqual({ image: 'https://tcgplayer-cdn.tcgplayer.com/product/77_in_1000x1000.jpg', image_kind: 'tcgplayer' });
    expect(img('pk-en').image).toBeNull();                            // EN twin untouched by the JP catalog
    // Relevant-data enrichment: the group's publishedOn becomes released_at.
    expect(db.prepare(`SELECT released_at FROM cards WHERE id = 'pk-ja'`).get().released_at).toBe('2024-12-06');
    expect(db.prepare(`SELECT released_at FROM cards WHERE id = 'pk-en'`).get().released_at).toBeNull();
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

describe('art quality tiering (2026-07-22 — "match higher quality card art")', () => {
  it('a tcgplayer scan replaces a pricecharting photo, never official/borrowed art', async () => {
    const { openDb } = await import('../db.js');
    const { importTcgcsv } = await import('../import-tcgcsv.js');
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, image, image_kind, external_ids) VALUES (?, 'OP', ?, 's', ?, 'English', ?, ?, '{}')`);
    ins.run('op-a', 'Sabo', 'OP05-001', 'https://pc-photo/a.jpg', 'pricecharting');   // upgraded
    ins.run('op-b', 'Monkey.D.Luffy', 'OP05-119', 'https://official/b.png', null);   // untouched
    const groups = [{ groupId: 1, name: 'Awakening', abbreviation: 'OP05' }];
    const products = [
      { productId: 21, name: 'Sabo (001)', url: 'x', extendedData: [{ name: 'Number', value: 'OP05-001' }] },
      { productId: 22, name: 'Monkey.D.Luffy (119)', url: 'x', extendedData: [{ name: 'Number', value: 'OP05-119' }] },
    ];
    const prices = products.map(p => ({ productId: p.productId, subTypeName: 'Normal', marketPrice: 5 }));
    const stub = async (url) => ({ ok: true, json: async () => url.includes('/groups') ? groups : url.includes('/products') ? products : prices });
    await importTcgcsv(db, { ips: ['OP'], asOf: '2026-07-22', delayMs: 0, fetchImpl: stub });
    const img = (id) => db.prepare(`SELECT image, image_kind FROM cards WHERE id = ?`).get(id);
    expect(img('op-a')).toEqual({ image: 'https://tcgplayer-cdn.tcgplayer.com/product/21_in_1000x1000.jpg', image_kind: 'tcgplayer' });
    expect(img('op-b')).toEqual({ image: 'https://official/b.png', image_kind: null });
  });
});
