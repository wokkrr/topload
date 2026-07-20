import { describe, it, expect } from 'vitest';
import { makePriceChartingAdapter } from '../adapters/pricecharting.js';
import { makePokemonTcgAdapter } from '../adapters/pokemontcg.js';
import { makeEbayBrowseAdapter, parseGrade } from '../adapters/ebay.js';
import { openDb } from '../db.js';
import { refreshOracle, EXTERNAL_CONFIDENCE_DISCOUNT } from '../oracle.js';

const jsonRes = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('pricecharting adapter (fixtures)', () => {
  // Response shape per API docs: prices in integer pennies.
  const productFixture = {
    status: 'success', id: '5757552', 'product-name': 'Charizard ex #199', 'console-name': 'Pokemon 151',
    'loose-price': 24551, 'graded-price': 44943, 'manual-only-price': 82500, 'box-only-price': 60000,
    'bgs-10-price': 155000, 'retail-loose-buy': 19000,
  };

  it('maps price fields to grades and skips absent fields', async () => {
    const pc = makePriceChartingAdapter({ apiKey: 'k', fetchImpl: () => jsonRes(productFixture) });
    const marks = await pc.fetchExternalMarks(
      [{ id: 'pkmn-x', external_ids: { pricecharting: '5757552' } }], '2026-07-19');
    const byGrade = Object.fromEntries(marks.map(m => [m.grade, m.price_cents]));
    expect(byGrade.raw).toBe(24551);
    expect(byGrade.PSA9).toBe(44943);
    expect(byGrade.PSA10).toBe(82500);
    expect(byGrade.BGS10).toBe(155000);
    expect(marks.every(m => m.source === 'pricecharting' && m.as_of === '2026-07-19')).toBe(true);
    expect(byGrade['retail-loose-buy']).toBeUndefined();
  });

  it('skips cards without a resolved pricecharting id', async () => {
    const pc = makePriceChartingAdapter({ apiKey: 'k', fetchImpl: () => jsonRes(productFixture) });
    const marks = await pc.fetchExternalMarks([{ id: 'x', external_ids: {} }], '2026-07-19');
    expect(marks).toEqual([]);
  });

  it('surfaces API error payloads', async () => {
    const pc = makePriceChartingAdapter({
      apiKey: 'k',
      fetchImpl: () => jsonRes({ status: 'error', 'error-message': 'invalid token' }),
    });
    await expect(pc.resolveProduct('x')).rejects.toThrow(/invalid token/);
  });

  it('never supplies raw sales (solds-only invariant)', async () => {
    const pc = makePriceChartingAdapter({ apiKey: 'k', fetchImpl: () => jsonRes({}) });
    expect(await pc.fetchSales()).toEqual([]);
  });
});

describe('pokemontcg adapter (fixtures)', () => {
  const page = {
    totalCount: 2,
    data: [
      { name: 'Charizard ex', number: '199', rarity: 'Special Illustration Rare',
        set: { id: 'sv3pt5', name: '151', printedTotal: 165 }, id: 'sv3pt5-199',
        tcgplayer: { prices: { holofoil: { market: 245.5, low: 200 } } } },
      { name: 'Energy', number: '12', rarity: 'Common',
        set: { id: 'sv3pt5', name: '151', printedTotal: 165 }, id: 'sv3pt5-12',
        tcgplayer: { prices: { normal: { market: 0.25 } } } },
    ],
  };

  it('keeps chase rarities, drops commons, shapes CardRecords', async () => {
    const ptcg = makePokemonTcgAdapter({
      fetchImpl: () => jsonRes(page),
      sets: [{ ptcgioId: 'sv3pt5', label: '151' }],
    });
    const cards = await ptcg.listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'pkmn-sv3pt5-199', ip: 'PKMN', number: '199/165', // canonical scheme: pkmn-<ptcgio id>
    });
    expect(cards[0].external_ids.pcQuery).toContain('Charizard ex');
  });

  it('maps TCGplayer market snapshots to raw external marks for tracked cards only', async () => {
    const ptcg = makePokemonTcgAdapter({
      fetchImpl: () => jsonRes(page),
      sets: [{ ptcgioId: 'sv3pt5', label: '151' }],
    });
    const marks = await ptcg.fetchExternalMarks([{ id: 'pkmn-sv3pt5-199' }], '2026-07-19');
    expect(marks).toHaveLength(1); // untracked Energy card skipped
    expect(marks[0]).toEqual({
      source: 'tcgplayer', card_id: 'pkmn-sv3pt5-199',
      grade: 'raw', as_of: '2026-07-19', price_cents: 24550,
    });
  });
});

