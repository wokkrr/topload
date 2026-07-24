import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { repairSaleAttribution } from '../repair-sale-attribution.js';
import { gradeFromTitle } from '../adapters/collectorcrypt.js';

function seed() {
  const db = openDb(':memory:');
  const card = db.prepare(`INSERT INTO cards (id, ip, name, external_ids) VALUES (?, 'PKMN', ?, '{}')`);
  card.run('pkmn-sink', 'Mewtwo');            // the generic sinkhole row
  card.run('pkmn-base10', 'Mewtwo Base #10'); // where the item really belongs
  card.run('pkmn-switch', 'Switch');
  const sale = db.prepare(
    `INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id, is_outlier) VALUES (?, ?, ?, '2026-07-21', ?, ?, 0)`);
  const reg = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, grade, first_seen, last_seen) VALUES (?, 'courtyard', ?, ?, ?, '2026-07-01', '2026-07-23')`);
  const regOn = db.prepare(
    `INSERT INTO nft_registry (mint, platform, card_id, item_name, grade, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, '2026-07-01', '2026-07-23')`);
  const mark = db.prepare(
    `INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES (?, ?, ?, ?, ?)`);
  return { db, sale, reg, regOn, mark };
}

describe('sale-attribution repair', () => {
  it('phase 1 re-points a resolvable sale to its registry item (post-rematch home)', () => {
    const { db, sale, reg } = seed();
    reg.run('7770001111222233334444', 'pkmn-base10', '1999 #10 Mewtwo-Holo PSA 5 Game', 'PSA5');
    sale.run('pkmn-sink', 'raw', 4100, 'courtyard', '0xaa:777000111122223333');
    const dry = repairSaleAttribution(db, { live: false });
    expect(dry.repointed).toBe(1);
    expect(db.prepare(`SELECT card_id FROM sales`).get().card_id).toBe('pkmn-sink'); // dry wrote nothing
    const res = repairSaleAttribution(db, { live: true });
    expect(res.repointed).toBe(1);
    const row = db.prepare(`SELECT card_id, grade FROM sales`).get();
    expect(row).toEqual({ card_id: 'pkmn-base10', grade: 'PSA5' });
  });

  it('phase 1 never resolves across platforms (prefix collision on another venue stays untouched)', () => {
    const { db, sale, regOn } = seed();
    regOn.run('999000111122223333XYZ', 'phygitals', 'pkmn-base10', 'right prefix, wrong venue', 'PSA9');
    sale.run('pkmn-sink', 'raw', 4100, 'courtyard', '0xaa:999000111122223333');
    const res = repairSaleAttribution(db, { live: true });
    expect(res.repointed).toBe(0);
    expect(res.unresolvable).toBe(1);
    expect(db.prepare(`SELECT card_id FROM sales`).get().card_id).toBe('pkmn-sink');
  });

  it('phase 1 leaves ambiguous mint prefixes and null-card registry rows untouched', () => {
    const { db, sale, reg } = seed();
    reg.run('555000AAA', 'pkmn-base10', 'A', 'PSA5');
    reg.run('555000BBB', 'pkmn-base10', 'B', 'PSA5');
    reg.run('666000CCC', null, 'unattributed item', 'raw');
    sale.run('pkmn-sink', 'raw', 4100, 'courtyard', '0xaa:555000');
    sale.run('pkmn-sink', 'raw', 4100, 'courtyard', '0xbb:666000');
    const res = repairSaleAttribution(db, { live: true });
    expect(res.repointed).toBe(0);
    expect(res.ambiguous).toBe(1);
    expect(res.unresolvable).toBe(1);
  });

  it('phase 2 quarantines whales against the external anchor even when sibling whales agree (the Sanji trap)', () => {
    const { db, sale, mark } = seed();
    mark.run('pricecharting', 'pkmn-switch', 'raw', '2026-07-23', 226);   // guide: $2.26
    sale.run('pkmn-switch', 'raw', 15900, 'phygitals', 'sigA');           // $159
    sale.run('pkmn-switch', 'raw', 15000, 'phygitals', 'sigB');           // $150
    sale.run('pkmn-switch', 'raw', 13800, 'phygitals', 'sigC');           // $138 — three whales voting for each other
    sale.run('pkmn-switch', 'raw', 244, 'courtyard', '0xdd:nomatch');     // honest $2.44
    const res = repairSaleAttribution(db, { live: true });
    expect(res.quarantined).toBe(3);
    const flagged = db.prepare(`SELECT price_cents, outlier_reason FROM sales WHERE is_outlier = 1 ORDER BY price_cents`).all();
    expect(flagged.map(f => f.price_cents)).toEqual([13800, 15000, 15900]);
    expect(flagged[0].outlier_reason).toMatch(/price-implausible: .*above pricecharting mark \$2\.26/);
    expect(db.prepare(`SELECT is_outlier FROM sales WHERE price_cents = 244`).get().is_outlier).toBe(0);
  });

  it('phase 2 falls back to sibling median (≥3 others) and skips penny noise', () => {
    const { db, sale } = seed();
    // No external mark. Four honest $40 sales + one $500 whale.
    for (const [i, c] of [4000, 4100, 3900, 4000, 50000].entries()) sale.run('pkmn-switch', 'PSA10', c, 'courtyard', `0xe${i}:x`);
    // Penny pair 5x apart — under the $20 floor, ignored.
    sale.run('pkmn-switch', 'raw', 100, 'courtyard', '0xf1:x');
    sale.run('pkmn-switch', 'raw', 550, 'courtyard', '0xf2:x');
    const res = repairSaleAttribution(db, { live: true });
    expect(res.quarantined).toBe(1);
    expect(db.prepare(`SELECT price_cents FROM sales WHERE is_outlier = 1`).get().price_cents).toBe(50000);
  });

  it('dry run judges phase 2 in the post-repoint world (a re-homed whale is judged on its new row)', () => {
    const { db, sale, reg, mark } = seed();
    reg.run('888000111', 'pkmn-base10', '1999 #10 Mewtwo PSA 9', 'PSA9');
    mark.run('pricecharting', 'pkmn-base10', 'PSA9', '2026-07-23', 40000); // $400 card
    mark.run('pricecharting', 'pkmn-sink', 'PSA9', '2026-07-23', 2000);    // $20 sinkhole mark
    sale.run('pkmn-sink', 'PSA9', 38300, 'courtyard', '0xcc:888000');      // $383 — whale on sink, honest on base10
    const dry = repairSaleAttribution(db, { live: false });
    expect(dry.repointed).toBe(1);
    expect(dry.quarantined).toBe(0);   // judged at its NEW home, where $383 vs $400 is honest
  });
});

describe('CGC Pristine 10 is its own tier', () => {
  it('title path now matches the venues\' structured CGC10.5 convention; BGS Pristine stays BGS10', () => {
    expect(gradeFromTitle('2026 Ascended Heroes IR Salazzle #224 CGC 10 PRISTINE')).toBe('CGC10.5');
    expect(gradeFromTitle('N\'s Reshiram - Art Rare Holo (CGC 10 GEM MINT)')).toBe('CGC10');
    expect(gradeFromTitle('Lugia BGS Pristine 10 Neo Genesis')).toBe('BGS10');
    expect(gradeFromTitle('Umbreon CGC PRISTINE 10 Evolving Skies')).toBe('CGC10.5');
  });
});

describe('refreshOutlierFlags plausibility gate (permanent — survives every refresh)', async () => {
  const { openDb: open2 } = await import('../db.js');
  const { refreshOutlierFlags } = await import('../oracle.js');
  it('flags anchor-violating whales even when they arrive first and agree with each other', () => {
    const db = open2(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, external_ids) VALUES ('c1', 'PKMN', 'Switch', '{}')`).run();
    db.prepare(`INSERT INTO external_marks (source, card_id, grade, as_of, price_cents) VALUES ('pricecharting', 'c1', 'raw', '2026-07-23', 226)`).run();
    const sale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('c1', 'raw', ?, ?, 'phygitals', ?)`);
    sale.run(13800, '2026-07-17', 'a');   // whale cluster arrives FIRST —
    sale.run(15000, '2026-07-18', 'b');   // trailing-median rule alone would
    sale.run(15900, '2026-07-19', 'c');   // bless it and flag the honest sale
    sale.run(244, '2026-07-20', 'd');
    const res = refreshOutlierFlags(db);
    expect(res.implausible).toBe(3);
    const rows = db.prepare(`SELECT price_cents, is_outlier, outlier_reason FROM sales ORDER BY price_cents`).all();
    expect(rows[0]).toMatchObject({ price_cents: 244, is_outlier: 0 });
    expect(rows[1].outlier_reason).toMatch(/price-implausible: .*above pricecharting mark \$2\.26/);
    expect(rows[2].is_outlier).toBe(1);
    expect(rows[3].is_outlier).toBe(1);
  });
  it('no anchor → statistical rule only; penny pairs under the floor stay unflagged', () => {
    const db = open2(':memory:');
    db.prepare(`INSERT INTO cards (id, ip, name, external_ids) VALUES ('c2', 'PKMN', 'X', '{}')`).run();
    const sale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('c2', 'raw', ?, ?, 'demo', ?)`);
    sale.run(100, '2026-07-01', 'a');
    sale.run(120, '2026-07-02', 'b');
    const res = refreshOutlierFlags(db);
    expect(res.implausible).toBe(0);
    expect(db.prepare(`SELECT SUM(is_outlier) s FROM sales`).get().s).toBe(0);
  });
});
