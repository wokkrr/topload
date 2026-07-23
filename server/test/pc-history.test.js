import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { extractChartData, storeChartHistory, CHART_GRADE_FIELDS } from '../pc-history.js';

const PAGE = `<html><script>
VGPC.chart_data = {"used": [[1609459200000, 14751], [1612137600000, 15200]],
"graded": [[1609459200000, 65000], [1612137600000, 66100]],
"manualonly": [[1609459200000, 410000]],
"boxonly": [], "new": [[1609459200000, 30000]], "cib": [[1609459200000, 18000]]};
</script></html>`;

describe('PC embedded history (probe verdict 2026-07-23: monthly, 2021→now)', () => {
  it('extracts VGPC.chart_data and maps buckets to our grade ladder', () => {
    const d = extractChartData(PAGE);
    expect(Object.keys(CHART_GRADE_FIELDS)).toContain('manualonly');
    expect(d.used.length).toBe(2);
    expect(extractChartData('<html>no chart here</html>')).toBe(null);
  });
  it('stores points as pricecharting external_marks; idempotent; dailies win', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES ('pkmn-ao-94', 'PKMN', 'Lugia EX', 'Ancient Origins', '94', '', '{}')`).run();
    // The daily CSV already wrote today's row for raw — history must not clobber it.
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', 'pkmn-ao-94', 'raw', '2021-01-01', 99999)`).run();
    const n = storeChartHistory(db, 'pkmn-ao-94', extractChartData(PAGE));
    expect(n).toBe(6);   // 7 points minus the 1 date already present for raw
    const raw = db.prepare(`SELECT price_cents FROM external_marks WHERE card_id='pkmn-ao-94' AND grade='raw' AND as_of='2021-01-01'`).get();
    expect(raw.price_cents).toBe(99999);                       // OR IGNORE: existing row wins
    expect(db.prepare(`SELECT COUNT(*) n FROM external_marks WHERE card_id='pkmn-ao-94' AND grade='PSA9'`).get().n).toBe(2);
    expect(db.prepare(`SELECT price_cents FROM external_marks WHERE grade='PSA10'`).get().price_cents).toBe(410000);
    // Re-run: zero new writes.
    expect(storeChartHistory(db, 'pkmn-ao-94', extractChartData(PAGE))).toBe(0);
  });
});
