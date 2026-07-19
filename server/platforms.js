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
    id: 'courtyard', name: 'Courtyard', chain: 'Polygon', status: 'next',
    access: 'No public API; sales/listings readable via Polygon NFT indexers (Reservoir-class).',
    url: 'https://courtyard.io',
  },
  {
    id: 'phygitals', name: 'Phygitals', chain: 'Solana', status: 'recon',
    access: 'Fanatics Collect integration (Apr 2026). Solana program indexing candidate.',
    url: 'https://www.phygitals.com',
  },
  // RIP.FUN (Base) removed from the roster 2026-07-19 (Kaleb: low usage vs
  // the others right now) — re-add here when volumes justify it.
  {
    id: 'mnstr', name: 'MNSTR', chain: 'Solana', status: 'recon',
    access: 'Marketplace live (PKMN; OP soon), FMV sorting. No public API found; on-chain candidate + outreach.',
    url: 'https://mnstr.xyz',
  },
  {
    id: 'beezie', name: 'Beezie', chain: 'Flow + Solana', status: 'recon',
    access: 'Docs have no API section. Solana expansion May 2026; OpenSea/TAG partners. On-chain candidate + outreach.',
    url: 'https://beezie.com',
  },
];
