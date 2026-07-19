import { describe, it, expect } from 'vitest';
import { decodePhygSale, PHYGITALS_COLLECTION } from '../indexer-phygitals.js';

const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('decodePhygSale', () => {
  it('decodes a USDC sale (live sample shape: asset at Core accounts[0])', () => {
    const tx = {
      signature: 'sig1', timestamp: 1784493751,
      tokenTransfers: [{ mint: USDC, tokenAmount: 40.011685, fromUserAccount: 'Buyer62Q9', toUserAccount: 'SellerEwxs' }],
      instructions: [
        { programId: 'ComputeBudget111111111111111111111111111111', accounts: [] },
        { programId: CORE, accounts: ['AssetF5DP', PHYGITALS_COLLECTION, 'AuthMGrE', 'SellerEwxs', 'Buyer62Q9', CORE, CORE] },
      ],
    };
    const sale = decodePhygSale(tx);
    expect(sale).toMatchObject({
      mint: 'AssetF5DP', buyer: 'Buyer62Q9', seller: 'SellerEwxs', price_cents: 4001,
    });
  });

  it('flags SOL-denominated deals without pricing them', () => {
    const tx = {
      signature: 's', timestamp: 1,
      tokenTransfers: [],
      nativeTransfers: [{ amount: 2.5e9, fromUserAccount: 'B', toUserAccount: 'S' }],
      instructions: [{ programId: CORE, accounts: ['Asset1', PHYGITALS_COLLECTION, 'A', 'S', 'B'] }],
    };
    expect(decodePhygSale(tx)).toEqual({ solPaid: true });
  });

  it('ignores plain transfers (no payment beyond rent dust)', () => {
    const tx = {
      signature: 's', timestamp: 1,
      tokenTransfers: [],
      nativeTransfers: [{ amount: 2_000_000 }], // rent-level dust
      instructions: [{ programId: CORE, accounts: ['Asset1', PHYGITALS_COLLECTION, 'A', 'X', 'Y'] }],
    };
    expect(decodePhygSale(tx)).toBeNull();
  });

  it('ignores txs whose Core instruction is not about the Phygitals collection', () => {
    const tx = {
      signature: 's', timestamp: 1,
      tokenTransfers: [{ mint: USDC, tokenAmount: 50, fromUserAccount: 'B', toUserAccount: 'S' }],
      instructions: [{ programId: CORE, accounts: ['Asset1', 'SomeOtherCollection', 'A', 'S', 'B'] }],
    };
    expect(decodePhygSale(tx)).toBeNull();
  });
});
