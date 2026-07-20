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
  // listings: active-listing ingestion live; sales: on-chain solds indexing
  // live. The UI labels chips from these flags — never overstate coverage.
  {
    id: 'collectorcrypt', name: 'Collector Crypt', chain: 'Solana', status: 'live',
    listings: true, sales: true,
    access: 'Official keyless marketplace API (listings). On-chain sales indexed.',
    url: 'https://collectorcrypt.com',
  },
  {
    id: 'beezie', name: 'Beezie', chain: 'Flow + Solana', status: 'live',
    listings: false, sales: true,
    access: 'On-chain sales indexed (Base). Listings ingestion TBD.',
    url: 'https://beezie.com',
  },
  {
    id: 'mnstr', name: 'MNSTR', chain: 'MegaETH', status: 'live',
    listings: true, sales: false,
    access: 'Listings via official public API (api.mnstr.xyz/mnstr/collection, ~1,164 in-stock). Sales on-chain on MegaETH (contract 0x5db1…, USDm) — indexer next. $5M+ volume.',
    url: 'https://mnstr.xyz',
  },
  {
    id: 'courtyard', name: 'Courtyard', chain: 'Polygon', status: 'live',
    listings: true, sales: true,
    access: 'Sales indexed on-chain; listings via official recently-listed API. $99M lifetime volume.',
    url: 'https://courtyard.io',
  },
  {
    id: 'phygitals', name: 'Phygitals', chain: 'Solana', status: 'live',
    listings: false, sales: true,
    access: 'Sales indexed on-chain via Core collection anchor. Fanatics-integrated. Listings TBD.',
    url: 'https://www.phygitals.com',
  },
  // RIP.FUN (Base) removed from the roster 2026-07-19 (Kaleb: low usage vs
  // the others right now) — re-add here when volumes justify it.
];
