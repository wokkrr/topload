/**
 * Demo adapter: deterministic synthetic solds so the full pipeline
 * (ingest → outlier filter → oracle → indexes → UI) runs with zero API keys.
 * Swap for live adapters without touching anything downstream.
 */

const DAY_MS = 86_400_000;

// Mulberry32 — tiny seeded PRNG, deterministic across runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARDS = [
  // ip, name, set, number, base price USD, weekly sales rate, drift/day
  ['PKMN', 'Charizard ex', '151', '199/165', 240, 14, 0.0015],
  ['PKMN', 'Pikachu with Grey Felt Hat', 'SVP', '085', 480, 9, 0.002],
  ['PKMN', 'Umbreon VMAX (Alt Art)', 'Evolving Skies', '215/203', 1450, 6, 0.0022],
  ['PKMN', 'Moonbreon Mini... Umbreon V (Alt)', 'Evolving Skies', '189/203', 620, 7, 0.0018],
  ['PKMN', 'Giratina V (Alt Art)', 'Lost Origin', '186/196', 390, 8, 0.001],
  ['PKMN', 'Lugia V (Alt Art)', 'Silver Tempest', '186/195', 430, 7, 0.0008],
  ['PKMN', 'Iono (SIR)', 'Paldea Evolved', '269/193', 310, 11, 0.0012],
  ['PKMN', 'Charizard UPC Promo', 'SWSH', '154', 95, 18, 0.0005],
  ['PKMN', 'Mew ex (SIR)', '151', '205/165', 165, 12, 0.0009],
  ['PKMN', 'Gengar VMAX (Alt)', 'Fusion Strike', '271/264', 520, 5, 0.0016],
  ['PKMN', 'Rayquaza VMAX (Alt)', 'Evolving Skies', '218/203', 980, 5, 0.002],
  ['PKMN', 'Blastoise ex (SIR)', '151', '200/165', 130, 10, 0.0007],
  ['OP', 'Monkey D. Luffy (Alt Art)', 'OP-01', 'ST01-012', 210, 12, 0.0025],
  ['OP', 'Shanks (Alt Art)', 'OP-01', 'OP01-120', 640, 8, 0.003],
  ['OP', 'Nami (Alt Art)', 'OP-01', 'OP01-016', 380, 9, 0.0021],
  ['OP', 'Yamato (Alt Art)', 'OP-01', 'OP01-121', 290, 10, 0.0019],
  ['OP', 'Zoro (Manga Art)', 'OP-06', 'OP06-118', 550, 6, 0.0028],
  ['OP', 'Boa Hancock (Alt)', 'OP-07', 'OP07-051', 240, 11, 0.0017],
  ['OP', 'Ace (Alt Art)', 'OP-02', 'OP02-013', 330, 8, 0.0015],
  ['OP', 'Sabo (Alt Art)', 'OP-04', 'OP04-083', 180, 9, 0.0011],
  ['OP', 'Kaido (Alt Art)', 'OP-01', 'OP01-094', 260, 7, 0.0013],
  ['OP', 'Trafalgar Law (Manga)', 'OP-05', 'OP05-069', 720, 5, 0.0032],
];

function slug(ip, name, number) {
  return `${ip.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${number.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function makeDemoAdapter({ days = 150, endDate = '2026-07-18', seed = 42 } = {}) {
  const cards = CARDS.map(([ip, name, set_name, number, base, weekly, drift], i) => ({
    id: slug(ip, name, number),
    ip, name, set_name, number,
    variant: '',
    external_ids: {},
    _base: base, _weekly: weekly, _drift: drift, _seed: seed + i * 1000,
  }));

  return {
    name: 'demo',

    async listCards() {
      return cards.map(({ _base, _weekly, _drift, _seed, ...c }) => c);
    },

    async fetchSales(cardIds, sinceISO) {
      const end = new Date(endDate).getTime();
      const since = new Date(sinceISO).getTime();
      const out = [];
      for (const card of cards) {
        if (cardIds.length && !cardIds.includes(card.id)) continue;
        for (const grade of ['raw', 'PSA10']) {
          const gMult = grade === 'PSA10' ? 2.6 : 1;
          const gSeed = grade === 'PSA10' ? 7 : 0;
          const rand = rng(card._seed + gSeed);
          let level = card._base * gMult;
          for (let d = days; d >= 0; d--) {
            const dayStart = end - d * DAY_MS;
            if (dayStart < since) { // still advance the walk for determinism
              level *= 1 + card._drift + (rand() - 0.5) * 0.02;
              rand(); rand();
              continue;
            }
            level *= 1 + card._drift + (rand() - 0.5) * 0.02;
            // Poisson-ish daily sale count around weekly/7
            const lambda = (card._weekly * (grade === 'PSA10' ? 0.6 : 1)) / 7;
            let n = 0;
            let p = Math.exp(-lambda), cum = p, u = rand();
            while (u > cum && n < 8) { n++; p *= lambda / n; cum += p; }
            for (let k = 0; k < n; k++) {
              let price = level * (1 + (rand() - 0.5) * 0.12);
              // Plant occasional garbage prints the outlier filter must catch:
              const roll = rand();
              if (roll > 0.985) price *= 2.8;        // shill / mis-listing high
              else if (roll < 0.008) price *= 0.3;   // damaged / mislabeled low
              const soldAt = new Date(dayStart + Math.floor(rand() * DAY_MS));
              out.push({
                card_id: card.id,
                grade,
                price_cents: Math.round(price * 100),
                sold_at: soldAt.toISOString(),
                source: 'demo',
                external_id: `${card.id}-${grade}-${d}-${k}`,
              });
            }
          }
        }
      }
      return out;
    },
  };
}
