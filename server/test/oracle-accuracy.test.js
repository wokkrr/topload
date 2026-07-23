import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { oracleAccuracy } from '../diag-oracle-accuracy.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES ('pkmn-x-1', 'PKMN', 'Pikachu', 'Base Set', '58', '', '{}')`).run();
  const mark = db.prepare(`INSERT INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis) VALUES ('pkmn-x-1', 'PSA10', ?, ?, 1, 3, 0.8, ?)`);
  const sale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id, is_outlier) VALUES ('pkmn-x-1', 'PSA10', ?, date('now', ?), 'ebay', ?, ?)`);
  return { db, mark, sale };
}

describe('oracle accuracy backtest — sales grade the marks', () => {
  it('scores each sale against the PRIOR-day mark, never same-day', () => {
    const { db, mark, sale } = seed();
    mark.run(new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10), 10000, 'solds');   // 3 days ago: $100
    mark.run(new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 10), 20000, 'solds');   // yesterday: $200 (moved by the sale itself)
    sale.run(11000, '-2 day', 's1', 0);                                                       // sold $110 two days ago
    const r = oracleAccuracy(db, { days: 30 });
    expect(r.all.scored).toBe(1);
    // Scored against the $100 mark (3d ago) — NOT yesterday's $200: +10% error.
    expect(r.all.mdape).toBe(10);
    expect(r.all.bias).toBe(10);
    expect(r.all.within10).toBe(100);
  });
  it('unmarked sales count against coverage, outliers and pennies excluded', () => {
    const { db, mark, sale } = seed();
    mark.run(new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), 10000, 'external');
    sale.run(10500, '-1 day', 's1', 0);   // scoreable, +5%
    sale.run(9000, '-1 day', 's2', 1);    // outlier — excluded entirely
    sale.run(150, '-1 day', 's3', 0);     // sub-$2 penny sale — excluded
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES ('ygo-x-2', 'YGO', 'Dark Magician', 'LOB', '005', '', '{}')`).run();
    db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id, is_outlier) VALUES ('ygo-x-2', 'PSA9', 50000, date('now', '-1 day'), 'ebay', 's4', 0)`).run();  // no mark → coverage gap
    const r = oracleAccuracy(db, { days: 30 });
    expect(r.eligibleSales).toBe(2);          // s1 + s4 (outlier + penny gone)
    expect(r.all.scored).toBe(1);
    expect(r.coveragePct).toBe(50);
    expect(r.byBasis.external.scored).toBe(1);
    expect(r.byIp.PKMN.scored).toBe(1);
  });
});
