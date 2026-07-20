import { describe, it, expect } from 'vitest';
import { makeCollectorCryptAdapter, normalizeGrade, gradeFromTitle } from '../adapters/collectorcrypt.js';
import { matchListing, categoryToIp } from '../match.js';

const jsonRes = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('collectorcrypt adapter (fixtures)', () => {
  const page = {
    totalPages: 1,
    filterNFtCard: [
      { id: 'a1', itemName: '2023 Pokemon 151 Charizard ex #199 PSA 10', nftAddress: 'MINT1',
        category: 'Pokemon', gradeNum: 10, gradingCompany: 'PSA',
        listing: { price: '825.5', currency: 'USDC', createdAt: '2026-07-01T00:00:00Z' },
        images: { frontM: 'https://img/x.jpg' } },
      { id: 'a2', itemName: 'Unlisted vault card', category: 'Pokemon', gradeNum: 9, gradingCompany: 'CGC' }, // no listing
      { id: 'a3', itemName: 'Michael Jordan rookie PSA 8', nftAddress: 'MINT3', category: 'Basketball',
        gradeNum: 8, gradingCompany: 'PSA', listing: { price: '5000', currency: 'USDC' } }, // filtered category
      { id: 'a4', itemName: 'Shanks OP01-120 Alt CGC 9.5', nftAddress: 'MINT4', category: 'One Piece',
        gradeNum: 9.5, gradingCompany: 'CGC', listing: { price: '610', currency: 'USDC' } },
    ],
  };

  it('keeps only listed cards in target categories, normalized', async () => {
    const cc = makeCollectorCryptAdapter({ fetchImpl: () => jsonRes(page), throttleMs: 0 });
    const listings = await cc.fetchListings({ seenAt: '2026-07-19' });
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      platform: 'collectorcrypt', external_id: 'MINT1', grade: 'PSA10',
      price_cents: 82550, currency: 'USDC', image: 'https://img/x.jpg', seen_at: '2026-07-19',
    });
    expect(listings[1]).toMatchObject({ external_id: 'MINT4', grade: 'CGC9.5', price_cents: 61000 });
  });

  it('normalizes grades', () => {
    expect(normalizeGrade('PSA', 10)).toBe('PSA10');
    expect(normalizeGrade('CGC', 9.5)).toBe('CGC9.5');
    expect(normalizeGrade('psa', '9')).toBe('PSA9');
    expect(normalizeGrade('Beckett', 9.5)).toBe('BGS9.5');
    expect(normalizeGrade(null, 10)).toBe('raw');
    expect(normalizeGrade('PSA', null)).toBe('raw');
  });

  it('falls back to parsing the grade from the title', () => {
    expect(gradeFromTitle('2022 #001 Monkey D. Luffy PSA 10 One Piece Starter Deck')).toBe('PSA10');
    expect(gradeFromTitle('Zoro MANGA ART SEC BGS 9.5 Wings of the Captain')).toBe('BGS9.5');
    expect(gradeFromTitle('Charizard Base Set near mint')).toBe('raw');
  });

  it('title-grade fallback applies when structured fields are missing', async () => {
    const page = { totalPages: 1, filterNFtCard: [
      { id: 'x1', itemName: '2022 #001 Luffy PSA 10 One Piece', nftAddress: 'M1', category: 'One Piece',
        listing: { price: '3550', currency: 'USDC' } }, // no gradingCompany/gradeNum
    ]};
    const cc = makeCollectorCryptAdapter({ fetchImpl: () => jsonRes(page), throttleMs: 0 });
    const [l] = await cc.fetchListings({ seenAt: '2026-07-19' });
    expect(l.grade).toBe('PSA10');
  });
});

