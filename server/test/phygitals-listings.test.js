import { describe, it, expect } from 'vitest';
import { mapListing, makePhygitalsListingsAdapter, CATEGORIES } from '../adapters/phygitals-listings.js';

// Live fixtures, captured 2026-07-21 from api.phygitals.com via the site's own
// marketplace-listings endpoint (fields not consumed by the adapter trimmed).
const meta = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));

const PSA_JP_PROMO = {
  address: 'HENiKKf8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  slug: '2016-pokemon-jpn-xy-promo-294-f-dn3l7x',
  name: '2016 POKEMON JPN XY PROMO #294 F',            // NB: truncated by their API
  image: 'https://gateway.irys.xyz/img1',
  price: '49000000000',                                 // micro-USDC = $49,000
  lastSale: '0',
  listed: true,
  altFmv: '30261.01207386364',
  updatedAt: '2026-07-21T01:34:47.973Z',
  metadata: meta({
    Grade: 'PSA 10.0', Grader: 'PSA', 'Cert Number': '26927218',
    Title: '2016 POKEMON JPN XY PROMO #294 FULL ART/MARIO',
    Category: 'Pokemon', Language: 'Japanese',
  }),
};

const RAW_EN_GLALIE = {
  address: 'JCGy6gvKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  slug: '2022-glalie-silver-tempest-042-3ocrz4',
  name: '2022 Glalie Silver Tempest #042',
  image: 'https://gateway.irys.xyz/img2',
  price: '8300000',                                     // $8.30
  listed: true,
  updatedAt: '2026-07-20T10:39:04.821Z',
  metadata: meta({
    Name: 'Glalie', 'Set ID': 'swsh12', Set: 'Silver Tempest',
    'Card Id': 'swsh12-42', Language: 'English', Grade: '',
  }),
};

const CGC_OP_LUFFY = {
  address: 'EZ61gMkCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  slug: '2022-one-piece-promo-cards-monke-jg55f8',
  name: '2022 One Piece Promo Cards Monke',
  price: '100000000000',                                // $100,000 — above FMV but real
  listed: true,
  altFmv: '36.25305178499516',
  updatedAt: '2026-07-20T20:54:10.210Z',
  metadata: meta({
    Grade: 'CGC 10.0', Grader: 'CGC', 'Cert Number': '6135654030',
    Title: '2022 One Piece Promo Cards Monkey D. Luffy #P',
    Language: 'English', Category: 'One Piece',
  }),
};

describe('mapListing', () => {
  it('maps a graded Japanese Pokémon listing (full Title, language token, cert)', () => {
    const r = mapListing(PSA_JP_PROMO, 'Pokemon', '2026-07-21');
    expect(r).toMatchObject({
      platform: 'phygitals',
      external_id: `phyg:${PSA_JP_PROMO.address}`,
      item_name: '2016 POKEMON JPN XY PROMO #294 FULL ART/MARIO', // Title, not truncated name
      category: 'Pokemon', ip: 'PKMN',
      grade: 'PSA10',
      price_cents: 4_900_000,
      currency: 'USDC',
      listed_at: '2026-07-21T01:34:47.973Z',   // full ISO kept for recency sorting
      cert: '26927218',
      slug: '2016-pokemon-jpn-xy-promo-294-f-dn3l7x',
      language: 'Japanese',
    });
    // Japanese listing must NEVER exact-attach to an English pkmn-* row.
    expect(r.exact_card_id).toBeNull();
  });

  it('keeps the Japanese title untouched when it already carries a language token', () => {
    // 'JPN' is in the title → no ' Japanese' suffix appended.
    const r = mapListing(PSA_JP_PROMO, 'Pokemon', '2026-07-21');
    expect(r.item_name.endsWith('Japanese')).toBe(false);
  });

  it('appends Japanese for the matcher when title lacks a token', () => {
    const jp = { ...RAW_EN_GLALIE, metadata: meta({ Title: '2023 Pikachu Promo #001', Language: 'Japanese' }) };
    expect(mapListing(jp, 'Pokemon', '2026-07-21').item_name).toBe('2023 Pikachu Promo #001 Japanese');
  });

  it('maps a raw English Pokémon listing with exact Card Id attach', () => {
    const r = mapListing(RAW_EN_GLALIE, 'Pokemon', '2026-07-21');
    expect(r).toMatchObject({ grade: 'raw', price_cents: 830, exact_card_id: 'pkmn-swsh12-42', cert: null });
  });

  it('maps a CGC One Piece listing', () => {
    const r = mapListing(CGC_OP_LUFFY, 'One Piece', '2026-07-21');
    expect(r).toMatchObject({ ip: 'OP', category: 'One Piece', grade: 'CGC10', cert: '6135654030', price_cents: 10_000_000 });
    expect(r.exact_card_id).toBeNull();                 // Card Id shortcut is PKMN-only
  });

  it('falls back to CC-style vault keys for grade and cert', () => {
    const cc = { ...CGC_OP_LUFFY, metadata: meta({ 'The Grade': 'GEM MINT 10', 'Grading Company': 'CGC', 'Grading ID': '9998887770', Title: 'Uta OP01-005' }) };
    const r = mapListing(cc, 'One Piece', '2026-07-21');
    expect(r.grade).toBe('CGC10');
    expect(r.cert).toBe('9998887770');
  });

  it("attributes CC-vaulted mirrors (vault:'cc') to the host platform, keeping phyg: provenance", () => {
    // Live shape 2026-07-21 (CGC-10 Mew flag): vault:'cc' + marketplace
    // 'MAGICEDEN' = a Collector Crypt-vaulted item mirrored on Phygitals;
    // native rows carry vault:null + 'TENSOR'.
    const cc = { ...PSA_JP_PROMO, vault: 'cc', marketplace: 'MAGICEDEN' };
    const r = mapListing(cc, 'Pokemon', '2026-07-21');
    expect(r.platform).toBe('collectorcrypt');           // desk says "listed on Collector Crypt"
    expect(r.external_id).toBe(`phyg:${PSA_JP_PROMO.address}`); // snapshot-replace key unchanged
    expect(r.nft_address).toBe(PSA_JP_PROMO.address);    // listingUrl → collectorcrypt.com/assets/solana/<mint>
    expect(mapListing({ ...PSA_JP_PROMO, vault: null }, 'Pokemon', '2026-07-21').platform).toBe('phygitals');
  });

  it('drops troll asks, unlisted, and zero prices; keeps Authentic slabs', () => {
    expect(mapListing({ ...RAW_EN_GLALIE, price: '999999999000000' }, 'Pokemon', 'd')).toBeNull();
    expect(mapListing({ ...RAW_EN_GLALIE, listed: false }, 'Pokemon', 'd')).toBeNull();
    expect(mapListing({ ...RAW_EN_GLALIE, price: '0' }, 'Pokemon', 'd')).toBeNull();
    const auth = { ...CGC_OP_LUFFY, metadata: meta({ Grader: 'CGC', Title: 'Luffy CGC Authentic' }) };
    expect(mapListing(auth, 'One Piece', 'd').grade).toBe('CGCAuth');
  });
});

