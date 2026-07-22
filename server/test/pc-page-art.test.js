import { describe, it, expect } from 'vitest';
import { pcSlug, pageUrl, extractOgImage, fillPageArt } from '../seed-pc-page-art.js';

describe('pcSlug / pageUrl', () => {
  it('mirrors PC url conventions: lowercase, punctuation dropped, spaces→dashes', () => {
    expect(pcSlug('Pokemon Japanese Promo')).toBe('pokemon-japanese-promo');
    expect(pcSlug('Illustrator Pikachu')).toBe('illustrator-pikachu');
    expect(pcSlug('Charizard [No Rarity] #6')).toBe('charizard-no-rarity-6');
    expect(pcSlug('Monkey.D.Luffy #OP05-119')).toBe('monkey-d-luffy-op05-119');
    expect(pcSlug('Cats & Dogs')).toBe('cats-and-dogs');
    expect(pageUrl('Pokemon Base Set', 'Charizard #4')).toBe('https://www.pricecharting.com/game/pokemon-base-set/charizard-4');
  });
});

describe('extractOgImage', () => {
  it('pulls og:image in either attribute order; rejects placeholders', () => {
    expect(extractOgImage('<meta property="og:image" content="https://x/img.jpg"/>')).toBe('https://x/img.jpg');
    expect(extractOgImage('<meta content="https://x/img.jpg" property="og:image"/>')).toBe('https://x/img.jpg');
    expect(extractOgImage('<meta property="og:image" content="https://x/no-image.png"/>')).toBeNull();
    expect(extractOgImage('<html>no og</html>')).toBeNull();
    expect(extractOgImage(null)).toBeNull();
  });
});

describe('fillPageArt', () => {
  it('refuses when robots.txt disallows /game', async () => {
    const stub = async () => ({ ok: true, text: async () => 'User-agent: *\nDisallow: /game\n' });
    const res = await fillPageArt(null, { fetchImpl: stub, log: () => {} });
    expect(res).toEqual({ refused: true });
  });
});

describe('extractCardImage — PC bucket URLs, no og:image (live 2026-07-22)', () => {
  it('finds bucket URLs anywhere in the page and upgrades thumbnails', async () => {
    const { extractCardImage } = await import('../seed-pc-page-art.js');
    const html = '<div style="background:url(https://commondatastorage.googleapis.com/images.pricecharting.com/abc123/240.jpg)"></div>';
    expect(extractCardImage(html)).toBe('https://commondatastorage.googleapis.com/images.pricecharting.com/abc123/1600.jpg');
    expect(extractCardImage('<img src="https://images.pricecharting.com/xyz/1600.png">')).toBe('https://images.pricecharting.com/xyz/1600.png');
    expect(extractCardImage('<img src="https://images.pricecharting.com/no-image.jpg">')).toBeNull();
    expect(extractCardImage('<meta property="og:image" content="https://x/fallback.jpg"/>')).toBe('https://x/fallback.jpg');
    expect(extractCardImage('<html>nothing</html>')).toBeNull();
  });
});
