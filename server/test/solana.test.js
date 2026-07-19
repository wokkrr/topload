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

  it('decodes event-only sales (vaulted slab, no visible NFT transfer — the common CC case)', () => {
    const tx = {
      signature: 'sig3', timestamp: 1784486953,
      tokenTransfers: [
        { mint: USDC, tokenAmount: 68.5902, fromUserAccount: 'BuyerCV', toUserAccount: 'SellerEo' },
        { mint: USDC, tokenAmount: 1.3998, fromUserAccount: 'BuyerCV', toUserAccount: 'FeeWallet' },
      ],
      events: { nft: { buyer: 'BuyerCV', seller: 'SellerEo', nfts: [{ mint: MINT }] } },
    };
    const sale = decodeSale(tx);
    expect(sale).toMatchObject({ mint: MINT, buyer: 'BuyerCV', seller: 'SellerEo', price_cents: 6999 });
  });

  it('returns candidates for vaulted Core sales (empty event nfts, no transfers of the slab)', () => {
    // Modeled on live INSTANT_SALE captures: USDC flows only, events.nft.nfts=[],
    // slab hidden at CC instruction accounts[6]/[8].
    const CCM = 'CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr';
    const tx = {
      signature: 'sig4', timestamp: 1784488010, type: 'NFT_SALE',
      tokenTransfers: [
        { mint: USDC, tokenAmount: 33.31, fromUserAccount: 'Buyer7zV', toUserAccount: 'Seller398' },
        { mint: USDC, tokenAmount: 0.68, fromUserAccount: 'Buyer7zV', toUserAccount: 'FeeW' },
      ],
      events: { nft: { amount: 33990000, buyer: 'Buyer7zV', seller: 'Seller398', nfts: [] } },
      instructions: [{ programId: CCM, accounts: [
        'Buyer7zV', 'Seller398', 'Seller398', 'Buyer7zV', 'StateConst', 'GlobalConst',
        'ListingPDA111', 'CollectionCC', 'AssetCore222', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ] }],
    };
    const sale = decodeSale(tx);
    expect(sale.mint).toBeNull();
    expect(sale.candidates).toEqual(['AssetCore222', 'ListingPDA111']);
    expect(sale.price_cents).toBe(3399);
    expect(sale.buyer).toBe('Buyer7zV');
  });

  it('prices from the event amount when no USDC transfers are visible', () => {
    const CCM = 'CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr';
    const tx = {
      signature: 'sig5', timestamp: 1784488010, type: 'NFT_SALE',
      tokenTransfers: [],
      events: { nft: { amount: 125000000, buyer: 'B', seller: 'S', nfts: [] } },
      instructions: [{ programId: CCM, accounts: ['B', 'S', 'S', 'B', 'c4', 'c5', 'Cand6', 'Coll', 'Cand8'] }],
    };
    const sale = decodeSale(tx);
    expect(sale.price_cents).toBe(12500);
    expect(sale.candidates).toEqual(['Cand8', 'Cand6']);
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
