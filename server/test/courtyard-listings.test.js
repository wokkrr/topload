import { describe, it, expect } from 'vitest';
import { mapListing, makeCourtyardListingsAdapter, CATEGORY_TO_IP } from '../adapters/courtyard-listings.js';

// A real-shaped asset from /index/recently-listed (fields trimmed).
const asset = (over = {}) => ({
  title: '2024 Twilight Masquerade TWM EN #191/167 Magcargo ex CGC 10',
  image: 'https://static.courtyard.io/graded-cards/abc.png',
  token_id: '106412475800000000000000000000000000000000000',
  contract: '0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD',
  chain: 'polygon',
  fmv_estimate_usd: 19,
  attributes: [
    { name: 'Grader', value: 'CGC' },
    { name: 'Serial', value: '6119147138' },
    { name: 'Grade', value: '10 GEM MINT' },
    { name: 'Category', value: 'Pokémon' },
    { name: 'Year', value: '2024' },
    { name: 'Set', value: 'Twilight Masquerade' },
    { name: 'Title/Subject', value: 'Magcargo ex' },
    { name: 'Card Number', value: '191/167' },
  ],
  listing_data: [{ price: { amount: { usd: 18.81 } }, side: 'sell', listedAt: '2026-07-20T02:46:26Z', orderId: '133' }],
  ...over,
});

describe('Courtyard listing mapper', () => {
  it("captures the 'Serial' attribute as the slab cert number, digits-guarded", () => {
    expect(mapListing(asset()).cert).toBe('6119147138');
    expect(mapListing(asset({ attributes: [
      { name: 'Grader', value: 'CGC' }, { name: 'Serial', value: 'ABC-123' },
      { name: 'Grade', value: '10' }, { name: 'Category', value: 'Pokémon' },
    ] })).cert).toBeNull();
  });

  it('maps a graded Pokémon listing with price, grade, ip', () => {
    const r = mapListing(asset(), '2026-07-20');
    expect(r.platform).toBe('courtyard');
    expect(r.ip).toBe('PKMN');
    expect(r.grade).toBe('CGC10');
    expect(r.price_cents).toBe(1881);
    expect(r.currency).toBe('USDC');
    expect(r.external_id).toContain('courtyard:');
    expect(r.listed_at).toBe('2026-07-20');
    expect(r.fmv_usd).toBe(19);
  });

  it('normalizes half grades and non-Pokémon categories', () => {
    const r = mapListing(asset({ attributes: [
      { name: 'Grader', value: 'PSA' }, { name: 'Grade', value: '9.5 MINT' },
      { name: 'Category', value: 'Basketball' },
    ] }));
    expect(r.grade).toBe('PSA9.5');
    expect(r.ip).toBe(null); // dropped by ingest IP scoping
  });

  it('drops unpriced / bid-only listings', () => {
    expect(mapListing(asset({ listing_data: [] }))).toBeNull();
    expect(mapListing(asset({ listing_data: [{ price: { amount: { usd: 0 } }, side: 'sell' }] }))).toBeNull();
  });

  it('falls back to raw when no grade attributes', () => {
    const r = mapListing(asset({ title: 'Booster Pack', attributes: [{ name: 'Category', value: 'Pokémon' }] }));
    expect(r.grade).toBe('raw');
  });

  it('maps One Piece and Yu-Gi-Oh categories', () => {
    expect(CATEGORY_TO_IP['One Piece']).toBe('OP');
    expect(CATEGORY_TO_IP['Yu-Gi-Oh!']).toBe('YGO');
  });

  it('adapter pages + dedupes via injected fetch, filters by category', async () => {
    const pages = [
      { assets: [asset({ token_id: '1' }), asset({ token_id: '2', attributes: [{ name: 'Category', value: 'Basketball' }, { name: 'Grader', value: 'PSA' }, { name: 'Grade', value: '10' }], listing_data: [{ price: { amount: { usd: 5 } }, side: 'sell' }] })] },
      { assets: [asset({ token_id: '1' })] }, // repeat → no new → stop
    ];
    let call = 0;
    const fetchImpl = async () => ({ ok: true, json: async () => pages[call++] ?? { assets: [] } });
    const yard = makeCourtyardListingsAdapter({ fetchImpl, throttleMs: 0 });
    const rows = await yard.fetchListings({ categories: ['Pokémon'], maxPages: 5 });
    expect(rows.length).toBe(1);          // basketball filtered out, dup collapsed
    expect(rows[0].ip).toBe('PKMN');
  });
});

describe('proof passthrough (buy-link)', () => {
  it('carries proof_of_integrity for the courtyard.io/asset/<proof> page', () => {
    const r = mapListing({ ...({}), title: 'X CGC 10', token_id: '9', proof_of_integrity: 'abc123',
      attributes: [{ name: 'Category', value: 'Pokémon' }, { name: 'Grader', value: 'CGC' }, { name: 'Grade', value: '10' }],
      listing_data: [{ price: { amount: { usd: 10 } }, side: 'sell' }] });
    expect(r.proof).toBe('abc123');
  });
});
