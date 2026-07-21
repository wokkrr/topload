import { describe, it, expect } from 'vitest';
import { matchListing } from '../match.js';

// Live bug 2026-07-21: "2024 Pokemon Japanese SV Terastal Fest ex Holo
// Umbreon ex #93 CGC 9" attributed to a KOREAN-tagged satellite → the desk
// showed Language: Korean on a plainly Japanese slab. Cross-language between
// two non-English declarations is now a HARD exclusion.
const CARDS = [
  { id: 'pkmn-ko-umbreon', ip: 'PKMN', name: 'Umbreon Ex', number: '93', set_name: 'Pokemon Korean Terastal Festival', language: 'Korean' },
  { id: 'pkmn-ja-umbreon', ip: 'PKMN', name: 'Umbreon Ex', number: '93', set_name: 'Pokemon Japanese Terastal Fest', language: 'Japanese' },
  { id: 'pkmn-en-umbreon', ip: 'PKMN', name: 'Umbreon Ex', number: '93', set_name: 'Pokemon Prismatic Evolutions', language: 'English' },
];

describe('matcher language buckets', () => {
  it('Japanese title routes to the Japanese row, never Korean', () => {
    expect(matchListing('2024 Pokemon Japanese SV Terastal Fest ex Holo Umbreon ex #93 CGC 9', CARDS))
      .toBe('pkmn-ja-umbreon');
  });

  it('Japanese title never lands on Korean even when no Japanese sibling exists', () => {
    const noJa = CARDS.filter(c => c.language !== 'Japanese');
    const hit = matchListing('2024 Pokemon Japanese Terastal Fest ex Umbreon ex #93', noJa);
    expect(hit).not.toBe('pkmn-ko-umbreon');            // EN fallback or nothing — never KO
  });

  it('Korean title routes to the Korean row', () => {
    expect(matchListing('2024 Pokemon Korean Terastal Festival Umbreon ex #93 PSA 10', CARDS))
      .toBe('pkmn-ko-umbreon');
  });

  it('Korean title never lands on the Japanese row', () => {
    const noKo = CARDS.filter(c => c.language !== 'Korean');
    expect(matchListing('2024 Pokemon Korean Terastal Festival Umbreon ex #93', noKo))
      .not.toBe('pkmn-ja-umbreon');
  });

  it('English title prefers the English row (soft penalty intact)', () => {
    expect(matchListing('2024 Pokemon Prismatic Evolutions Umbreon ex #93 PSA 10', CARDS))
      .toBe('pkmn-en-umbreon');
  });
});
