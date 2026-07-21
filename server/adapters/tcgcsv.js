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
export const CATEGORY_IDS = { YGO: 2, PKMN: 3, OP: 68 };   // Pokemon Japan (85): phase 2

export const toCents = (d) => (typeof d === 'number' && Number.isFinite(d) && d > 0) ? Math.round(d * 100) : null;

/** '(001) (Alternate Art) (Manga)' → variant label 'alternate art manga' ('(001)'-style index parens dropped). */
export function productLabel(name) {
  const parens = [...(name ?? '').matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  return parens.filter(p => !/^\d+[a-z]?$/i.test(p)).join(' ').toLowerCase().trim();
}

/** Product display name without any parentheticals: 'Sabo (001) (Alternate Art)' → 'Sabo'. */
export const baseName = (name) => (name ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

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
      name: baseName(p.name),
      label: productLabel(p.name),                           // '' = base printing
      number,
      rarity: ext.Rarity ?? null,
      group_name: group?.name ?? '',
      group_abbr: group?.abbreviation ?? '',
      prices: priceRows,                                     // {Normal:{...}, Foil:{...}}
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
