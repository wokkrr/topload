import { describe, it, expect } from 'vitest';
import { median, stddev, flagOutliers, computeMark, confidenceScore, harvestAltFmvMarks, refreshOracle, EXTERNAL_SOURCES } from '../oracle.js';
import { openDb } from '../db.js';

describe('median / stddev', () => {
  it('computes median for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('stddev of constant series is 0', () => {
    expect(stddev([5, 5, 5])).toBe(0);
  });
});

describe('flagOutliers', () => {
  const sale = (p) => ({ price_cents: p });

  it('flags a shill-priced sale far above trailing median', () => {
    const sales = [100, 102, 98, 101, 99, 100, 103, 97, 300].map(s => sale(s * 100));
    const flags = flagOutliers(sales);
    expect(flags[8]).toBe(true);
    expect(flags.slice(0, 8).every(f => !f)).toBe(true);
  });

  it('flags a damaged-card lowball', () => {
    const sales = [100, 102, 98, 101, 99, 100, 30].map(s => sale(s * 100));
    expect(flagOutliers(sales)[6]).toBe(true);
  });

  it('does not poison the trailing window with an outlier', () => {
    // After the 300 outlier, normal-priced sales must NOT be flagged.
    const sales = [100, 102, 98, 101, 99, 100, 300, 101, 99].map(s => sale(s * 100));
    const flags = flagOutliers(sales);
    expect(flags[6]).toBe(true);
    expect(flags[7]).toBe(false);
    expect(flags[8]).toBe(false);
  });

  it('never flags before a minimum window exists', () => {
    const sales = [100, 900, 100, 900].map(s => sale(s * 100));
    expect(flagOutliers(sales).every(f => !f)).toBe(true);
  });

  it('tolerates legitimate price movement (trend, not spike)', () => {
    // Gradual 1.5%/step uptrend should not be flagged.
    const sales = [];
    let p = 100;
    for (let i = 0; i < 30; i++) { sales.push(sale(Math.round(p * 100))); p *= 1.015; }
    expect(flagOutliers(sales).every(f => !f)).toBe(true);
  });
});

describe('computeMark', () => {
  const mk = (price, daysAgo, asOf = '2026-07-18') => ({
    price_cents: price * 100,
    sold_at: new Date(new Date(asOf).getTime() - daysAgo * 86_400_000).toISOString(),
  });

  it('returns median of the 14d window', () => {
    const sales = [mk(100, 1), mk(110, 2), mk(105, 3), mk(500, 40)];
    const m = computeMark(sales, '2026-07-18');
    expect(m.price_cents).toBe(105 * 100);
    expect(m.n).toBe(3);
  });

  it('expands to 30d when 14d window is thin', () => {
    const sales = [mk(100, 1), mk(110, 20), mk(105, 25)];
    const m = computeMark(sales, '2026-07-18');
    expect(m.n).toBe(3);
    expect(m.price_cents).toBe(105 * 100);
  });

  it('returns null when there are too few sales even at 30d', () => {
    expect(computeMark([mk(100, 1)], '2026-07-18')).toBeNull();
  });

  it('ignores future sales relative to asOf', () => {
    const sales = [mk(100, 1), mk(102, 2), mk(98, 3), mk(999, -5)];
    const m = computeMark(sales, '2026-07-18');
    expect(m.price_cents).toBe(100 * 100);
  });
});

describe('confidenceScore', () => {
  it('is 0 with no sales and rises with liquidity', () => {
    expect(confidenceScore({ n: 0, cv: 0, recentShare: 0 })).toBe(0);
    const low = confidenceScore({ n: 3, cv: 0.1, recentShare: 0.5 });
    const high = confidenceScore({ n: 12, cv: 0.1, recentShare: 0.5 });
    expect(high).toBeGreaterThan(low);
  });
  it('penalizes dispersion', () => {
    const tight = confidenceScore({ n: 10, cv: 0.05, recentShare: 0.5 });
    const noisy = confidenceScore({ n: 10, cv: 0.6, recentShare: 0.5 });
    expect(tight).toBeGreaterThan(noisy);
  });
  it('is bounded in [0,1]', () => {
    const c = confidenceScore({ n: 100, cv: 0, recentShare: 1 });
    expect(c).toBeLessThanOrEqual(1);
    expect(c).toBeGreaterThan(0.9);
  });
});

