/**
 * Phygitals listings adapter — active LISTINGS from their public marketplace API.
 *
 * Endpoint mapped live from their own web app (2026-07-21):
 *   GET https://api.phygitals.com/api/marketplace/marketplace-listings
 *     ?searchTerm=&sortBy=price-low-high&itemsPerPage=200&page=0        (0-based)
 *     &metadataConditions={"category":["Pokemon"]}
 *     &priceRange=[null,null]&fmvRange=[null,null]&listedStatus=listed
 *   → { listings: [...], amount }
 *
 * Live counts at mapping time: Pokemon 7,956 · One Piece 400 · Yu-Gi-Oh! 36.
 * Same JSON their site renders — no key, no scraping of HTML.
 *
 * Listing shape notes (all verified live):
 * - `name` TRUNCATES at ~32 chars; metadata `Title` is the full title.
 * - `price`/`lastSale` are micro-USDC strings (÷10⁴ → cents).
 * - metadata is a key/value array. Graded items: Grade 'PSA 10.0', Grader,
 *   'Cert Number', Language, Category. Some CC-vaulted items instead use
 *   CC-style keys: 'The Grade', 'Grading Company', 'Grading ID'.
 * - Pokémon rows carry 'Card Id' (e.g. 'swsh12-42') — the PTCG.io id our
 *   canonical pkmn-* ids are built from → EXACT matching, no fuzzy needed.
 *   (English only: a Japanese listing must language-route via the matcher,
 *   never exact-attach to the English row.)
 * - Troll listings exist (a $999,999,999 raw Glalie) → price sanity cap.
 *
 * Listings are ASKING prices → gacha_listings only, never the oracle.
 * (Sales come separately from the on-chain Helius indexer.)
 */
import { normalizeGrade, gradeFromTitle } from './collectorcrypt.js';
import { timedFetch } from '../net.js';

const API = 'https://api.phygitals.com/api/marketplace/marketplace-listings';

export const CATEGORIES = ['Pokemon', 'One Piece', 'Yu-Gi-Oh!'];
const CATEGORY_TO_IP = { 'Pokemon': 'PKMN', 'One Piece': 'OP', 'Yu-Gi-Oh!': 'YGO' };
const IP_LABEL = { PKMN: 'Pokemon', OP: 'One Piece', YGO: 'YuGiOh' };

const MAX_PRICE_CENTS = 25_000_000;                    // $250k sanity cap (troll asks)

/**
 * Their API hands out gateway.irys.xyz URLs that REFUSE browser loads (found
 * live 2026-07-21: 6,638 of 7,703 images failed on the desk). Their own site
 * serves the same ids via img.phygitals.com — the PLAIN file, which is what
 * their product pages render (slab photo for graded, the black 'Ungraded
 * Card' sleeve for raw). A '-cropped' derivative exists for only SOME items
 * (raw Wailmer had none, live), so using it made our desk inconsistent —
 * plain everywhere matches their own presentation exactly (Kaleb).
 */
export function fixImageUrl(url) {
  const m = /^https?:\/\/gateway\.irys\.xyz\/([A-Za-z0-9_-]+)$/.exec(url ?? '');
  return m ? `https://img.phygitals.com/${m[1]}` : (url ?? null);
}

/**
 * "Recent" means CREATED, not touched (Kaleb, 2026-07-21): their updatedAt
 * re-stamps on ANY edit (price change, offer). mostRecentListActivity.time is
 * the actual listing event — prefer it; normalize epoch-string forms to ISO
 * so cross-marketplace string sorting stays coherent.
 */
export function listTime(l) {
  const raw = l?.mostRecentListActivity?.time ?? l?.updatedAt ?? null;
  if (raw == null) return null;
  const s = String(raw);
  if (/^\d{12,}$/.test(s)) return new Date(Number(s)).toISOString();      // epoch ms
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString(); // epoch s
  return s;
}

/** metadata array → plain object (first value wins per key). */
function metaOf(l) {
  const m = {};
  for (const e of l?.metadata ?? []) if (e?.key && !(e.key in m)) m[e.key] = e.value;
  return m;
}

