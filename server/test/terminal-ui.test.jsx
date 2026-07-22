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
    // Live bug 2026-07-21: a short series whose dates sit at the END of the
    // axis (late-starting index) must align by date, not array position.
    ['late-starting short series', { indexes: [
      { index_id: 'PKMN', series: mkSeries(20) },
      { index_id: 'YGO', series: mkSeries(20).slice(17) },
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

describe('CardsTable (2026-07-21/22 column rework)', () => {
  const cards = [
    { card_id: 'a', ip: 'PKMN', name: 'Umbreon VMAX', set_name: 'Evolving Skies', number: '215',
      language: 'English', grade: 'BGS10', grades_tracked: 4, price_cents: 4595500,
      change_1d_pct: 0, sales_7d: 3, confidence: 0.7, basis: 'external', source: 'pricecharting' },
    { card_id: 'b', ip: 'PKMN', name: 'Umbreon VMAX', set_name: 'Evolving Skies JA', number: '215',
      language: 'Japanese', grade: 'BGS10', grades_tracked: 2, price_cents: 4595500,
      change_1d_pct: null, sales_7d: null, confidence: 0.85, basis: 'solds', source: null },
  ];
  it('shows Lang + Oracle + Sales/7D; no Δ30D/Conf/Basis and NO source names', async () => {
    const React = (await import('react')).default;
    const { CardsTable } = await import('../../src/ui/tables.jsx');
    const html = renderToString(React.createElement(CardsTable, { cards, onSelect: () => {} }));
    expect(html).toContain('Oracle');            // Mark renamed
    expect(html).toContain('>EN<');              // language column, both codes
    expect(html).toContain('>JP<');
    expect(html).not.toContain('Source');        // sources stay our business
    expect(html).not.toContain('PriceCharting');
    expect(html).not.toContain('EXT·');
    expect(html).not.toContain('Δ30D');          // dead columns dropped
  });
  it('column headers sort: active column carries the ▼ marker', async () => {
    const React = (await import('react')).default;
    const { CardsTable } = await import('../../src/ui/tables.jsx');
    const html = renderToString(React.createElement(CardsTable, { cards, sort: 'volume', onSort: () => {} }));
    expect(html).toContain('▼');
    expect(html.indexOf('Sales/7D')).toBeLessThan(html.indexOf('▼', html.indexOf('Sales/7D')));
  });
  it('langCode maps known languages and degrades sanely', async () => {
    const { langCode } = await import('../../src/ui/tables.jsx');
    expect(langCode('English')).toBe('EN');
    expect(langCode('Japanese')).toBe('JP');
    expect(langCode(null)).toBe('EN');           // catalog default
    expect(langCode('Klingon')).toBe('KL');      // unknown → first two letters
  });
});

describe('Binder (v2 — panels, chart, grid/list)', () => {
  it('renders SSR-safe with no localStorage (empty state + stat header + view toggles)', async () => {
    const React = (await import('react')).default;
    const { Binder } = await import('../../src/ui/Binder.jsx');
    const html = renderToString(React.createElement(Binder, { onSelect: () => {} }));
    expect(html).toContain('The Binder');
    expect(html).toContain('Binder value');
    expect(html).toContain('Your Binder is empty');
    expect(html).toContain('Add Card');
    expect(html).toContain('Holdings');
  });
});

describe('IndexTable', () => {
  it('renders uneven series without crashing (shorter index shows dashes)', async () => {
    const { renderToString } = await import('react-dom/server');
    const React = (await import('react')).default;
    const { IndexTable } = await import('../../src/ui/IndexChart.jsx');
    const dates = ['2026-07-01', '2026-07-02', '2026-07-03'];
    const data = [
      { index_id: 'PKMN', series: dates.map(d => ({ as_of: d, value: 100 })) },
      { index_id: 'OP', series: [{ as_of: '2026-07-03', value: 102.5 }] },  // short series — crashed live
    ];
    const html = renderToString(React.createElement(IndexTable, { data, dates }));
    expect(html).toContain('102.50');
    expect(html).toContain('—');
  });
});
