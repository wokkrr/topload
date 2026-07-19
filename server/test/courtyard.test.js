import { describe, it, expect } from 'vitest';
import { decodeYardSale } from '../indexer-courtyard.js';

const TID = '0x8d1c9b30aa1f...huge'; // token ids are opaque hex — never parsed

describe('decodeYardSale', () => {
  it('decodes a secondary sale (escrow pass-through — live receipt shape)', () => {
    // Live 0x4f5ee5: buyer 0x66db pays escrow $32.49, escrow forwards $32.49 to seller.
    const sale = decodeYardSale({
      transfers: [{ tokenId: TID, from: '0x4a3aSELLER', to: '0x66dbBUYER' }],
      usdcFlows: [
        { from: '0x66dbbuyer', to: '0x5e49escrow', usd: 32.49 },
        { from: '0x5e49escrow', to: '0x4a3aseller', usd: 32.49 },
      ],
    });
    expect(sale).toMatchObject({ tokenId: TID, seller: '0x4a3aSELLER', buyer: '0x66dbBUYER', price_cents: 3249 });
  });

  it('excludes primary mints (pack rips — pull price is not a card comp)', () => {
    const r = decodeYardSale({
      transfers: [{ tokenId: TID, from: '0x0000000000000000000000000000000000000000', to: '0xNewOwner' }],
      usdcFlows: [
        { from: '0xnewowner', to: '0x7760drop', usd: 499 },
        { from: '0x7760drop', to: '0x66dbtreasury', usd: 499 },
      ],
    });
    expect(r).toEqual({ mint: true });
  });

  it('ignores plain transfers (no payment)', () => {
    expect(decodeYardSale({
      transfers: [{ tokenId: TID, from: '0xA', to: '0xB' }],
      usdcFlows: [],
    })).toBeNull();
  });

  it('flags multi-token batches without pricing', () => {
    expect(decodeYardSale({
      transfers: [{ tokenId: '0x1', from: '0xA', to: '0xB' }, { tokenId: '0x2', from: '0xA', to: '0xB' }],
      usdcFlows: [{ from: '0xb', to: '0xa', usd: 100 }],
    })).toEqual({ batch: 2 });
  });

  it('keeps tokenId as an untouched string (2^256-scale ids)', () => {
    const huge = '0x' + 'f'.repeat(64);
    const sale = decodeYardSale({
      transfers: [{ tokenId: huge, from: '0xS', to: '0xB' }],
      usdcFlows: [{ from: '0xb', to: '0xe', usd: 5 }, { from: '0xe', to: '0xs', usd: 5 }],
    });
    expect(sale.tokenId).toBe(huge);
  });
});
