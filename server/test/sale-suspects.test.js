import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { saleSuspects } from '../diag-sale-suspects.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO cards (id, ip, name, set_name, number, variant, external_ids) VALUES ('pkmn-s', 'PKMN', 'Switch', 'ME2', '123/94', 'Ultra Rare', '{}')`).run();
  db.prepare(`INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, sales_7d, sales_30d) VALUES ('pkmn-s', 'raw', '2026-07-23', 200, 0.6, 'external', 0, 0)`).run();
  db.prepare(`INSERT INTO latest_marks (card_id, grade, as_of, price_cents, confidence, basis, sales_7d, sales_30d) VALUES ('pkmn-s', 'PSA10', '2026-07-23', 2500, 0.6, 'external', 0, 0)`).run();
  const sale = db.prepare(`INSERT INTO sales (card_id, grade, price_cents, sold_at, source, external_id) VALUES ('pkmn-s', ?, ?, date('now', '-2 day'), ?, ?)`);
  const reg = db.prepare(`INSERT INTO nft_registry (mint, platform, card_id, item_name, grade, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, '2026-07-01', '2026-07-23')`);
  return { db, sale, reg };
}

describe('sale-suspect forensics — naming the whale items', () => {
  it('resolves courtyard sales to the exact registry item via tokenId prefix, and flags whales vs median mark', () => {
    const { db, sale, reg } = seed();
    reg.run('123456789012345678999', 'courtyard', 'pkmn-s', 'Pikachu Gold Star Holon Phantoms PSA 9', 'PSA9');
    sale.run('raw', 100000, 'courtyard', '0xabc:123456789012345678'); // $1000 on a ~$13.50-median card
    sale.run('raw', 244, 'courtyard', '0xdef:000000000000000000');    // honest $2.44, tokenId unknown
    const [c] = saleSuspects(db, ['pkmn-s']);
    const whale = c.sales.find(s => s.price_cents === 100000);
    expect(whale.whale).toBe(true);
    expect(whale.resolved.item_name).toBe('Pikachu Gold Star Holon Phantoms PSA 9');
    const honest = c.sales.find(s => s.price_cents === 244);
    expect(honest.whale).toBe(false);
    expect(honest.resolved).toEqual({ missing: true });
  });

  it('notes registry drift: the registry has since been re-pointed but the sale row was not', () => {
    const { db, sale, reg } = seed();
    db.prepare(`INSERT INTO cards (id, ip, name, external_ids) VALUES ('pkmn-other', 'PKMN', 'Pikachu Gold Star', '{}')`).run();
    reg.run('55555555555555555577', 'courtyard', 'pkmn-other', 'Pikachu Gold Star PSA 9', 'PSA9');
    sale.run('raw', 100000, 'courtyard', '0xabc:555555555555555555');
    const [c] = saleSuspects(db, ['pkmn-s']);
    expect(c.sales[0].resolved.card_id).toBe('pkmn-other');   // caller renders the drift note
  });

  it('signature-keyed venues get the lineup of registry items attributed to the card', () => {
    const { db, sale, reg } = seed();
    reg.run('SoLmintAAAA', 'phygitals', 'pkmn-s', 'Switch ME2 base', 'raw');
    reg.run('SoLmintBBBB', 'phygitals', 'pkmn-s', 'Switch [Ultra Rare] Gold ME2', 'raw');
    sale.run('raw', 100000, 'phygitals', '5igSolanaSignature');
    const [c] = saleSuspects(db, ['pkmn-s']);
    expect(c.sales[0].resolved).toBe(null);                    // no mint on the row
    expect(c.lineup.map(r => r.item_name)).toEqual(['Switch ME2 base', 'Switch [Ultra Rare] Gold ME2']);
  });

  it('unknown card ids report instead of throwing', () => {
    const { db } = seed();
    const [c] = saleSuspects(db, ['nope']);
    expect(c.error).toBe('NO SUCH CARD');
  });
});