/** Map one Phygitals listing → normalized row, or null. */
export function mapListing(l, category, seenAt) {
  if (!l?.address || l.listed === false) return null;
  const cents = Math.round(Number(l.price) / 10_000);  // micro-USDC → cents
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) return null;

  const meta = metaOf(l);
  const ip = CATEGORY_TO_IP[category] ?? null;

  // Grade: standard keys first ('PSA 10.0' + Grader), then CC-style vault
  // keys, then title parse. Grader with no number = Authentic slab.
  let grade = 'raw';
  const gradeStr = meta.Grade ?? meta['The Grade'] ?? '';
  const grader = meta.Grader ?? meta['Grading Company'] ?? '';
  const num = /([0-9]+(?:\.[0-9])?)/.exec(gradeStr)?.[1];
  if (num != null) {
    const co = /^([A-Za-z-]+)/.exec(gradeStr)?.[1];
    grade = normalizeGrade(/^(psa|bgs|cgc|sgc|beckett|tag|ags)/i.test(co ?? '') ? co : grader, parseFloat(num));
  } else if (/^(PSA|CGC|BGS|BECKETT|SGC|TAG)$/i.test(grader.trim())) {
    grade = `${grader.trim().toUpperCase() === 'BECKETT' ? 'BGS' : grader.trim().toUpperCase()}Auth`;
  }

  // Full title beats the truncated name; make Japanese explicit for the
  // language-routed matcher when the title itself doesn't say it.
  let title = meta.Title ?? l.name ?? '';
  if (grade === 'raw') grade = gradeFromTitle(title);
  const lang = meta.Language ?? null;
  if (/^japanese$/i.test(lang ?? '') && !/\b(japanese|jpn|jp)\b/i.test(title)) title += ' Japanese';

  const cert = meta['Cert Number'] ?? meta['Grading ID'] ?? null;
  // English Pokémon 'Card Id' = PTCG.io id → our canonical id, exact.
  const exactId = ip === 'PKMN' && meta['Card Id'] && !/^japanese$/i.test(lang ?? '')
    ? `pkmn-${String(meta['Card Id']).toLowerCase()}` : null;

  // HOST ATTRIBUTION (Kaleb, 2026-07-21 — the CGC-10 Mew flag): Phygitals
  // mirrors Collector Crypt-vaulted items listed via Magic Eden escrow
  // (payload: vault:'cc', marketplace:'MAGICEDEN'; native rows are vault:null,
  // marketplace:'TENSOR'). CC's own listings feed does NOT carry these
  // ME-escrowed listings, so the mirror is our only sighting — but the HOST
  // listing lives on collectorcrypt.com (same on-chain ask; Phygitals adds a
  // checkout markup on top). Attribute the row to the host: platform
  // 'collectorcrypt' makes the desk say "listed on Collector Crypt" and
  // listingUrl() link straight to collectorcrypt.com/assets/solana/<mint>.
  // external_id keeps the phyg: prefix — it marks provenance and keys the
  // ingest snapshot-replace.
  return {
    platform: l.vault === 'cc' ? 'collectorcrypt' : 'phygitals',
    external_id: `phyg:${l.address}`,
    item_name: title,
    category: IP_LABEL[ip] ?? category,
    ip,
    grade,
    price_cents: cents,
    currency: 'USDC',
    listed_at: listTime(l) ?? seenAt ?? null,   // listing EVENT time, full ISO
    image: fixImageUrl(l.image),
    nft_address: l.address,
    cert: cert != null && String(cert).trim() !== '' ? String(cert).trim() : null,
    slug: l.slug ?? null,                              // → phygitals.com/card/<slug>
    exact_card_id: exactId,
    language: lang,
    fmv_usd: Number.isFinite(Number(l.altFmv)) && Number(l.altFmv) > 0 ? Number(l.altFmv) : null,
    seen_at: seenAt ?? ((l.updatedAt ?? '').slice(0, 10) || null),
  };
}

export function makePhygitalsListingsAdapter({ fetchImpl = timedFetch, perPage = 200, maxPages = 60 } = {}) {
  return {
    name: 'phygitals',
    /** @param {{categories?:string[], seenAt?:string}} opts (categories = API names) */
    async fetchListings({ categories = CATEGORIES, seenAt } = {}) {
      const out = [];
      for (const cat of categories) {
        for (let page = 0; page < maxPages; page++) {   // 0-based, verified live
          const q = new URLSearchParams({
            searchTerm: '', sortBy: 'price-low-high',
            itemsPerPage: String(perPage), page: String(page),
            metadataConditions: JSON.stringify({ category: [cat] }),
            priceRange: '[null,null]', fmvRange: '[null,null]', listedStatus: 'listed',
          });
          const res = await fetchImpl(`${API}?${q}`, { headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
          if (!res.ok) throw new Error(`phygitals listings HTTP ${res.status} (${cat} p${page})`);
          const batch = (await res.json())?.listings ?? [];
          for (const l of batch) {
            const row = mapListing(l, cat, seenAt);
            if (row) out.push(row);
          }
          if (batch.length < perPage) break;
        }
      }
      return out;
    },
    async listCards() { return []; },
    async fetchSales() { return []; },                 // Helius on-chain indexer handles sales
  };
}
