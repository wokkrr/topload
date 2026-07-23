import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { recordIntakeTransitions } from '../mnstr-intake.js';

const row = (serial, type, price = 12100, fmv = 110) => ({
  platform: 'mnstr', nft_address: serial, listing_type: type, price_cents: price, fmv_usd: fmv,
});

describe('mnstr intake monitor — watch the pipeline, never surface it', () => {
  it('records intake once (idempotent) and stamps graduation with the exit price', () => {
    const db = openDb(':memory:');
    // Day 1: the Charizard sits in intake.
    expect(recordIntakeTransitions(db, [row('52112335', 'inquiry')], '2026-07-23')).toEqual({ intake: 1, graduated: 0 });
    expect(recordIntakeTransitions(db, [row('52112335', 'inquiry')], '2026-07-24')).toEqual({ intake: 0, graduated: 0 });   // still in intake — no double-count
    // Day 3: it graduates to instant buy at $118.
    expect(recordIntakeTransitions(db, [row('52112335', null, 11800)], '2026-07-26')).toEqual({ intake: 0, graduated: 1 });
    const r = db.prepare(`SELECT * FROM mnstr_intake_log WHERE serial = '52112335'`).get();
    expect(r.first_seen).toBe('2026-07-23');
    expect(r.graduated_at).toBe('2026-07-26');
    expect(r.intake_price_cents).toBe(12100);
    expect(r.intake_fmv_cents).toBe(11000);
    expect(r.buy_price_cents).toBe(11800);
    // Re-seeing it buyable later never re-stamps.
    expect(recordIntakeTransitions(db, [row('52112335', null, 11800)], '2026-07-27')).toEqual({ intake: 0, graduated: 0 });
  });
  it('buyable listings that were never in intake are not logged; non-mnstr rows ignored', () => {
    const db = openDb(':memory:');
    const res = recordIntakeTransitions(db, [
      row('999', null),
      { ...row('888', 'inquiry'), platform: 'phygitals' },
    ], '2026-07-23');
    expect(res).toEqual({ intake: 0, graduated: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM mnstr_intake_log`).get().n).toBe(0);
  });
});
