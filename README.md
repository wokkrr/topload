# Topload — card terminal (working title)

Two-sided trading-card platform: aggregated marketplace (Collector side) + trader-grade
analytics marked to a solds-based price oracle (Speculator side). This repo is **build
step 1: oracle + charting**. See `HANDOFF.md` in the project for the full spec.

## Requirements

Node ≥ 22.5 (uses built-in `node:sqlite` — no native deps).

## Run it

```bash
npm install
npm run ingest   # adapters → sales → outlier flags → oracle marks → indexes (SQLite: data/topload.db)
npm run api      # read API on :5174
npm run dev      # Vite UI on :5173 (proxies /api)
npm test         # oracle + index math unit tests
```

With no API keys set, ingest uses the deterministic **demo adapter** (seeded synthetic
solds with planted outliers) so the whole pipeline runs offline. Copy `.env.example` →
`.env` to go live. Nightly cron target: `npm run ingest`.

## Data sources — the real landscape (verified July 2026)

- **eBay solds are not directly accessible**: the Finding API was decommissioned
  Feb 2025, the Browse API serves live listings only, and Marketplace Insights (the
  actual solds API) is limited-release/partner-gated. An adapter slot exists
  (`makeEbayInsightsAdapter`) — apply for access, don't depend on it.
- **PriceCharting is the primary bootstrap** (`PRICECHARTING_API_KEY`): prices derived
  from actual sold listings, split by grade. These land in `external_marks` (never in
  `sales` — that table is raw solds only) and become oracle marks with
  `basis='external'` and confidence discounted ×0.7 with staleness decay. Run
  `npm run probe:pricecharting` once to verify the grade-field mapping live.
- **pokemontcg.io** seeds the PKMN card universe (metadata, never prices); the OP
  universe is a manual seed list in `server/universe.js`.
- **eBay Browse + EPN** (`EBAY_CLIENT_ID/SECRET`, `EPN_CAMPAIGN_ID`) power aggregator
  listings + affiliate deep links in build step 2. Listings never touch the oracle.
- **On-chain gacha sales** (build step 2) are public data — they'll be the first raw
  solds source that needs no gatekeeper.

## Architecture

```
server/
  adapters/     one contract (types.js): listCards() + fetchSales() — demo, ebay, pricecharting, pokemontcg
  ingest.js     idempotent pipeline: upsert sales (deduped) → outliers → oracle → indexes
  oracle.js     pure math (tested) + persistence
  indexes.js    rules-based baskets + chained liquidity-weighted index (tested)
  api.js        express read API: /api/indexes, /api/movers, /api/basket, /api/cards/:id/series
  schema.sql    cards / sales / oracle_prices / basket_members / index_values
src/
  tokens.js     single design-token file (graphite / brass / slate; validated data-series variants)
  data/client.js  the only place UI touches the network
  ui/           IndexChart (SVG, crosshair+tooltip, table view), Movers, Basket, Gacha placeholder
```

## Oracle methodology (locked properties)

- **Solds only.** Only completed sales enter `sales`; asking prices never do.
- **Outlier filter:** a sale is flagged when it deviates from the trailing 20-sale median
  by > 2σ (σ floored at 5% of median so stable series admit normal variance). Outliers
  are flagged, never deleted, and don't poison the trailing window. Flagged rate on demo
  data ≈ 8% vs ~2.3% planted — the filter is deliberately conservative; `outlierSigma`
  / the σ floor in `oracle.js` are the calibration knobs when real eBay data lands.
- **Daily mark** per (card, grade): median of non-outlier solds in a trailing 14d window,
  widened to 30d when thin; no mark below 3 sales.
- **Confidence ∈ [0,1]:** liquidity (saturates ~10 sales) × dispersion penalty (CV) ×
  recency. Surfaced everywhere a mark is shown; downstream features filter on it.

## Index methodology (locked: rules-based)

- Basket at each monthly rebalance = **top-N (card, grade) by trailing 90D sales count**,
  confidence ≥ 0.3. No editorial picks (contrast: CL50's hand-picked, price-averaged 50).
- Weight = oracle price × weekly sales (dollar-liquidity), fixed between rebalances.
- Chained at rebalances (divisor reset) → level is continuous across membership changes.
  Normalized to 100 at inception; API re-normalizes to 100 at each chart window start.

## Build sequence

1. **Oracle + charting** ← this repo
2. Aggregator: live listings + comp-delta badges, eBay/TCGplayer affiliate deep links, wallet-connect gacha buys
3. Portfolio: cost basis marked to oracle, physical + tokenized
4. Selling facilitation: last, if ever
