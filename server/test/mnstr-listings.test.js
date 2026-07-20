import { describe, it, expect } from 'vitest';
import { mapListing, makeMnstrListingsAdapter, CATEGORY_TO_IP } from '../adapters/mnstr-listings.js';

const card = (over = {}) => ({
  title: '2025 One Piece Japanese OP13 Monkey.D.Luffy Manga Alt Art #118',
  set: 'OP13', year: '2025', serialNumber: '129648888', remoteId: 'abc-1',
  grading: 'PSA 10', gradingCompany: 'psa',
  listPriceUsd: 26840, fmv: 24000,
  image: 'https://cdn.mnstr.xyz/x.jpg', category: 'one_piece',
  slug: '2025-one-piece-op13-luffy-118-129648888',
  canBeSold: true, isInStock: true, isNew: false,
  ...over,
});

describe('MNSTR listing mapper', () => {
  it('maps a graded One Piece listing with ip, grade, price, slug', () => {
    const r = mapListing(card(), '2026-07-20');
    expect(r.platform).toBe('mnstr');
    expect(r.ip).toBe('OP');
    expect(r.category).toBe('One Piece');
    expect(r.grade).toBe('PSA10');
    expect(r.price_cents).toBe(2684000);
    expect(r.currency).toBe('USDm');
    expect(r.external_id).toBe('mnstr:129648888');
    expect(r.slug).toContain('luffy');
    expect(r.fmv_usd).toBe(24000);
  });

  it('maps pokemon → PKMN and half grades', () => {
    const r = mapListing(card({ category: 'pokemon', grading: 'BGS 9.5' }));
    expect(r.ip).toBe('PKMN');
    expect(r.category).toBe('Pokemon');
    expect(r.grade).toBe('BGS9.5');
  });

  it('falls back to gradingCompany when grading lacks the grader (live raw bug, 2026-07-20)', () => {
    expect(mapListing(card({ grading: '10', gradingCompany: 'psa' })).grade).toBe('PSA10');
    expect(mapListing(card({ grading: 'GEM MINT 10', gradingCompany: 'PSA' })).grade).toBe('PSA10');
  });

  it('carries the vault serial as the slab cert number', () => {
    expect(mapListing(card()).cert).toBe('129648888');
    expect(mapListing(card({ serialNumber: 'not-a-cert', remoteId: 'x' })).cert).toBeNull();
  });

  it('normalizes BECKETT 95 → 9.5 and BGS 10 Black → BGS10', () => {
    expect(mapListing(card({ grading: 'BECKETT 95' })).grade).toBe('BGS9.5');
    expect(mapListing(card({ grading: 'BGS 10 Black' })).grade).toBe('BGS10');
  });

  it('drops unpriced or out-of-stock cards', () => {
    expect(mapListing(card({ listPriceUsd: 0 }))).toBeNull();
    expect(mapListing(card({ isInStock: false }))).toBeNull();
  });

  it('adapter filters by category + shapes rows via injected fetch', async () => {
    const data = { data: [
      card({ serialNumber: '1', category: 'pokemon', grading: 'PSA 9' }),
      card({ serialNumber: '2', category: 'basketball', grading: 'PSA 10' }), // dropped: no ip
    ] };
    const fetchImpl = async () => ({ ok: true, json: async () => data });
    const rows = await makeMnstrListingsAdapter({ fetchImpl }).fetchListings({});
    expect(rows.length).toBe(1);
    expect(rows[0].ip).toBe('PKMN');
  });

  it('category map', () => {
    expect(CATEGORY_TO_IP.pokemon).toBe('PKMN');
    expect(CATEGORY_TO_IP.one_piece).toBe('OP');
  });
});
