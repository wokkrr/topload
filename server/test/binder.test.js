import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { buildBinderSeries } from '../binder.js';

describe('buildBinderSeries', () => {
  it('sums qty × mark with carry-forward; gaps never fake a dip', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('a', 'PKMN', 'A', 's', '1', 'English', '{}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('b', 'PKMN', 'B', 's', '2', 'English', '{}')`).run();
    const op = db.prepare(`INSERT INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis) VALUES (?, ?, ?, ?, 1, 1, 0.7, 'solds')`);
    // a (qty 2): marks on d1 and d3 — d2 must CARRY 100, not dip.
    op.run('a', 'PSA10', '2026-07-19', 10000);
    op.run('a', 'PSA10', '2026-07-21', 12000);
    // b (qty 1): first mark on d2 — contributes nothing on d1 (we didn't know it yet).
    op.run('b', 'raw', '2026-07-20', 5000);

    const s = buildBinderSeries(db, [
      { card_id: 'a', grade: 'PSA10', qty: 2 },
      { card_id: 'b', grade: 'raw', qty: 1 },
      { card_id: 'ghost', grade: 'PSA10', qty: 9 },   // unpriced → contributes nothing
    ], { days: 90 });

    expect(s.map(x => x.as_of)).toEqual(['2026-07-19', '2026-07-20', '2026-07-21']);
    expect(s[0]).toMatchObject({ value_cents: 20000, priced: 1 });          // 2×100
    expect(s[1]).toMatchObject({ value_cents: 25000, priced: 2 });          // carry 2×100 + 1×50
    expect(s[2]).toMatchObject({ value_cents: 29000, priced: 2 });          // 2×120 + carry 50
  });

  it('baseline carries a position priced BEFORE the window into it', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('a', 'PKMN', 'A', 's', '1', 'English', '{}')`).run();
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES ('b', 'PKMN', 'B', 's', '2', 'English', '{}')`).run();
    const op = db.prepare(`INSERT INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis) VALUES (?, ?, ?, ?, 1, 1, 0.7, 'solds')`);
    op.run('a', 'raw', '2025-01-01', 7000);            // ancient mark, outside any window
    op.run('b', 'raw', '2026-07-21', 1000);            // in-window mark creates the axis
    const s = buildBinderSeries(db, [
      { card_id: 'a', grade: 'raw', qty: 1 },
      { card_id: 'b', grade: 'raw', qty: 1 },
    ], { days: 30 });
    expect(s.length).toBe(1);
    expect(s[0].value_cents).toBe(8000);               // 70 carried in + 10
  });
});
