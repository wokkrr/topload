import { describe, it, expect } from 'vitest';
import { splitProductName } from '../import-pricecharting-csv.js';

describe('splitProductName — promo codes', () => {
  it('extracts single-letter P- promo codes (were dropped → null)', () => {
    expect(splitProductName('Boa Hancock P-066')).toEqual({ name: 'Boa Hancock', number: 'P-066' });
    expect(splitProductName('Arlong [Live Action] P-048')).toEqual({ name: 'Arlong [Live Action]', number: 'P-048' });
    expect(splitProductName('Boa Hancock [V Jump] P-115')).toEqual({ name: 'Boa Hancock [V Jump]', number: 'P-115' });
  });
  it('still handles set codes and # and slash numbers', () => {
    expect(splitProductName('Bartholomew Kuma OP12-119')).toEqual({ name: 'Bartholomew Kuma', number: 'OP12-119' });
    expect(splitProductName('Backlight ST11-003')).toEqual({ name: 'Backlight', number: 'ST11-003' });
    expect(splitProductName('Charizard #6')).toEqual({ name: 'Charizard', number: '6' });
    expect(splitProductName('Pikachu 58/102')).toEqual({ name: 'Pikachu', number: '58/102' });
  });
  it('leaves a plain name with no number', () => {
    expect(splitProductName('Monkey D. Luffy')).toEqual({ name: 'Monkey D. Luffy', number: null });
  });
});