describe('listing→card matcher', () => {
  const cards = [
    { id: 'pkmn-sv3pt5-charizard-ex-199', name: 'Charizard ex', number: '199/165', set_name: '151' },
    { id: 'pkmn-sv3pt5-mew-ex-205', name: 'Mew ex', number: '205/165', set_name: '151' },
    { id: 'pkmn-swsh7-umbreon-vmax-215', name: 'Umbreon VMAX', number: '215/203', set_name: 'Evolving Skies' },
    { id: 'op-shanks-alt-op01-120', name: 'Shanks (Alt Art)', number: 'OP01-120', set_name: 'OP-01' },
  ];

  it('matches name + full collector number', () => {
    expect(matchListing('2021 Pokemon Evolving Skies Umbreon VMAX 215/203 Alt Art PSA 10', cards))
      .toBe('pkmn-swsh7-umbreon-vmax-215');
  });

  it('matches name + #number form', () => {
    expect(matchListing('2023 Pokemon 151 Charizard ex #199 PSA 10', cards))
      .toBe('pkmn-sv3pt5-charizard-ex-199');
  });

  it('ignores parentheticals in card names', () => {
    expect(matchListing('One Piece Shanks OP01-120 Alternate Art CGC 9.5', cards))
      .toBe('op-shanks-alt-op01-120');
  });

  it('refuses to match on name alone (number required)', () => {
    expect(matchListing('Pokemon Charizard ex holo rare', cards)).toBeNull();
  });

  it('does not cross-match different cards sharing a number token', () => {
    // 'Mew ex' title must not match Charizard even though both are 151 cards.
    expect(matchListing('Pokemon 151 Mew ex #205 PSA 10', cards)).toBe('pkmn-sv3pt5-mew-ex-205');
  });

  it('rejects deck-name traps: card names appearing after the grade token', () => {
    const withChar = [...cards, { id: 'pkmn-charizard-clc', name: 'Charizard', number: '011', set_name: 'Classic' }];
    // Electrode listing whose DECK is named after Charizard — must not match Charizard.
    expect(matchListing('2023 #011 Electrode PSA 10 Clc-Trading Card Game Classic Charizard & Ho-Oh EX Deck', withChar)).toBeNull();
  });

  it('requires set evidence: same name+number in a different set must not match', () => {
    const goldStars = [
      { id: 'pkmn-pop5-umbreon-gold-star-17', name: 'Umbreon Gold Star', number: '17', set_name: 'Pokemon POP Series 5' },
      { id: 'pkmn-celebrations-umbreon-gold-star-17', name: 'Umbreon Gold Star', number: '17', set_name: 'Pokemon Celebrations' },
    ];
    // The $107k 2005 original must NOT catch the Celebrations reprint listing…
    expect(matchListing('2021 #17 Umbreon-Gold Star PSA 10 Celebrations Classic Collection Pokemon', goldStars))
      .toBe('pkmn-celebrations-umbreon-gold-star-17');
    // …and with no set evidence at all, the honest answer is no match.
    expect(matchListing('Umbreon Gold Star #17 PSA 10', goldStars)).toBeNull();
  });

  it('compares collector numbers zero-insensitively', () => {
    const c = [{ id: 'pkmn-svp-magneton-159', name: 'Magneton', number: '159', set_name: 'SVP Black Star Promos' }];
    expect(matchListing('2024 #159 Magneton PSA 10 Svp EN-SV Black Star Promo Pokemon', c)).toBe('pkmn-svp-magneton-159');
  });

  it('short names only match as whole words (the trainer-N bug)', () => {
    const withN = [...cards, { id: 'pkmn-trainer-n', name: 'N', number: '100/101', set_name: 'Noble Victories' }];
    // 'Nami' contains 'n' but must NOT match the trainer card N.
    expect(matchListing('2022 #OP01016 Nami ALT ART BGS 10 One Piece Romance Dawn 100', withN)).toBeNull();
    // Genuine whole-word N listing still matches.
    expect(matchListing('Pokemon Noble Victories N #100/101 Trainer PSA 10', withN)).toBe('pkmn-trainer-n');
  });
});

