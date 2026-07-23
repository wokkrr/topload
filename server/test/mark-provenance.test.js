import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { markProvenance } from '../diag-mark-provenance.js';

/** In-memory db + injected guide map (shape of a parsed daily CSV row). */
function seed() {
  const db = openDb(':memory:');
  const card = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES (?, ?, ?, ?, ?, '', ?)`);
  const mark = db.prepare(
    `INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', ?, ?, ?, ?)`);
  return { db, card, mark };
}
const guideRow = (over = {}) => ({
  id: '111', 'product-name': 'Switch #123', 'console-name': 'Pokemon Mega Evolutions',
  'loose-price': '$2.00', 'graded-price': '', 'manual-only-price': '', 'sales-volume': '3',
  genre: 'Pokemon Card', __ip: 'PKMN', ...over,
});

describe('mark provenance forensics — where did the bad mark come from', () => {
  it('flags FROZEN when the attached pc id fell out of the current guide', () => {
    const { db, card, mark } = seed();
    card.run('pkmn-a', 'PKMN', 'Salazzle', 'ME2.5', '224', '{"pricecharting":"999"}');
    mark.run('pkmn-a', 'CGC10', '2026-05-01', 2700);
    const [c] = markProvenance(db, ['pkmn-a'], { guide: new Map() });
    expect(c.verdicts.join(' ')).toMatch(/FROZEN: pc 999/);
  });

  it('flags NUMBER MISMATCH — wrong product attached to the card', () => {
    const { db, card } = seed();
    card.run('pkmn-b', 'PKMN', 'Switch', 'ME2', '204', '{"pricecharting":"111"}');
    const [c] = markProvenance(db, ['pkmn-b'], { guide: new Map([['111', guideRow()]]) });
    expect(c.verdicts.join(' ')).toMatch(/NUMBER MISMATCH: product "#123" vs card "#204"/);
  });

  it('flags STALE + FAITHFUL: fresh mirror of a cheap product is the wrong-printing signature', () => {
    const { db, card, mark } = seed();
    card.run('pkmn-c', 'PKMN', 'Switch', 'ME2', '123', '{"pricecharting":"111"}');
    const old = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    mark.run('pkmn-c', 'raw', old, 200);          // $2, last touched 60d ago
    const [c] = markProvenance(db, ['pkmn-c'], { guide: new Map([['111', guideRow()]]) });
    const v = c.verdicts.join(' ');
    expect(v).toMatch(/STALE raw: last pricecharting mark/);
    expect(v).toMatch(/FAITHFUL raw: mark \$2\.00 mirrors today's guide \$2\.00/);
  });

  it('flags VARIANT-LABEL MISMATCH when a base product dresses a bracketed variant row', () => {
    const { db, card } = seed();
    card.run('pkmn-d', 'PKMN', 'Switch [Ultra Rare]', 'ME2', '123', '{"pricecharting":"111"}');
    const [c] = markProvenance(db, ['pkmn-d'], { guide: new Map([['111', guideRow()]]) });
    expect(c.verdicts.join(' ')).toMatch(/VARIANT-LABEL MISMATCH: product \[base\] vs card \[ultra rare\]/);
  });

  it('reads a satellite id suffix (-pc<id>) when external_ids lacks the attachment', () => {
    const { db, card } = seed();
    card.run('pkmn-pc111', 'PKMN', 'Switch', 'ME2', '123', '{}');
    const [c] = markProvenance(db, ['pkmn-pc111'], { guide: new Map([['111', guideRow()]]) });
    expect(c.pc).toBe('111');
    expect(c.verdicts.join(' ')).not.toMatch(/NO PC ATTACHMENT/);
  });

  it('coherent attachment with no marks yields the thin-data verdict, and unknown ids do not throw', () => {
    const { db, card } = seed();
    card.run('pkmn-e', 'PKMN', 'Switch', 'ME2', '123', '{"pricecharting":"111"}');
    const [c, missing] = markProvenance(db, ['pkmn-e', 'nope'], { guide: new Map([['111', guideRow()]]) });
    expect(c.verdicts).toEqual(['attachment looks coherent — suspect thin guide data or a market move the guide lags']);
    expect(missing.verdicts).toEqual(['NO SUCH CARD']);
  });
});