describe('altfmv — platform fair-market values blended as an external source (2026-07-22)', () => {
  const DAY = '2026-07-22';
  function seed() {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('pk-1', 'PKMN', 'Umbreon', 's', '1', 'English', '{}')`).run();
    const insL = db.prepare(
      `INSERT INTO gacha_listings (platform, external_id, card_id, item_name, category, grade, price_cents, currency, fmv_usd, seen_at)
       VALUES (?, ?, ?, 'x', 'Pokemon', ?, 1000, 'USDC', ?, ?)`);
    // Three matched listings, same card+grade, one mispriced outlier → median holds.
    insL.run('beezie', 'b1', 'pk-1', 'PSA10', 100, DAY);
    insL.run('beezie', 'b2', 'pk-1', 'PSA10', 110, DAY);
    insL.run('phygitals', 'p1', 'pk-1', 'PSA10', 900, DAY);
    // Unmatched / fmv-less / stale rows never produce marks.
    insL.run('beezie', 'b3', null, 'PSA10', 55, DAY);
    insL.run('beezie', 'b4', 'pk-1', 'PSA9', null, DAY);
    insL.run('beezie', 'b5', 'pk-1', 'PSA9', 70, '2026-07-20');
    return db;
  }

  it('registry: sits between pricecharting and tcgplayer', () => {
    expect(EXTERNAL_SOURCES.altfmv.priority).toBeGreaterThan(EXTERNAL_SOURCES.pricecharting.priority);
    expect(EXTERNAL_SOURCES.altfmv.priority).toBeLessThan(EXTERNAL_SOURCES.tcgplayer.priority);
    expect(EXTERNAL_SOURCES.altfmv.discount).toBe(0.65);
  });

  it('harvest: median per (card, grade), matched+valued rows only, idempotent', () => {
    const db = seed();
    const res = harvestAltFmvMarks(db, DAY);
    expect(res).toEqual({ listingsWithFmv: 3, marks: 1 });
    const m = db.prepare(`SELECT price_cents FROM external_marks WHERE source = 'altfmv' AND card_id = 'pk-1' AND grade = 'PSA10' AND as_of = ?`).get(DAY);
    expect(m.price_cents).toBe(11000);                       // median 110, not mean 370
    harvestAltFmvMarks(db, DAY);                             // re-run → same single mark
    expect(db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE source = 'altfmv'`).get().n).toBe(1);
  });

  it('oracle: altfmv backs the mark when no solds/pricecharting exist, and loses to pricecharting', () => {
    const db = seed();
    harvestAltFmvMarks(db, DAY);
    refreshOracle(db, [DAY]);
    let o = db.prepare(`SELECT price_cents, basis, source, confidence FROM oracle_prices WHERE card_id = 'pk-1' AND grade = 'PSA10' AND as_of = ?`).get(DAY);
    expect(o).toMatchObject({ price_cents: 11000, basis: 'external', source: 'altfmv' });
    expect(o.confidence).toBeCloseTo(0.65, 2);               // same-day: no staleness decay
    // A pricecharting observation for the same (card, grade, day) outranks it.
    db.prepare(`INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', 'pk-1', 'PSA10', ?, 12000)`).run(DAY);
    refreshOracle(db, [DAY]);
    o = db.prepare(`SELECT price_cents, source FROM oracle_prices WHERE card_id = 'pk-1' AND grade = 'PSA10' AND as_of = ?`).get(DAY);
    expect(o).toMatchObject({ price_cents: 12000, source: 'pricecharting' });
  });
});
