import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { getDeals, dedupeByMint } from '../deals.js';

function makeDb() {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, language, external_ids) VALUES (?, 'PKMN', ?, 's', '1', 'English', '{}')`);
  card.run('c1', 'Umbreon'); card.run('c2', 'Espeon'); card.run('c3', 'Sylveon'); card.run('c4', 'Glaceon');
  const mark = db.prepare(`INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, sales_7d, sales_30d) VALUES (?, ?, '2026-07-21', ?, ?, 'solds', 1, ?)`);
  mark.run('c1', 'PSA10', 100000, 0.9, 12);   // mark $1000
  mark.run('c2', 'PSA10', 50000, 0.3, 2);     // low confidence
  mark.run('c3', 'raw', 20000, 0.8, 5);
  mark.run('c4', 'PSA10', 100000, 0.9, 0);    // thin trading
  const l = db.prepare(`INSERT INTO gacha_listings (platform, external_id, card_id, item_name, category, grade, price_cents, currency, listed_at, nft_address, seen_at) VALUES (?, ?, ?, 'x', 'Pokemon', ?, ?, 'USD', ?, ?, '2026-07-21')`);
  l.run('collectorcrypt', 'cc1', 'c1', 'PSA10', 70000, '2026-07-01', 'mintA');   // 30% under
  l.run('phygitals', 'phyg:mintA', 'c1', 'PSA10', 71000, '2026-07-02', 'mintA'); // mirror of same item
  l.run('courtyard', 'cy1', 'c2', 'PSA10', 30000, '2026-07-01', 'mintB');        // 40% but conf 0.3 → out
  l.run('mnstr', 'm1', 'c3', 'raw', 19500, '2026-07-01', 'mintC');               // 2.5% → under band
  l.run('collectorcrypt', 'cc2', 'c4', 'PSA10', 5000, '2026-07-01', 'mintD');    // 95% → over band (troll/stale)
  l.run('collectorcrypt', 'cc3', 'c3', 'raw', 12000, '2026-07-01', 'mintE');     // 40% raw deal
  return db;
}

describe('getDeals', () => {
  it('grade-matched, confidence-gated, banded, mirror-deduped, sorted by discount', () => {
    const deals = getDeals(makeDb());
    expect(deals.map(d => d.external_id)).toEqual(['cc3', 'cc1']); // 40% raw, then 30% PSA10
    expect(deals[0].discount).toBeCloseTo(0.40, 2);
    expect(deals[1].mark_cents).toBe(100000);
    expect(deals[1].sales_30d).toBe(12);                  // liquidity context rides along
    expect(deals.find(d => d.external_id === 'phyg:mintA')).toBeUndefined(); // mirror dropped
    expect(deals.find(d => d.external_id === 'cy1')).toBeUndefined();        // low confidence
    expect(deals.find(d => d.external_id === 'cc2')).toBeUndefined();        // 95% = not a deal, a data smell
  });
});

describe('dedupeByMint', () => {
  it('host provenance beats phyg: mirror regardless of platform label', () => {
    const rows = [
      { external_id: 'phyg:m', nft_address: 'm', listed_at: '2026-07-01', platform: 'collectorcrypt' },
      { external_id: 'native', nft_address: 'm', listed_at: '2026-07-05', platform: 'collectorcrypt' },
    ];
    expect(dedupeByMint(rows).map(r => r.external_id)).toEqual(['native']);
  });
});
