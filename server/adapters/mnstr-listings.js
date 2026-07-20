/**
 * MNSTR listings adapter (MegaETH vault marketplace) — active LISTINGS.
 *
 * Official public API, no key (verified live 2026-07-20):
 *   GET https://api.mnstr.xyz/mnstr/collection
 *   → { data: [ { title, set, year, serialNumber, grading, gradingCompany,
 *       listPriceUsd, fmv, image, category:'pokemon'|'one_piece', slug,
 *       canBeSold, isInStock, isNew } ], metadata }
 * ~1,164 in-stock priced cards (PKMN + OP). Everything inline — no per-card
 * enrichment. Listings are ASKING prices → gacha_listings only, never the
 * oracle. No scraping: MNSTR's own documented public endpoint.
 *
 * (Sales for MNSTR come separately from the on-chain MegaETH indexer.)
 */
import { normalizeGrade, gradeFromTitle } from './collectorcrypt.js';
import { timedFetch } from '../net.js';

const API = 'https://api.mnstr.xyz';

export const CATEGORY_TO_IP = {
  pokemon: 'PKMN',
  one_piece: 'OP',
  // yugioh: 'YGO',  // not currently in MNSTR's catalog; add if it appears
};
// Human label for the matcher/UI (mirrors other adapters' `category`).
const IP_LABEL = { PKMN: 'Pokemon', OP: 'One Piece', YGO: 'YuGiOh' };

/** Map one MNSTR collection card → normalized listing row, or null. */
export function mapListing(c, seenAt) {
  if (!c) return null;
  const usd = Number(c.listPriceUsd);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (c.isInStock === false) return null;              // not currently listed

  const ip = CATEGORY_TO_IP[c.category] ?? null;

  // grading '(PSA|BGS|BECKETT|CGC|SGC) <n>' → normalized; 'BECKETT 95' → 9.5;
  // 'BGS 10 Black' → BGS10. Fall back to title parse, else raw.
  let grade = 'raw';
  const gm = /^([A-Za-z]+)\s*([0-9]+(?:\.[0-9])?)/.exec(c.grading ?? '');
  if (gm) {
    let n = parseFloat(gm[2]);
    if (n >= 20 && Number.isInteger(n)) n = n / 10;    // 'BECKETT 95' → 9.5
    grade = normalizeGrade(gm[1], n);
  }
  if (grade === 'raw') grade = gradeFromTitle(c.title);

  const serial = String(c.serialNumber ?? c.remoteId ?? '');
  return {
    platform: 'mnstr',
    external_id: `mnstr:${serial}`,
    item_name: c.title ?? '',
    category: IP_LABEL[ip] ?? c.category ?? null,
    ip,
    grade,
    price_cents: Math.round(usd * 100),
    currency: 'USDm',
    listed_at: seenAt ?? new Date().toISOString().slice(0, 10),
    image: c.image ?? c.images?.[0]?.url ?? null,
    nft_address: serial,                                // vault serial — opaque id
    slug: c.slug ?? null,                               // → mnstr.xyz/cards/<slug>
    fmv_usd: Number.isFinite(Number(c.fmv)) ? Number(c.fmv) : null,
    seen_at: seenAt ?? new Date().toISOString().slice(0, 10),
  };
}

export function makeMnstrListingsAdapter({ fetchImpl = timedFetch, throttleMs = 300 } = {}) {
  return {
    name: 'mnstr',
    /** @param {{categories?:string[], seenAt?:string}} opts categories = IP labels to keep */
    async fetchListings({ categories = ['Pokemon', 'One Piece'], seenAt } = {}) {
      const wanted = categories?.length ? new Set(categories) : null;
      let json;
      try {
        const res = await fetchImpl(`${API}/mnstr/collection`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } catch (e) { throw new Error(`mnstr collection fetch: ${e.message}`); }
      const cards = json?.data ?? [];
      const out = [];
      for (const c of cards) {
        const row = mapListing(c, seenAt);
        if (!row) continue;
        if (wanted && !wanted.has(row.category)) continue;
        out.push(row);
      }
      return out;
    },
    async listCards() { return []; },
    async fetchSales() { return []; },   // MegaETH on-chain indexer handles sales
  };
}
