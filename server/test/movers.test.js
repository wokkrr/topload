import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { refreshLatestMarks } from '../oracle.js';
import { getMovers } from '../movers.js';

/**
 * 7D movers with the two honesty gates added 2026-07-22 after the live
 * "+483% Snorlax wall": a TCGplayer import re-marked stale cards and every
 * top mover was the same data event wearing three different slabs.
 * Full path: oracle_prices history → refreshLatestMarks (price_7d/prov_7d
 * precompute) → getMovers.
 */
function seed(db) {
  const card = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES (?, 'PKMN', ?, 's', '1', 'English', '{}')`);
  const op = db.prepare(`INSERT INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis, source)
                         VALUES (?, ?, ?, ?, 1, 4, 0.7, ?, ?)`);
  const THEN = '2026-07-14', NOW = '2026-07-22';   // 8 days apart — nearest-≥7d lookback finds THEN

  // Card A: two grades moved (PSA10 +50%, BGS10 +20%), same source both ends → dedupe to PSA10.
  card.run('a', 'Snorlax LV.X');
  op.run('a', 'PSA10', THEN, 10000, 'external', 'pricecharting');
  op.run('a', 'PSA10', NOW, 15000, 'external', 'pricecharting');
  op.run('a', 'BGS10', THEN, 10000, 'external', 'pricecharting');
  op.run('a', 'BGS10', NOW, 12000, 'external', 'pricecharting');

  // Card B: +400% "move" but the source changed across the window —
  // a data event (new source landing), not a market move → excluded.
  card.run('b', 'Charizard');
  op.run('b', 'PSA10', THEN, 10000, 'external', 'pricecharting');
  op.run('b', 'PSA10', NOW, 50000, 'external', 'tcgplayer');

  // Card C: modest +10%, provenance-consistent solds → included, ranks below A.
  card.run('c', 'Pikachu');
  op.run('c', 'PSA10', THEN, 10000, 'solds', null);
  op.run('c', 'PSA10', NOW, 11000, 'solds', null);

  // Card D: basis flipped external→solds inside the window (first real comps)
  // — healthy for the oracle, but the delta is still a data event → excluded.
  card.run('d', 'Blastoise');
  op.run('d', 'PSA10', THEN, 10000, 'external', 'pricecharting');
  op.run('d', 'PSA10', NOW, 30000, 'solds', null);

  // Card E: too young — first mark 3 days ago, no 7d-lookback row → excluded.
  card.run('e', 'Mewtwo');
  op.run('e', 'PSA10', '2026-07-19', 10000, 'solds', null);
  op.run('e', 'PSA10', NOW, 20000, 'solds', null);
}

describe('getMovers (7D window)', () => {
  it('dedupes per card, drops cross-stream deltas and too-young cards', () => {
    const db = openDb(':memory:');
    seed(db);
    refreshLatestMarks(db);
    const movers = getMovers(db);
    expect(movers.map(m => m.card_id)).toEqual(['a', 'c']);       // b, d, e gated out
    expect(movers[0].grade).toBe('PSA10');                        // a's bigger move wins the card's slot
    expect(movers[0].change_pct).toBe(50);
    expect(movers[0].price_then).toBe(10000);
    expect(movers.filter(m => m.card_id === 'a').length).toBe(1); // one slot per card
  });
});
