import { describe, it, expect } from 'vitest';
import { priceFromReceipt, gradeFromFeed, mapSale } from '../indexer-mnstr-sales.js';

const USDm = '0xfafddbb3fc7688494971a79cc65dca3ef82079e7';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const usdmLog = (amount18) => ({ address: USDm, topics: [TRANSFER, '0x'+'0'.repeat(64), '0x'+'0'.repeat(64)], data: '0x' + BigInt(amount18).toString(16) });

describe('priceFromReceipt', () => {
  it('decodes USDm 18-decimal transfer to USD', () => {
    expect(priceFromReceipt({ logs: [usdmLog(38500000000000000000n)] })).toBe(38.5);
  });
  it('takes the max USDm leg (buyer outflow), ignores non-USDm logs', () => {
    const r = { logs: [usdmLog(5n * 10n**18n), { address: '0xdead', topics: [TRANSFER], data: '0x' + (999n*10n**18n).toString(16) }, usdmLog(40n * 10n**18n)] };
    expect(priceFromReceipt(r)).toBe(40);
  });
  it('returns null when no USDm leg', () => {
    expect(priceFromReceipt({ logs: [] })).toBeNull();
  });
});

describe('gradeFromFeed', () => {
  it('normalizes PSA/BGS and BECKETT 95 → 9.5', () => {
    expect(gradeFromFeed('PSA 9', 'x')).toBe('PSA9');
    expect(gradeFromFeed('BGS 9.5', 'x')).toBe('BGS9.5');
    expect(gradeFromFeed('BECKETT 95', 'x')).toBe('BGS9.5');
  });
  it('falls back to title parse', () => {
    expect(gradeFromFeed(null, 'Charizard PSA 10')).toBe('PSA10');
  });
});

describe('mapSale', () => {
  const row = { tx_hash: '0xabc', log_index: 12, card_grading: 'PSA 9', card_title: 'Houndour #24 PSA 9', bought_at: '2026-07-19 01:20:02+00' };
  it('builds a normalized sale with verified price + external_id', () => {
    const s = mapSale(row, { card_id: 'pkmn-x', price_usd: 49.5 });
    expect(s.card_id).toBe('pkmn-x');
    expect(s.price_cents).toBe(4950);
    expect(s.grade).toBe('PSA9');
    expect(s.external_id).toBe('0xabc:12');
    expect(s.sold_at).toContain('2026-07-19');
  });
  it('drops when unmatched or priceless', () => {
    expect(mapSale(row, { card_id: null, price_usd: 49.5 })).toBeNull();
    expect(mapSale(row, { card_id: 'x', price_usd: 0 })).toBeNull();
  });
});
