/**
 * Courtyard listings adapter (Polygon vault marketplace) — active LISTINGS,
 * complementing the on-chain SALES indexer (indexer-courtyard.js).
 *
 * Official public API, no key required (verified live 2026-07-20):
 *   GET https://api.courtyard.io/index/recently-listed?page=N
 *   → { assets: [ { title, image, attributes:[{name,value}], token_id,
 *       contract, chain, listing_data:[{price:{amount:{usd}}, expiration,
 *       listedAt, orderId, side}], fmv_estimate_usd, proof_of_integrity } ],
 *       total }
 * Every field we need is inline — no per-asset enrichment call. This is a
 * rolling "recently listed" feed; polling it each ingest accumulates the
 * flow of new listings into gacha_listings over time. Listings are ASKING
 * prices → gacha_listings only, never the oracle. No scraping: this is
 * Courtyard's own documented public endpoint, the same one their site uses.
 */
import { normalizeGrade, gradeFromTitle } from './collectorcrypt.js';
import { timedFetch } from '../net.js';

const API = 'https://api.courtyard.io';

// Courtyard's "Category" attribute → our tracked IP codes. Others (Basketball,
// Football, Magic, …) map to null and are dropped by the ingest's IP scoping.
export const CATEGORY_TO_IP = {
  'Pokémon': 'PKMN', 'Pokemon': 'PKMN',
  'One Piece': 'OP',
  'Yu-Gi-Oh!': 'YGO', 'Yu-Gi-Oh': 'YGO', 'YuGiOh': 'YGO',
};

const attr = (attrs, name) => (attrs ?? []).find(a => (a.name ?? '') === name)?.value ?? null;

/**
 * Map one Courtyard asset (from recently-listed) to a normalized listing row,
 * or null if it isn't a priced single-card listing we track.
 * @param {object} a asset object
 * @param {string} [seenAt] YYYY-MM-DD
 */
export function mapListing(a, seenAt) {
  if (!a) return null;
  const order = (a.listing_data ?? []).find(o => (o.side ?? 'sell') === 'sell') ?? a.listing_data?.[0];
  const usd = order?.price?.amount?.usd;
  if (!Number.isFinite(usd) || usd <= 0) return null;      // unpriced / bid-only

  const category = attr(a.attributes, 'Category');
  const ip = CATEGORY_TO_IP[category] ?? null;

  // Grade: Grader ('PSA') + numeric lead of Grade ('10 GEM MINT' → 10). Fall
  // back to parsing the title; else raw. (Booster packs / raw cards → 'raw'.)
  const grader = attr(a.attributes, 'Grader');
  // Slab certification number — Courtyard publishes it as the 'Serial'
  // attribute (verified in the live feed). Digits-only guard: never link a
  // malformed value to a grader's cert page.
  const serialAttr = attr(a.attributes, 'Serial');
  const cert = serialAttr && /^\d{6,12}$/.test(String(serialAttr).trim()) ? String(serialAttr).trim() : null;
  const gradeRaw = attr(a.attributes, 'Grade');
  const gradeNum = gradeRaw ? parseFloat(String(gradeRaw).match(/[0-9]+(?:\.5)?/)?.[0] ?? '') : NaN;
  let grade = grader && Number.isFinite(gradeNum) ? normalizeGrade(grader, gradeNum) : 'raw';
  if (grade === 'raw') grade = gradeFromTitle(a.title);

  const tokenId = String(a.token_id ?? '');
  return {
    platform: 'courtyard',
    external_id: `courtyard:${tokenId}`,
    item_name: a.title ?? '',
    category,                          // human category ('Pokémon'); ip derived at ingest
    ip,                                // pre-computed for convenience
    grade,
    price_cents: Math.round(usd * 100),
    currency: 'USDC',
    listed_at: (order?.listedAt ?? order?.createdAt ?? '').slice(0, 10) || (seenAt ?? null),
    image: a.image ?? a.cropped_image ?? null,
    nft_address: tokenId,              // Polygon tokenId — opaque, matches sales registry key style
    proof: a.proof_of_integrity ?? null, // courtyard.io/asset/<proof> = the listing page
    cert,                              // slab certification number (Serial attr)
    fmv_usd: Number.isFinite(a.fmv_estimate_usd) ? a.fmv_estimate_usd : null,
    seen_at: seenAt ?? new Date().toISOString().slice(0, 10),
  };
}

export function makeCourtyardListingsAdapter({ fetchImpl = timedFetch, throttleMs = 300 } = {}) {
  let last = 0;
  const throttle = async () => { const w = last + throttleMs - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = Date.now(); };

  return {
    name: 'courtyard',
    /**
     * Page the recently-listed feed, mapping + de-duplicating by token.
     * @param {{categories?:string[], maxPages?:number, seenAt?:string}} opts
     *   categories filters by the human 'Category' attribute; omit for all.
     */
    async fetchListings({ categories = ['Pokémon', 'One Piece', 'Yu-Gi-Oh!'], maxPages = 20, seenAt } = {}) {
      const wanted = categories?.length ? new Set(categories) : null;
      const out = new Map();                 // external_id → row (dedupe across pages)
      let emptyStreak = 0;
      for (let page = 0; page < maxPages; page++) {
        await throttle();
        let json;
        try {
          // Their edge 403s the default node/curl user-agent (verified from the
          // VPS 2026-07-20); a generic browser UA passes. Not IP-blocking.
          const res = await fetchImpl(`${API}/index/recently-listed?page=${page}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          if (!res.ok) break;
          json = await res.json();
        } catch { break; }
        const assets = json?.assets ?? [];
        if (!assets.length) { if (++emptyStreak >= 2) break; continue; }
        emptyStreak = 0;
        let added = 0;
        for (const a of assets) {
          const row = mapListing(a, seenAt);
          if (!row) continue;
          if (wanted && !wanted.has(row.category)) continue;
          if (!out.has(row.external_id)) { out.set(row.external_id, row); added++; }
        }
        // Rolling feed: once a page introduces nothing new, we've caught up.
        if (added === 0 && page > 0) break;
      }
      return [...out.values()];
    },

    async listCards() { return []; },
    async fetchSales() { return []; },     // sales come from indexer-courtyard.js
  };
}