describe('ebay browse adapter', () => {
  it('parses grades from listing titles', () => {
    expect(parseGrade('Charizard ex 199/165 PSA 10 GEM MINT')).toBe('PSA10');
    expect(parseGrade('Shanks OP01-120 bgs 9.5 one piece')).toBe('BGS9.5');
    expect(parseGrade('Umbreon VMAX Alt Art CGC 10')).toBe('CGC10');
    expect(parseGrade('Pikachu promo near mint')).toBe('raw');
  });

  it('maps listings and appends EPN affiliate params', async () => {
    const fetchImpl = (url) => {
      if (String(url).includes('oauth2')) return jsonRes({ access_token: 't', expires_in: 7200 });
      return jsonRes({ itemSummaries: [{
        itemId: 'v1|123|0', title: 'Charizard ex PSA 10',
        price: { value: '825.00', currency: 'USD' },
        itemWebUrl: 'https://www.ebay.com/itm/123',
        image: { imageUrl: 'https://i.ebayimg.com/x.jpg' }, seller: { username: 'cards4u' },
      }] });
    };
    const ebay = makeEbayBrowseAdapter({ clientId: 'a', clientSecret: 'b', epnCampaignId: '555', fetchImpl });
    const [l] = await ebay.fetchListings({ id: 'pkmn-x', name: 'Charizard ex', external_ids: {} });
    expect(l).toMatchObject({ card_id: 'pkmn-x', grade: 'PSA10', price_cents: 82500 });
    expect(l.url).toContain('campid=555');
  });
});

describe('oracle external-mark bootstrap', () => {
  it('uses external marks with discounted confidence only where solds are absent', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name) VALUES ('c1','PKMN','X')`).run();
    // Raw solds only on d1..d3 (enough for a mark on those days)
    const insSale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('c1','raw',?,?,'demo',?)`);
    ['2026-07-10', '2026-07-11', '2026-07-12'].forEach((d, i) => insSale.run(10000 + i, `${d}T12:00:00Z`, `s${i}`));
    // External marks daily
    const insExt = db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting','c1','PSA10',?,?)`);
    insExt.run('2026-07-12', 50000);

    const res = refreshOracle(db, ['2026-07-12', '2026-07-13']);
    const solds = db.prepare(`SELECT * FROM oracle_prices WHERE grade='raw' AND as_of='2026-07-12'`).get();
    const ext = db.prepare(`SELECT * FROM oracle_prices WHERE grade='PSA10' AND as_of='2026-07-12'`).get();
    const extStale = db.prepare(`SELECT * FROM oracle_prices WHERE grade='PSA10' AND as_of='2026-07-13'`).get();

    expect(solds.basis).toBe('solds');
    expect(ext.basis).toBe('external');
    expect(ext.price_cents).toBe(50000);
    expect(ext.confidence).toBeCloseTo(EXTERNAL_CONFIDENCE_DISCOUNT, 3); // fresh same-day
    expect(extStale.confidence).toBeLessThan(ext.confidence);            // staleness decay
    expect(res.externalMarks).toBeGreaterThan(0);
  });

  it('prefers pricecharting over tcgplayer and applies per-source discounts', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name) VALUES ('c1','PKMN','X')`).run();
    const insExt = db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES (?,'c1','raw',?,?)`);
    insExt.run('tcgplayer', '2026-07-19', 20000);
    insExt.run('pricecharting', '2026-07-19', 24000);

    refreshOracle(db, ['2026-07-19']);
    const mark = db.prepare(`SELECT * FROM oracle_prices WHERE grade='raw' AND as_of='2026-07-19'`).get();
    expect(mark.source).toBe('pricecharting');       // higher priority wins
    expect(mark.price_cents).toBe(24000);
    expect(mark.confidence).toBeCloseTo(0.7, 3);

    // tcgplayer-only card gets the harder discount
    db.prepare(`INSERT INTO cards (id, ip, name) VALUES ('c2','PKMN','Y')`).run();
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('tcgplayer','c2','raw','2026-07-19', 5000)`).run();
    refreshOracle(db, ['2026-07-19']);
    const m2 = db.prepare(`SELECT * FROM oracle_prices WHERE card_id='c2'`).get();
    expect(m2.source).toBe('tcgplayer');
    expect(m2.confidence).toBeCloseTo(0.5, 3);
  });

  it('never lets an external mark override a solds mark', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name) VALUES ('c1','PKMN','X')`).run();
    const insSale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('c1','raw',?,?,'demo',?)`);
    ['2026-07-10', '2026-07-11', '2026-07-12'].forEach((d, i) => insSale.run(10000, `${d}T12:00:00Z`, `s${i}`));
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting','c1','raw','2026-07-12', 99999)`).run();

    refreshOracle(db, ['2026-07-12']);
    const mark = db.prepare(`SELECT * FROM oracle_prices WHERE grade='raw' AND as_of='2026-07-12'`).get();
    expect(mark.basis).toBe('solds');
    expect(mark.price_cents).toBe(10000);
  });
});
