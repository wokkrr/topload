import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { getMovers } from '../movers.js';

/**
 * The two honesty gates added 2026-07-22 after the live "+483% Snorlax wall":
 * a TCGplayer import re-marked stale cards and every top mover was the same
 * data event wearing three different slabs.
 */
function seed(db) {
  const card = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES (?, 'PKMN', ?, 's', '1', 'English', '{}')`);
  const lm = db.prepare(`INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, source, sales_7d, sales_30d, price_1d, price_30d)
                         VALUES (?, ?, '2026-07-22', ?, 0.7, ?, ?, 1, 4, ?, NULL)`);
  const op = db.prepare(`INSERT INTO oracle_prices (card_id, grade, as_of, price_cents, sales_7d, sales_30d, confidence, basis, source)
                         VALUES (?, ?, '2026-07-21', ?, 1, 4, 0.7, ?, ?)`);

  // Card A: two grades moved (PSA10 +50%, BGS10 +20%), same source both days → dedupe to PSA10.
  card.run('a', 'Snorlax LV.X');
  lm.run('a', 'PSA10', 15000, 'external', 'pricecharting', 10000);
  op.run('a', 'PSA10', 10000, 'external', 'pricecharting');
  lm.run('a', 'BGS10', 12000, 'external', 'pricecharting', 10000);
  op.run('a', 'BGS10', 10000, 'external', 'pricecharting');

  // Card B: +400% "move" but yesterday's mark came from a DIFFERENT source —
  // a data event (new source landing), not a market move → excluded.
  card.run('b', 'Charizard');
  lm.run('b', 'PSA10', 50000, 'external', 'tcgplayer', 10000);
  op.run('b', 'PSA10', 10000, 'external', 'pricecharting');

  // Card C: modest +10%, provenance-consistent solds → included, ranks below A.
  card.run('c', 'Pikachu');
  lm.run('c', 'PSA10', 11000, 'solds', null, 10000);
  op.run('c', 'PSA10', 10000, 'solds', null);

  // Card D: basis flipped external→solds overnight (first real comps) —
  // healthy for the oracle, but the delta is still a data event → excluded.
  card.run('d', 'Blastoise');
  lm.run('d', 'PSA10', 30000, 'solds', null, 10000);
  op.run('d', 'PSA10', 10000, 'external', 'pricecharting');
}

describe('getMovers', () => {
  it('dedupes to one row per card and drops provenance-inconsistent deltas', () => {
    const db = openDb(':memory:');
    seed(db);
    const movers = getMovers(db);
    expect(movers.map(m => m.card_id)).toEqual(['a', 'c']);       // b + d gated out
    expect(movers[0].grade).toBe('PSA10');                        // a's bigger move wins the card's slot
    expect(movers[0].change_pct).toBe(50);
    expect(movers.filter(m => m.card_id === 'a').length).toBe(1); // one slot per card
  });
});
