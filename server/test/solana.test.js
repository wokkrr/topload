import { describe, it, expect } from 'vitest';
import { decodeSale, registerListings } from '../indexer-solana.js';
import { openDb } from '../db.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT = 'SlabMint1111111111111111111111111111111111';

describe('decodeSale', () => {
  it('decodes an escrow-settled sale (probe shape: escrow pays seller)', () => {
    // Modeled on the real probe capture: NFT seller→vault, USDC escrow→seller.
    const tx = {
      signature: 'sig1', timestamp: 1755652229,
      tokenTransfers: [
        { mint: MINT, tokenAmount: 1, fromUserAccount: 'SellerAAA', toUserAccount: 'BuyerBBB' },
        { mint: USDC, tokenAmount: 5620.5, fromUserAccount: 'EscrowXYZ', toUserAccount: 'SellerAAA' },
      ],
    };
    const sale = decodeSale(tx);
    expect(sale).toMatchObject({ mint: MINT, seller: 'SellerAAA', buyer: 'BuyerBBB', price_cents: 562050 });
    expect(sale.sold_at).toContain('2025-08-'); // timestamp → ISO
  });

  it('sums split payouts from one payer (seller 98% + fee 2% = price)', () => {
    const tx = {
      signature: 'sig2', timestamp: 1755652229,
      tokenTransfers: [
        { mint: MINT, tokenAmount: 1, fromUserAccount: 'S', toUserAccount: 'B' },
        { mint: USDC, tokenAmount: 98, fromUserAccount: 'B', toUserAccount: 'S' },
        { mint: USDC, tokenAmount: 2, fromUserAccount: 'B', toUserAccount: 'FeeWallet' },
      ],
    };
    expect(decodeSale(tx).price_cents).toBe(10000);
  });

  it('rejects transfers with no USDC (vault moves, gifts)', () => {
    expect(decodeSale({ signature: 's', timestamp: 1, tokenTransfers: [
      { mint: MINT, tokenAmount: 1, fromUserAccount: 'A', toUserAccount: 'B' },
    ] })).toBeNull();
  });

  it('rejects multi-NFT transactions (batches are ambiguous)', () => {
    expect(decodeSale({ signature: 's', timestamp: 1, tokenTransfers: [
      { mint: MINT, tokenAmount: 1, fromUserAccount: 'A', toUserAccount: 'B' },
      { mint: 'OtherMint', tokenAmount: 1, fromUserAccount: 'A', toUserAccount: 'B' },
      { mint: USDC, tokenAmount: 50, fromUserAccount: 'B', toUserAccount: 'A' },
    ] })).toBeNull();
  });

  it('rejects USDC-only transactions (bids, refunds)', () => {
    expect(decodeSale({ signature: 's', timestamp: 1, tokenTransfers: [
      { mint: USDC, tokenAmount: 100, fromUserAccount: 'A', toUserAccount: 'B' },
    ] })).toBeNull();
  });
});

describe('registerListings', () => {
  it('remembers every listed slab and preserves earlier card matches', () => {
    const db = openDb(':memory:');
    const listings = [
      { platform: 'collectorcrypt', external_id: 'M1', nft_address: 'M1', item_name: 'Charizard #199 PSA 10', category: 'Pokemon', grade: 'PSA10' },
      { platform: 'collectorcrypt', external_id: 'M2', nft_address: 'M2', item_name: 'Mystery slab', category: 'Pokemon', grade: 'raw' },
    ];
    registerListings(db, listings, new Map([['M1', 'pkmn-x']]));
    // Second snapshot: M1 no longer matched (e.g. matcher regression) — registry keeps the old match.
    registerListings(db, listings, new Map());
    const m1 = db.prepare(`SELECT * FROM nft_registry WHERE mint = 'M1'`).get();
    expect(m1.card_id).toBe('pkmn-x');
    expect(db.prepare(`SELECT COUNT(*) n FROM nft_registry`).get().n).toBe(2);
  });
});