describe('set evidence is whole-word (2026-07-20 substring bug)', () => {
  it("'poke' inside 'pokemon' is not evidence for Poke Card Creator", () => {
    const traps = [{ id: 'pkmn-pcc-pikachu', name: 'Pikachu', number: 'SV-P', set_name: 'Pokemon 2004 Poke Card Creator' }];
    // A $35 SV-P promo Pikachu must not comp against the $10k Poke Card Creator card.
    expect(matchListing('2025 #SV-P Pikachu EX PSA 9 Japanese SV-P Promo Pokemon', traps)).toBeNull();
  });

  it("'on'/'no' hiding inside words is not evidence for Town on No Map", () => {
    const traps = [{ id: 'pkmn-town-psyduck', name: 'Psyduck', number: '10', set_name: 'Pokemon Japanese The Town on No Map' }];
    expect(matchListing('2019 Pokemon Japanese Playing Cards Old Maid Psyduck #10 CGC 10 GEM MINT', traps)).toBeNull();
  });

  it('genuine whole-word set evidence still matches', () => {
    const real = [{ id: 'pkmn-town-psyduck', name: 'Psyduck', number: '10', set_name: 'Pokemon Japanese The Town on No Map' }];
    expect(matchListing('Pokemon Japanese The Town on No Map Psyduck #10 CGC 8', real)).toBe('pkmn-town-psyduck');
    const op = [{ id: 'op-op01-shanks', name: 'Shanks', number: 'OP01-120', set_name: 'OP-01 Romance Dawn' }];
    expect(matchListing('One Piece Romance Dawn Shanks OP01-120 Alt Art PSA 10', op)).toBe('op-op01-shanks');
  });
});

describe('One Piece set-prefixed numbers (MNSTR formats, 2026-07-20)', () => {
  const op = [
    { id: 'op-op07-luffy-109', name: 'Monkey D. Luffy', number: 'OP07-109', set_name: 'One Piece Op07-500 Years in the Future' },
    { id: 'op-op02-uta-120', name: 'Uta', number: 'OP02-120', set_name: 'One Piece Op02 Paramount War' },
    { id: 'op-op06-uta-001', name: 'Uta', number: 'OP06-001', set_name: 'One Piece Op06 Wings of the Captain' },
  ];
  it('matches split format: "Op07-500 Years… #109"', () => {
    expect(matchListing('2024 One Piece Op07-500 Years in the Future Monkey D. Luffy #109 PSA 10', op))
      .toBe('op-op07-luffy-109');
  });
  it('matches concatenated format: "#OP02120"', () => {
    expect(matchListing('2022 One Piece Card Game Paramount War Japanese Uta SEC #OP02120 BGS 10', op))
      .toBe('op-op02-uta-120');
  });
  it('matches zero-padded suffix "#001" → OP06-001', () => {
    expect(matchListing('2024 One Piece Op06 Wings of the Captain Uta Alternate Art #001 PSA 10', op))
      .toBe('op-op06-uta-001');
  });
  it('does NOT cross-match a different set prefix (same name + suffix)', () => {
    // Luffy #109 present, but set prefix is OP09 not OP07 → must not match OP07-109.
    expect(matchListing('2024 One Piece Op09 Emperors Monkey D. Luffy #109 PSA 10', op)).toBeNull();
  });
});

describe('name punctuation: dotted vs spaced (MNSTR One Piece)', () => {
  const c = [{ id: 'op-op07-dragon-015', name: 'Monkey D. Dragon', number: 'OP07-015', set_name: 'One Piece Op07 Emperors in the New World' }];
  it('matches "Monkey.D.Dragon" (dots, no spaces) to "Monkey D. Dragon"', () => {
    expect(matchListing('2024 One Piece Card Game Emperors in the New World Monkey.D.Dragon SP #OP07015 BGS 10', c))
      .toBe('op-op07-dragon-015');
  });
});

