/**
 * Gacha/vault platform registry — the aggregator's coverage map.
 * status: 'live'  = adapter ingesting real listings
 *         'next'  = access path identified, adapter not built yet
 *         'recon' = platform identified, data access still being mapped
 *
 * Unifying strategy: platforms without documented APIs are still readable at
 * the chain level — listings/sales on Solana (and Polygon/Flow) are public
 * data. One chain indexer per network covers every platform on it. Scraping
 * platform websites is ruled out (ToS/credibility risk).
 */
export const PLATFORMS = [
  {
    id: 'collectorcrypt', name: 'Collector Crypt', chain: 'Solana', status: 'live',
    access: 'Official keyless marketplace API (listings). On-chain sales indexing next.',
    url: 'https://collectorcrypt.com',
  },
  {
    id: 'beezie', name: 'Beezie', chain: 'Flow + Solana', status: 'next',
    access: 'Kaleb-priority #2. Solana side (May 2026) = Helius-indexable like CC; Flow side later. Docs have no API section; recon under way.',
    url: 'https://beezie.com',
  },
  {
    id: 'mnstr', name: 'MNSTR', chain: 'Solana', status: 'next',
    access: 'Kaleb-priority #3. Marketplace live (PKMN; OP soon), FMV sorting. No public API; Helius program indexing candidate.',
    url: 'https://mnstr.xyz',
  },
  {
    id: 'courtyard', name: 'Courtyard', chain: 'Polygon', status: 'live',
    access: 'Sales indexed on-chain (escrow-pattern secondary sales; mints excluded). $99M lifetime volume. Listings TBD.',
    url: 'https://courtyard.io',
  },
  {
    id: 'phygitals', name: 'Phygitals', chain: 'Solana', status: 'live',
    access: 'Sales indexed on-chain via Core collection anchor (no marketplace program — direct USDC+Core composition). Fanatics-integrated. Listings TBD.',
    url: 'https://www.phygitals.com',
  },
  // RIP.FUN (Base) removed from the roster 2026-07-19 (Kaleb: low usage vs
  // the others right now) — re-add here when volumes justify it.
];
