import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Terminal } from '../../src/ui/Terminal.jsx';

const mkSeries = (n) => Array.from({ length: n }, (_, i) => ({ as_of: `2026-07-${String(i + 1).padStart(2, '0')}`, value: 100 + i }));
const movers = [
  { card_id: 'pkmn-base1-4', ip: 'PKMN', name: 'Charizard', grade: 'PSA9', price_now: 250000, change_pct: 4.2, sales_7d: 3, confidence: 0.7 },
  { card_id: 'op-op07-047', ip: 'OP', name: 'Trafalgar Law', grade: 'raw', price_now: null, change_pct: null },
  { card_id: 'ygo-lob-001', ip: 'YGO', name: 'Blue-Eyes White Dragon', grade: 'BGS9.5', price_now: 999999999, change_pct: -12.5 },
];

describe('Terminal renders without throwing across payload shapes', () => {
  const variants = [
    ['nulls', { indexes: null, movers: null }],
    ['empty arrays', { indexes: [], movers: [] }],
    ['one thin index', { indexes: [{ index_id: 'OP', series: mkSeries(1) }], movers }],
    ['three indexes, uneven lengths', { indexes: [
      { index_id: 'PKMN', series: mkSeries(20) },
      { index_id: 'OP', series: mkSeries(12) },
      { index_id: 'YGO', series: mkSeries(1) },
    ], movers }],
    ['index with EMPTY series', { indexes: [{ index_id: 'PKMN', series: [] }], movers }],
    ['index missing series key', { indexes: [{ index_id: 'PKMN' }], movers }],
    ['mover with unknown ip', { indexes: [], movers: [{ card_id: 'x', ip: 'WTF', name: 'Mystery', grade: 'raw', price_now: 100, change_pct: 0 }] }],
  ];
  for (const [label, props] of variants) {
    it(label, () => {
      const html = renderToString(
        <Terminal indexes={props.indexes} days={90} setDays={() => {}} movers={props.movers} onSelect={() => {}} />
      );
      expect(typeof html).toBe('string');
    });
  }
});

describe('isSealed', () => {
  it('never marks Pokémon NAMED after products as sealed', async () => {
    const { isSealed } = await import('../../src/ui/tables.jsx');
    expect(isSealed({ grade: 'raw', platform: 'phygitals', item_name: '2023 Iron Bundle Paradox Rift #056' })).toBe(false);
    expect(isSealed({ grade: 'PSA10', platform: 'phygitals', item_name: 'Booster Box Collection Promo' })).toBe(false); // graded never sealed
    expect(isSealed({ grade: 'raw', platform: 'phygitals', item_name: 'Paldea Evolved Booster Bundle' })).toBe(true);
    expect(isSealed({ grade: 'raw', platform: 'phygitals', item_name: 'Elite Trainer Box Scarlet & Violet' })).toBe(true);
    expect(isSealed({ grade: 'raw', platform: 'mnstr', item_name: 'Ascended Heroes' })).toBe(true); // ungraded MNSTR = pack
  });
});
