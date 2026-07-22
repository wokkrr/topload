/**
 * TCGCSV (tcgcsv.com) — free daily mirror of TCGplayer's category/group/
 * product/price data (refreshed ~20:00 UTC). TCGplayer closed its API to new
 * developers in late 2024, so this mirror is the legitimate route to their
 * numbers (Kaleb, 2026-07-21: "use the data you think best helps create a
 * more rich picture").
 *
 * What it adds to the stack:
 *   - marketPrice → external_marks(source 'tcgplayer', grade 'raw'): oracle
 *     bootstrap for cards PriceCharting doesn't cover (priority 2, conf 0.5 —
 *     the EXTERNAL_SOURCES slot was reserved for exactly this).
 *   - low/directLow → tcgplayer_prices: "cheapest on TCGplayer today" floor,
 *     display-only, never oracle (asks are not sales).
 *   - productId/url → external_ids.tcgplayer: future affiliate buy-routing.
 *
 * Coverage note: TCGplayer is a RAW-card market (slabs trade on eBay), so
 * this deepens raw + sealed — the graded ladder stays PC/on-chain.
 *
 * Verified live 2026-07-21 via browser: categories YGO=2, PKMN=3, OP=68,
 * Pokemon Japan=85 (JP deferred — set-name mapping needed). OP extendedData
 * carries exact codes (Number=OP05-001); prices are per-subtype dollars.
 */
import { timedFetch } from '../net.js';

export const BASE = 'https://tcgcsv.com/tcgplayer';
// PKMN_JA = TCGplayer's separate "Pokemon Japan" catalog (category 85) —
// Japanese printings with their own product images and JP-market prices.
// Promoted 2026-07-22: the art census put Japanese PKMN at the top of the
// artless-by-value worklist and TCGdex turned out to carry no JA data.
export const CATEGORY_IDS = { YGO: 2, PKMN: 3, OP: 68, PKMN_JA: 85 };

export const toCents = (d) => (typeof d === 'number' && Number.isFinite(d) && d > 0) ? Math.round(d * 100) : null;

/** '(001) (Alternate Art) (Manga)' → variant label 'alternate art manga' ('(001)'-style index parens dropped). */
export function productLabel(name) {
  const parens = [...(name ?? '').matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  return parens.filter(p => !/^\d+[a-z]?$/i.test(p)).join(' ').toLowerCase().trim();
}

/**
 * Product display name without any parentheticals: 'Sabo (001) (Alternate
 * Art)' → 'Sabo'. Also strips a trailing '- 003/084'-style collector-number
 * suffix (TCGplayer's Mega-era Pokémon naming, live 2026-07-22 — it broke
 * name matching for entire new sets like ME05 Pitch Black). ONLY a pure
 * number pattern is stripped — 'Magician of Dark Chaos - Black Chaos' keeps
 * its dash.
 */
export const baseName = (name) => (name ?? '')
  .replace(/\s*\([^)]*\)\s*/g, ' ')
  .replace(/\s+-\s+[A-Z]{0,4}\d{1,3}[a-z]?\s*\/\s*[A-Z]{0,4}\d{1,3}\s*$/i, ' ')
  .replace(/\s+/g, ' ').trim();

export const normName = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** extendedData [{name, value}] → plain object. */
export const extData = (p) => Object.fromEntries((p?.extendedData ?? []).map(e => [e.name, e.value]));

/**
 * One group's products+prices → card rows ready for matching. Sealed and
 * accessories (no Number in extendedData) are dropped — this feed attaches to
 * the card spine only, it never creates catalog rows.
 */
export function mapGroupProducts(products, prices, group) {
  const byProduct = new Map();
  for (const pr of prices ?? []) {
    const g = byProduct.get(pr.productId) ?? {};
    g[pr.subTypeName ?? 'Normal'] = {
      market_cents: toCents(pr.marketPrice), low_cents: toCents(pr.lowPrice),
      mid_cents: toCents(pr.midPrice), high_cents: toCents(pr.highPrice),
      direct_low_cents: toCents(pr.directLowPrice),
    };
    byProduct.set(pr.productId, g);
  }
  const out = [];
  for (const p of products ?? []) {
    const ext = extData(p);
    const number = (ext.Number ?? '').trim();
    if (!number) continue;                                   // sealed/accessory
    const priceRows = byProduct.get(p.productId);
    if (!priceRows) continue;                                // unpriced product
    out.push({
      product_id: p.productId,
      url: p.url ?? null,
      // Product-id-derived hi-res product image — clean scans of the EXACT
      // printing (incl. reverse-holo patterns official art can't show).
      image_url: `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_in_1000x1000.jpg`,
      name: baseName(p.name),
      label: productLabel(p.name),                           // '' = base printing
      number,
      rarity: ext.Rarity ?? null,
      group_name: group?.name ?? '',
      group_abbr: group?.abbreviation ?? '',
      group_published: (group?.publishedOn ?? '').slice(0, 10) || null,   // set release date
      prices: priceRows,                                     // {Normal:{...}, Foil:{...}}
    });
  }
  return out;
}

/**
 * The SEALED side of a group: number-less priced products (booster boxes,
 * ETBs, decks, tins…) the card mapper deliberately drops. Feeds the
 * `products` bucket (Kaleb, 2026-07-22 — on hand, in house, unsurfaced).
 */
export function productKind(name) {
  const n = (name ?? '').toLowerCase();
  if (/booster box|display/.test(n)) return 'booster-box';
  if (/elite trainer|etb/.test(n)) return 'etb';
  if (/booster (pack|bundle)|blister|sleeved booster/.test(n)) return 'pack';
  if (/deck/.test(n)) return 'deck';
  if (/tin/.test(n)) return 'tin';
  if (/collection|box|case/.test(n)) return 'box';
  return 'other';
}
export function mapGroupSealed(products, prices, group) {
  const byProduct = new Map();
  for (const pr of prices ?? []) {
    const g = byProduct.get(pr.productId) ?? {};
    g[pr.subTypeName ?? 'Normal'] = {
      market_cents: toCents(pr.marketPrice), low_cents: toCents(pr.lowPrice),
      mid_cents: toCents(pr.midPrice), high_cents: toCents(pr.highPrice),
      direct_low_cents: toCents(pr.directLowPrice),
    };
    byProduct.set(pr.productId, g);
  }
  const out = [];
  for (const p of products ?? []) {
    if ((extData(p).Number ?? '').trim()) continue;         // numbered = a card, not sealed
    const priceRows = byProduct.get(p.productId);
    if (!priceRows) continue;                               // unpriced accessory noise
    out.push({
      product_id: p.productId,
      name: (p.name ?? '').trim(),
      kind: productKind(p.name),
      image_url: `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_in_1000x1000.jpg`,
      group_name: group?.name ?? '',
      group_published: (group?.publishedOn ?? '').slice(0, 10) || null,
      url: p.url ?? null,
      prices: priceRows,
    });
  }
  return out;
}

/** Fetch JSON with the tcgcsv envelope unwrapped. */
export async function fetchTcgcsv(path, { fetchImpl = timedFetch } = {}) {
  const res = await fetchImpl(`${BASE}${path}`, { headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`tcgcsv HTTP ${res.status} (${path})`);
  const j = await res.json();
  return j?.results ?? j;
}