describe('makePhygitalsListingsAdapter', () => {
  it('paginates 0-based per category and stops on a short page', async () => {
    const calls = [];
    const page0 = Array.from({ length: 3 }, (_, i) => ({ ...RAW_EN_GLALIE, address: `A${i}`, slug: `s${i}` }));
    const fetchImpl = async (url) => {
      const u = new URL(url);
      calls.push([JSON.parse(u.searchParams.get('metadataConditions')).category[0], u.searchParams.get('page')]);
      return { ok: true, json: async () => ({ listings: calls.length === 1 ? page0 : [] }) };
    };
    const rows = await makePhygitalsListingsAdapter({ fetchImpl, perPage: 3 }).fetchListings({ seenAt: '2026-07-21' });
    // Pokemon page0 was full (3 = perPage) → page1 fetched (empty, stop);
    // OP and YGO each stop after one empty page.
    expect(calls).toEqual([['Pokemon', '0'], ['Pokemon', '1'], ['One Piece', '0'], ['Yu-Gi-Oh!', '0']]);
    expect(rows).toHaveLength(3);
    expect(CATEGORIES).toContain('Yu-Gi-Oh!');
  });

  it('throws on HTTP errors so ingest can rollback', async () => {
    const bad = makePhygitalsListingsAdapter({ fetchImpl: async () => ({ ok: false, status: 403 }) });
    await expect(bad.fetchListings({})).rejects.toThrow(/403/);
  });
});

describe('fixImageUrl', () => {
  it('rewrites browser-hostile irys gateway URLs to their CDN, leaves others alone', async () => {
    const { fixImageUrl } = await import('../adapters/phygitals-listings.js');
    expect(fixImageUrl('https://gateway.irys.xyz/52yzJNjNdyy1rJKeDT6QRpnH4Q7iYnXRzEaDuENvURZq'))
      .toBe('https://img.phygitals.com/52yzJNjNdyy1rJKeDT6QRpnH4Q7iYnXRzEaDuENvURZq'); // PLAIN — matches their own presentation; '-cropped' exists for only some items
    expect(fixImageUrl('https://arweave.net/abc123')).toBe('https://arweave.net/abc123');
    expect(fixImageUrl(null)).toBeNull();
  });
});

describe('listTime', () => {
  it('prefers the listing EVENT over updatedAt and normalizes epoch forms', async () => {
    const { listTime } = await import('../adapters/phygitals-listings.js');
    expect(listTime({ mostRecentListActivity: { time: '2026-07-18T09:00:00.000Z' }, updatedAt: '2026-07-21T01:00:00.000Z' }))
      .toBe('2026-07-18T09:00:00.000Z');                 // an edit must not restamp recency
    expect(listTime({ mostRecentListActivity: { time: '1784600271796' } }))
      .toBe(new Date(1784600271796).toISOString());
    expect(listTime({ updatedAt: '2026-07-20T10:39:04.821Z' })).toBe('2026-07-20T10:39:04.821Z');
    expect(listTime({})).toBeNull();
  });
});
