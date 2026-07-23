import { describe, it, expect } from 'vitest';
import { openDb } from '../db.js';
import { expandTitle, matchSealedToProducts, buildSealedBook, attributeSealedListings } from '../sealed.js';

const PRODUCTS = [
  { id: 'pkmn-tp1', name: 'Prismatic Evolutions Elite Trainer Box' },
  { id: 'pkmn-tp2', name: 'Prismatic Evolutions Booster Bundle' },
  { id: 'pkmn-tp3', name: 'Prismatic Evolutions Pokemon Center Elite Trainer Box' },
];

describe('sealed matcher — full product evidence, most specific wins, ties ungrouped', () => {
  it('expands ETB, routes to the most specific product, refuses ambiguity', () => {
    const m = matchSealedToProducts([
      { external_id: 'a', item_name: 'Pokemon Prismatic Evolutions ETB (Sealed)' },
      { external_id: 'b', item_name: 'Prismatic Evolutions Pokemon Center ETB Exclusive' },
      { external_id: 'c', item_name: 'Prismatic Evolutions Booster Bundle Case Fresh' },
      { external_id: 'd', item_name: 'Prismatic Evolutions' },                     // no product evidence
    ], PRODUCTS);
    expect(m.get('a')).toBe('pkmn-tp1');
    expect(m.get('b')).toBe('pkmn-tp3');   // PC ETB beats plain ETB (more tokens)
    expect(m.get('c')).toBe('pkmn-tp2');
    expect(m.has('d')).toBe(false);
    expect(expandTitle('PE etb bb')).toContain('elite trainer box');
  });
});

describe('the sealed book — mint dedupe is the double-spend guard', () => {
  function seed() {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO products (id, ip, name, set_name, language, kind, image) VALUES ('pkmn-tp1', 'PKMN', 'Prismatic Evolutions Elite Trainer Box', 'Prismatic Evolutions', 'English', 'etb', 'https://img/etb.jpg')`).run();
    db.prepare(`INSERT INTO product_prices (product_id, subtype, as_of, market_cents) VALUES ('pkmn-tp1', 'Normal', '2026-07-23', 10200)`).run();
    const ins = db.prepare(
      `INSERT INTO gacha_listings (platform, external_id, card_id, item_name, grade, price_cents, currency, nft_address, product_id, seen_at)
       VALUES (?, ?, NULL, ?, 'raw', ?, 'USDC', ?, 'pkmn-tp1', '2026-07-23')`);
    // The Kaleb scenario: CC hosts a box; Phygitals mirrors THE SAME token +4%.
    ins.run('collectorcrypt', 'cc1', 'Prismatic Evolutions ETB', 8999, 'mintAAA');
    ins.run('phygitals', 'ph1', 'Prismatic Evolutions ETB', 9360, 'mintAAA');
    // A genuinely different physical box on Phygitals, and a mintless listing.
    ins.run('phygitals', 'ph2', 'Prismatic Evolutions ETB', 9500, 'mintBBB');
    ins.run('mnstr', 'mn1', 'Prismatic Evolutions ETB', 9900, null);
    return db;
  }
  it('mirrors collapse to one unit at the host ask; depth counts physical boxes', () => {
    const book = buildSealedBook(seed());
    expect(book.length).toBe(1);
    const b = book[0];
    expect(b.units).toBe(3);                     // mintAAA (deduped) + mintBBB + mintless mnstr
    expect(b.mirrors_collapsed).toBe(1);         // the Phygitals mirror of mintAAA
    expect(b.best.price_cents).toBe(8999);       // the host ask leads the box
    expect(b.best.platform).toBe('collectorcrypt');
    expect(b.asks.map(a => a.price_cents)).toEqual([8999, 9500, 9900]);   // mirror's 9360 gone
    expect(b.market_cents).toBe(10200);
    expect(b.discount).toBeCloseTo(0.118, 2);    // best ask ~11.8% under market
  });
  it('attributeSealedListings pins raw sealed listings to the shelf', () => {
    const db = seed();
    db.prepare(`UPDATE gacha_listings SET product_id = NULL`).run();
    const res = attributeSealedListings(db, { isSealedFn: (l) => (l.grade ?? 'raw') === 'raw' });
    expect(res.attributed).toBe(4);
    expect(buildSealedBook(db).length).toBe(1);
  });
});

describe('sealed tape — history rolls from day one (tcgquant study)', () => {
  it('logs one row per (day, product); idempotent per day', async () => {
    const { logSealedBook } = await import('../sealed.js');
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO products (id, ip, name) VALUES ('pkmn-tp1', 'PKMN', 'Prismatic Evolutions Elite Trainer Box')`).run();
    db.prepare(`INSERT INTO gacha_listings (platform, external_id, item_name, grade, price_cents, currency, nft_address, product_id, seen_at)
                VALUES ('collectorcrypt', 'cc1', 'PE ETB', 'raw', 8999, 'USDC', 'mintA', 'pkmn-tp1', '2026-07-23')`).run();
    expect(logSealedBook(db, '2026-07-23')).toEqual({ logged: 1 });
    logSealedBook(db, '2026-07-23');
    expect(db.prepare(`SELECT COUNT(*) n FROM sealed_book_log`).get().n).toBe(1);
    const row = db.prepare(`SELECT units, best_ask_cents FROM sealed_book_log WHERE product_id = 'pkmn-tp1'`).get();
    expect(row).toEqual({ units: 1, best_ask_cents: 8999 });
  });
});

describe('inquiry listings are never asks (2026-07-23)', () => {
  it('excludes listing_type=inquiry from the book ladder and depth', async () => {
    const { buildSealedBook } = await import('../sealed.js');
    const { openDb } = await import('../db.js');
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO products (id, ip, name) VALUES ('pkmn-tp1', 'PKMN', 'Prismatic Evolutions Elite Trainer Box')`).run();
    const ins = db.prepare(
      `INSERT INTO gacha_listings (platform, external_id, item_name, grade, price_cents, currency, nft_address, product_id, listing_type, seen_at)
       VALUES ('mnstr', ?, 'PE ETB', 'raw', ?, 'USDm', ?, 'pkmn-tp1', ?, '2026-07-23')`);
    ins.run('m1', 7999, 'sA', 'inquiry');   // cheapest, but you cannot hit it
    ins.run('m2', 9500, 'sB', null);
    const book = buildSealedBook(db);
    expect(book.length).toBe(1);
    expect(book[0].units).toBe(1);
    expect(book[0].best.price_cents).toBe(9500);   // the inquiry $79.99 never leads the box
  });
});