describe('Yu-Gi-Oh set codes: regional infix tolerance (2026-07-20)', () => {
  const ygo = [
    { id: 'ygo-lob-en001', name: 'Blue-Eyes White Dragon', number: 'LOB-EN001', set_name: 'Legend of Blue Eyes White Dragon' },
    { id: 'ygo-mrd-060', name: 'Summoned Skull', number: 'MRD-060', set_name: 'Metal Raiders' },
    { id: 'ygo-sdy-006', name: 'Dark Magician', number: 'SDY-006', set_name: 'Starter Deck: Yugi' },
    { id: 'ygo-lob-en005', name: 'Exodia the Forbidden One', number: 'LOB-EN005', set_name: 'Legend of Blue Eyes White Dragon' },
  ];
  it('matches vintage regionless title "LOB-001" to canonical "LOB-EN001"', () => {
    expect(matchListing('2002 Yu-Gi-Oh Legend of Blue Eyes LOB-001 Blue-Eyes White Dragon 1st Edition PSA 9', ygo))
      .toBe('ygo-lob-en001');
  });
  it('matches euro infix "LOB-E005" to canonical "LOB-EN005"', () => {
    expect(matchListing('Yu-Gi-Oh Legend of Blue Eyes Exodia the Forbidden One LOB-E005 PSA 8', ygo))
      .toBe('ygo-lob-en005');
  });
  it('full set code stands as set evidence when the set name is absent from the title', () => {
    expect(matchListing('2002 Yu-Gi-Oh Dark Magician SDY-006 1st Edition PSA 8', ygo))
      .toBe('ygo-sdy-006');
  });
  it('matches exact regionless code "MRD-060"', () => {
    expect(matchListing('Yu-Gi-Oh Metal Raiders Summoned Skull MRD-060 PSA 10', ygo))
      .toBe('ygo-mrd-060');
  });
  it('does NOT match when the code prefix differs (same name + digits)', () => {
    // Summoned Skull also printed in other sets; a SYE-numbered listing must not hit MRD-060.
    expect(matchListing('Yu-Gi-Oh Starter Deck Summoned Skull SYE-002 PSA 10', ygo)).toBeNull();
  });
  it('bare number without the code prefix does not match (needs the code or set name)', () => {
    expect(matchListing('Yu-Gi-Oh Dark Magician #006 PSA 8', ygo)).toBeNull();
  });
});

describe('canonical beats remnant; bare numerics are not substrings (live, 2026-07-20)', () => {
  const universe = [
    // Remnant (PriceCharting-derived, kept for sales FK) listed FIRST — order must not decide.
    { id: 'pkmn-pc7309838', name: 'Charizard', number: '4', set_name: 'Pokemon Base Set' },
    { id: 'pkmn-base1-4', name: 'Charizard', number: '4/102', set_name: 'Base' },
  ];
  it('the canonical card wins the same-card tie against its remnant', () => {
    expect(matchListing('1999 Pokemon Base Set Charizard Holo #4/102 PSA 9', universe))
      .toBe('pkmn-base1-4');
  });
  it('a bare numeric number does not hit inside a year ("2024" ⊅ number 4 at full strength)', () => {
    // Before the fix: numFull '4' substring-matched inside '2024' → false level-2 hit.
    expect(matchListing('2024 Pokemon Base Set Charizard Special Delivery #99 PSA 10', [universe[0]]))
      .toBeNull();
  });
  it('a bare numeric still matches via # or word boundary (level-1 path intact)', () => {
    expect(matchListing('1999 Pokemon Base Set Charizard Holo #4 PSA 9', [universe[0]]))
      .toBe('pkmn-pc7309838');
  });
});

describe('no-separator promo codes + category dialects (Courtyard 2% bug, 2026-07-20)', () => {
  const promo = [{ id: 'pkmn-swshp-SWSH285', name: 'Pikachu V', number: 'SWSH285', set_name: 'SWSH Black Star Promos' }];
  it('SWSH285 matches "Swsh Black Star Promo … #285" (split form)', () => {
    expect(matchListing('2023 Pokémon Swsh Black Star Promo #285 Pikachu V - Holo (PSA 9 MINT)', promo))
      .toBe('pkmn-swshp-SWSH285');
  });
  it('SWSH285 matches the concatenated form too', () => {
    expect(matchListing('Pokemon Black Star Promo Pikachu V SWSH285 PSA 10', promo))
      .toBe('pkmn-swshp-SWSH285');
  });
  it('does not match a different promo number', () => {
    expect(matchListing('2023 Pokémon Swsh Black Star Promo #144 Pikachu V PSA 9', promo)).toBeNull();
  });
  it('categoryToIp is accent/punctuation-insensitive across marketplace dialects', () => {
    expect(categoryToIp('Pokémon')).toBe('PKMN');
    expect(categoryToIp('Pokemon')).toBe('PKMN');
    expect(categoryToIp('Yu-Gi-Oh!')).toBe('YGO');
    expect(categoryToIp('YuGiOh')).toBe('YGO');
    expect(categoryToIp('one_piece_english')).toBe('OP');
    expect(categoryToIp('One Piece')).toBe('OP');
    expect(categoryToIp('Magic: The Gathering')).toBeNull();
    expect(categoryToIp(null)).toBeNull();
  });
});
