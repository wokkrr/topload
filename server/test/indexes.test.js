import { describe, it, expect } from 'vitest';
import { selectBasket, computeIndexSeries } from '../indexes.js';

describe('selectBasket', () => {
  const cand = (id, sales_90d, price, weekly, confidence = 0.8) =>
    ({ card_id: id, grade: 'raw', sales_90d, price_cents: price * 100, weekly_sales: weekly, confidence });

  it('picks top-N by 90D sales volume', () => {
    const basket = selectBasket([cand('a', 100, 50, 10), cand('b', 50, 50, 5), cand('c', 10, 50, 1)], { topN: 2 });
    expect(basket.map(b => b.card_id)).toEqual(['a', 'b']);
  });

  it('excludes low-confidence series regardless of volume', () => {
    const basket = selectBasket([cand('a', 500, 50, 10, 0.1), cand('b', 50, 50, 5)], { topN: 5, minConfidence: 0.3 });
    expect(basket.map(b => b.card_id)).toEqual(['b']);
  });

  it('weights by dollar liquidity (price × weekly sales) and sums to 1', () => {
    const basket = selectBasket([cand('a', 100, 100, 10), cand('b', 90, 100, 5)], { topN: 2 });
    const wa = basket.find(b => b.card_id === 'a').weight;
    const wb = basket.find(b => b.card_id === 'b').weight;
    expect(wa).toBeCloseTo(2 / 3, 5);
    expect(wa + wb).toBeCloseTo(1, 8);
  });
});

describe('computeIndexSeries', () => {
  const P = (obj) => new Map(Object.entries(obj));

  it('normalizes to 100 at the first date', () => {
    const dates = ['d1', 'd2'];
    const prices = { d1: P({ 'a|raw': 100 }), d2: P({ 'a|raw': 110 }) };
    const basket = [{ card_id: 'a', grade: 'raw', weight: 1 }];
    const series = computeIndexSeries(dates, d => prices[d], () => basket);
    expect(series[0].value).toBe(100);
    expect(series[1].value).toBeCloseTo(110, 4);
  });

  it('weights returns by basket weight', () => {
    const dates = ['d1', 'd2'];
    const prices = {
      d1: P({ 'a|raw': 100, 'b|raw': 100 }),
      d2: P({ 'a|raw': 120, 'b|raw': 100 }), // a +20%, b flat
    };
    const basket = [
      { card_id: 'a', grade: 'raw', weight: 0.75 },
      { card_id: 'b', grade: 'raw', weight: 0.25 },
    ];
    const series = computeIndexSeries(dates, d => prices[d], () => basket);
    expect(series[1].value).toBeCloseTo(115, 4); // 0.75*1.2 + 0.25*1.0
  });

  it('is continuous across a rebalance (no jump from membership change)', () => {
    const dates = ['d1', 'd2', 'd3'];
    const prices = {
      d1: P({ 'a|raw': 100, 'b|raw': 200 }),
      d2: P({ 'a|raw': 100, 'b|raw': 200 }),
      d3: P({ 'a|raw': 100, 'b|raw': 200 }),
    };
    const basketA = [{ card_id: 'a', grade: 'raw', weight: 1 }];
    const basketB = [{ card_id: 'b', grade: 'raw', weight: 1 }];
    const series = computeIndexSeries(dates, d => prices[d], d => (d === 'd3' ? basketB : basketA));
    // Prices never move, so the level must not move — even though membership changed.
    expect(series.map(s => s.value)).toEqual([100, 100, 100]);
  });

  it('carries a missing mark at its rebalance-base price (no phantom return)', () => {
    const dates = ['d1', 'd2'];
    const prices = {
      d1: P({ 'a|raw': 100, 'b|raw': 100 }),
      d2: P({ 'a|raw': 110 }), // b has no mark on d2
    };
    const basket = [
      { card_id: 'a', grade: 'raw', weight: 0.5 },
      { card_id: 'b', grade: 'raw', weight: 0.5 },
    ];
    const series = computeIndexSeries(dates, d => prices[d], () => basket);
    expect(series[1].value).toBeCloseTo(105, 4); // b contributes flat
  });
});
