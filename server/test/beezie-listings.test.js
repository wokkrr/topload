import { describe, it, expect } from 'vitest';
import { mapItem, slugFor, attrsOf, makeBeezieListingsAdapter, CHAINS } from '../adapters/beezie-listings.js';

// Live shape captured 2026-07-22 from api.beezie.com/dropItems/byCategory.
const ITEM = {
  id: 8910, tokenId: 8657, activeDropId: null,
  creatorAddress: '0x9dD1', creatorCommissionPercentage: '0.01', creatorCountryCode: 'US',
  owner: '0xb7bd', transferedAt: 1762786727000, categoryId: 1,
  altFmv: '42.50', altFmvLastFetchedAt: null, altAssetId: null, claimId: null,
  SellOrder: { amountUSDC: '30.00', createdAt: 1778511286071 },
  metadata: {
    name: '2002 Neo Destiny 1st Edition Unown Z #60 TAG 8.5',
    image: 'https://images.beezie.com/flow/8657/0/original.jpg',
    attributes: [
      { trait_type: 'year', trait_value: '2002' },
      { trait_type: 'grader', trait_value: 'TAG' },
      { trait_type: 'grade', trait_value: '8.5' },
      { trait_type: 'language', trait_value: 'English' },
      { trait_type: 'pokemon name', trait_value: 'Unown Z' },
      { trait_type: 'set name', trait_value: 'Neo Destiny' },
      { trait_type: 'card number', trait_value: '60' },
      { trait_type: 'serial', trait_value: 'G8931670' },
    ],
  },
};

describe('beezie mapItem', () => {
  it('maps the live shape: grade, cents, ISO listed_at, chain-prefixed ids, cert, fmv', () => {
    const r = mapItem(ITEM, 'PKMN', 'base', 'https://beezie.com', '2026-07-22');
    expect(r).toMatchObject({
      platform: 'beezie',
      external_id: 'beezie:base:8910',
      item_name: '2002 Neo Destiny 1st Edition Unown Z #60 TAG 8.5',
      category: 'Pokemon', ip: 'PKMN',
      grade: 'TAG8.5',
      price_cents: 3000,
      currency: 'USDC',
      cert: 'G8931670',
      language: 'English',
      fmv_usd: 42.5,
      nft_address: 'base:8657',
    });
    expect(r.listed_at).toBe(new Date(1778511286071).toISOString());
    // Site URLs key on TOKEN id (item.id 404s — live 2026-07-22).
    expect(r.slug).toBe('base:2002-Neo-Destiny-1st-Edition-Unown-Z-60-TAG-85-8657');
    // White-background slab scans (idx 2 front / 3 back), not the dark tiles.
    expect(r.image).toBe('https://images.beezie.com/base/8657/2/original.jpg');
    expect(r.image_back).toBe('https://images.beezie.com/base/8657/3/original.jpg');
  });
  it('skips unpriced items and troll asks', () => {
    expect(mapItem({ ...ITEM, SellOrder: null }, 'PKMN', 'base', 'x', 'd')).toBeNull();
    expect(mapItem({ ...ITEM, SellOrder: { amountUSDC: '999999999' } }, 'PKMN', 'base', 'x', 'd')).toBeNull();
  });
  it('slugFor matches their live URL scheme (#OP03-047 → OP03047, Vol. 1 → Vol-1)', () => {
    expect(slugFor('2023 Pillars of Strength Zeff #OP03-047 PSA 9', 302))
      .toBe('2023-Pillars-of-Strength-Zeff-OP03047-PSA-9-302');
    expect(slugFor('2022 Tournament Pack Vol. 1 Monkey D. Luffy #P-006 PSA 8', 281))
      .toBe('2022-Tournament-Pack-Vol-1-Monkey-D-Luffy-P006-PSA-8-281');
  });
  it('attrsOf lowercases trait keys', () => {
    expect(attrsOf(ITEM)['set name']).toBe('Neo Destiny');
  });
});

describe('beezie adapter pagination', () => {
  it('walks both chains and categories, stops on short page', async () => {
    const calls = [];
    const stub = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(`${new URL(url).host}|cat${body.categoryId}|p${body.page}`);
      // first page full (2 of pageSize 2), second short (0) → stop per bucket
      const items = body.page === '0' ? [ITEM, { ...ITEM, id: 9000 }] : [];
      return { ok: true, json: async () => ({ dropItems: items, total: 2 }) };
    };
    const a = makeBeezieListingsAdapter({ fetchImpl: stub, perPage: 2, chains: CHAINS });
    const rows = await a.fetchListings({ seenAt: '2026-07-22' });
    expect(rows.length).toBe(8);                                   // 2 chains × 2 cats × 2 items
    expect(calls).toContain('api.beezie.com|cat1|p0');
    expect(calls).toContain('flow-api.beezie.com|cat2|p1');        // paged past the full page
    expect(new Set(rows.map(r => r.external_id)).size).toBe(4);    // ids chain-prefixed, distinct per chain
  });
});
