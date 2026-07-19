import { describe, it, expect } from 'vitest';
import { decodeBaseSale, metaToCard } from '../indexer-base.js';

describe('decodeBaseSale', () => {
  it('decodes a single-card marketplace sale (router hop, 94/6 split — live receipt shape)', () => {
    // Modeled on live receipt 0xec13b5: $26 buyer→router, $24.44 router→seller, $1.56 fee.
    const sale = decodeBaseSale({
      transfers: [
        { tokenId: 9001, from: '0xSELLER', to: '0xROUTER' },
        { tokenId: 9001, from: '0xROUTER', to: '0xBUYER' },
      ],
      usdcFlows: [
        { from: '0xbuyer', to: '0xrouter', usd: 26 },
        { from: '0xrouter', to: '0xseller', usd: 24.44 },
        { from: '0xrouter', to: '0xfee', usd: 1.56 },
      ],
    });
    expect(sale).toMatchObject({ tokenId: '9001', seller: '0xSELLER', buyer: '0xBUYER', price_cents: 2600 });
  });

  it('rejects claw pulls and vault moves (no USDC in tx)', () => {
    expect(decodeBaseSale({
      transfers: [{ tokenId: 1, from: '0xVAULT', to: '0xPLAYER' }],
      usdcFlows: [],
    })).toBeNull();
  });

  it('refuses to price cart checkouts (lump sum across N cards)', () => {
    // Live receipt 0x052b96: 3 cards, one $122 payment — unpriceable per card.
    const r = decodeBaseSale({
      transfers: [
        { tokenId: 1, from: '0xS1', to: '0xR' }, { tokenId: 1, from: '0xR', to: '0xB' },
        { tokenId: 2, from: '0xS1', to: '0xR' }, { tokenId: 2, from: '0xR', to: '0xB' },
        { tokenId: 3, from: '0xS1', to: '0xR' }, { tokenId: 3, from: '0xR', to: '0xB' },
      ],
      usdcFlows: [{ from: '0xb', to: '0xr', usd: 122 }, { from: '0xr', to: '0xs1', usd: 114.68 }],
    });
    expect(r).toEqual({ cart: 3 });
  });

  it('prices from largest single payer when buyer paid via pre-deposit', () => {
    const sale = decodeBaseSale({
      transfers: [
        { tokenId: 5, from: '0xS', to: '0xR' }, { tokenId: 5, from: '0xR', to: '0xB' },
      ],
      usdcFlows: [
        { from: '0xrouterescrow', to: '0xs', usd: 57.34 },
        { from: '0xrouterescrow', to: '0xfee', usd: 3.66 },
      ],
    });
    expect(sale.price_cents).toBe(6100);
  });
});

describe('metaToCard', () => {
  it('maps structured Beezie metadata (live shape)', () => {
    const m = metaToCard({
      name: '2019 Panini Prizm Fast Break Rui Hachimura #255 PSA 10',
      attributes: [
        { trait_type: 'Set Name', value: 'Panini Prizm Fast Break' },
        { trait_type: 'Grader', value: 'PSA' },
        { trait_type: 'Grade', value: '10' },
        { trait_type: 'Card Number', value: '255' },
        { trait_type: 'Category', value: 'Basketball' },
      ],
    });
    expect(m).toMatchObject({ grade: 'PSA10', category: 'Basketball', setName: 'Panini Prizm Fast Break', cardNumber: '255' });
  });

  it('handles ungraded tokens', () => {
    expect(metaToCard({ name: 'Some Card', attributes: [{ trait_type: 'Category', value: 'Pokemon' }] }).grade).toBe('raw');
  });
});
