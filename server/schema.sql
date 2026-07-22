-- Topload oracle schema
-- Identity: a card is (ip, name, set, number, variant); market granularity is (card_id, grade).

CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,        -- slug, e.g. 'pkmn-151-charizard-ex-199'
  ip           TEXT NOT NULL,           -- 'PKMN' | 'OP' (Yu-Gi-Oh later)
  name         TEXT NOT NULL,
  set_name     TEXT,
  number       TEXT,
  variant      TEXT NOT NULL DEFAULT '',-- 'holo', 'alt-art', ...
  image        TEXT,                    -- official card art URL (pokemontcg.io etc.)
  external_ids TEXT NOT NULL DEFAULT '{}' -- JSON: { pricecharting, ebayQuery, ptcgio, ... }
);

-- Raw solds. Never asking prices. Outliers are flagged, not deleted (auditability).
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id        TEXT NOT NULL REFERENCES cards(id),
  grade          TEXT NOT NULL DEFAULT 'raw', -- 'raw','PSA10','PSA9','CGC9.5',...
  price_cents    INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  sold_at        TEXT NOT NULL,               -- ISO 8601 date
  source         TEXT NOT NULL,               -- 'ebay','pricecharting','demo',...
  external_id    TEXT,                        -- source-side id, dedupe key
  is_outlier     INTEGER NOT NULL DEFAULT 0,
  outlier_reason TEXT,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_card_grade_date ON sales(card_id, grade, sold_at);

-- Daily oracle mark per (card, grade).
-- basis: 'solds'    = computed here from raw non-outlier sales (first-class)
--        'external' = trusted solds-derived series (e.g. PriceCharting) used as
--                     bootstrap where raw solds aren't accessible; confidence is
--                     discounted and provenance is never hidden.
CREATE TABLE IF NOT EXISTS oracle_prices (
  card_id     TEXT NOT NULL,
  grade       TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  sales_7d    INTEGER NOT NULL,
  sales_30d   INTEGER NOT NULL,
  confidence  REAL NOT NULL,               -- 0..1, see oracle.js
  basis       TEXT NOT NULL DEFAULT 'solds',
  source      TEXT,                        -- which external source, when basis='external'
  PRIMARY KEY (card_id, grade, as_of)
);

-- Current gacha/vault marketplace listings (snapshot, refreshed each ingest).
-- Asking prices — NEVER oracle input; used for the aggregator + comp-deltas.
CREATE TABLE IF NOT EXISTS gacha_listings (
  platform    TEXT NOT NULL,               -- 'collectorcrypt', ...
  external_id TEXT NOT NULL,               -- platform-side id (nft address / db id)
  card_id     TEXT,                        -- matched card in our universe (nullable)
  item_name   TEXT NOT NULL,
  category    TEXT,                        -- 'Pokemon', ...
  grade       TEXT,                        -- normalized: 'PSA10', 'CGC9.5', 'raw'
  price_cents INTEGER NOT NULL,            -- listing ask (USDC ≈ USD)
  currency    TEXT NOT NULL DEFAULT 'USDC',
  listed_at   TEXT,
  image       TEXT,
  nft_address TEXT,
  seen_at     TEXT NOT NULL,               -- snapshot timestamp (ISO date)
  PRIMARY KEY (platform, external_id)
);

-- Every slab NFT we have ever identified: mint → card mapping. Populated from
-- listings snapshots (pre-sale) and DAS metadata lookups (post-hoc), so sales
-- of long-gone listings can still be attributed to cards.
CREATE TABLE IF NOT EXISTS nft_registry (
  mint       TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  card_id    TEXT,                         -- matched card (nullable = unattributed)
  item_name  TEXT,
  category   TEXT,
  grade      TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Indexer bookkeeping (pagination cursors etc.).
CREATE TABLE IF NOT EXISTS indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Daily observations of external solds-derived price series (not raw sales).
-- Kept separate from `sales` so the solds-only invariant of that table holds.
CREATE TABLE IF NOT EXISTS external_marks (
  source       TEXT NOT NULL,              -- 'pricecharting', 'tcgplayer'
  card_id      TEXT NOT NULL,
  grade        TEXT NOT NULL,
  as_of        TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,
  sales_volume INTEGER,                    -- source-reported liquidity (PC CSV); index weighting fallback
  PRIMARY KEY (source, card_id, grade, as_of)
);
CREATE INDEX IF NOT EXISTS idx_external_marks_card ON external_marks(card_id, grade, as_of);
-- Latest-mark lookups (movers/screener/gacha 'WHERE as_of = MAX(as_of)') scan
-- by date; the PK leads with card_id so date-first queries need this index.
-- oracle_prices grows ~260k rows per marked day — without it, every screener
-- load is a full-table scan (observed as site-wide slowdown, 2026-07-20).
CREATE INDEX IF NOT EXISTS idx_oracle_asof ON oracle_prices(as_of, card_id, grade);

-- Materialized latest mark per (card, grade) with 1D/30D lookbacks baked in.
-- Rebuilt by refreshLatestMarks() whenever marks change (ingest/backfills).
-- Every hot read path (screener, movers, basket, gacha comps) reads THIS
-- (~60k rows) instead of scanning/grouping oracle_prices (millions of rows;
-- /api/movers was 5.9s and /api/cards 1.3s before this — 2026-07-20).
CREATE TABLE IF NOT EXISTS latest_marks (
  card_id     TEXT NOT NULL,
  grade       TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  confidence  REAL NOT NULL,
  basis       TEXT NOT NULL,
  source      TEXT,
  sales_7d    INTEGER NOT NULL,
  sales_30d   INTEGER NOT NULL,
  price_1d    INTEGER,
  price_7d    INTEGER,                      -- nearest mark ≥7 days back (movers window)
  prov_7d     TEXT,                         -- that mark's basis|source — movers only trust same-stream deltas
  price_30d   INTEGER,
  PRIMARY KEY (card_id, grade)
);
-- Screener's default sort (price high→low, LIMIT 100) reads pre-sorted.
CREATE INDEX IF NOT EXISTS idx_latest_price ON latest_marks(price_cents DESC);

-- Language-sibling lookup on the card page (EN ↔ JP printings of the same
-- card): candidates by ip+number, name fallback for number-less promo rows.
CREATE INDEX IF NOT EXISTS idx_cards_ip_number ON cards(ip, number);
CREATE INDEX IF NOT EXISTS idx_cards_ip_name   ON cards(ip, name);

-- Value Pulse outcome ledger: every surfaced deal, snapshotted daily, so the
-- radar can be GRADED by what the market did next (sold near mark = hit;
-- lingered/cut = the mark or liquidity read was off). Append-only.
CREATE TABLE IF NOT EXISTS pulse_log (
  as_of       TEXT NOT NULL,               -- snapshot date
  platform    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  grade       TEXT NOT NULL,
  ask_cents   INTEGER NOT NULL,
  mark_cents  INTEGER NOT NULL,
  discount    REAL NOT NULL,
  basis       TEXT,                        -- mark provenance at flag time
  confidence  REAL,
  sales_30d   INTEGER,
  PRIMARY KEY (as_of, platform, external_id)
);

-- TCGplayer daily snapshot (via the TCGCSV mirror) — LATEST per card+subtype.
-- THE SEALED BUCKET (Kaleb, 2026-07-22: "put the sealed product in a
-- separate bucket from the card database but one that could be called upon
-- whenever we may want to address sealed product… great data to have on
-- hand and in house"). Number-less TCGplayer products — booster boxes,
-- ETBs, decks, tins, collections — the card mapper deliberately drops.
-- Deliberately UNSURFACED for now (earn-your-pixels): a data shelf, not a
-- feature. Never joins card comps.
CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,             -- '<ip>-tp<productId>'
  ip           TEXT NOT NULL,
  name         TEXT NOT NULL,
  set_name     TEXT,
  language     TEXT NOT NULL DEFAULT 'English',
  kind         TEXT,                         -- 'booster-box'|'etb'|'pack'|'deck'|'tin'|'box'|'other'
  image        TEXT,
  released_at  TEXT,
  external_ids TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS product_prices (
  product_id       TEXT NOT NULL,
  subtype          TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  market_cents     INTEGER,
  low_cents        INTEGER,
  mid_cents        INTEGER,
  high_cents       INTEGER,
  direct_low_cents INTEGER,
  PRIMARY KEY (product_id, subtype, as_of)   -- daily history, sealed charts later
);

-- market feeds external_marks (oracle bootstrap); low/direct_low are ask
-- FLOORS: display-only comps ("cheapest on TCGplayer"), never oracle input.
CREATE TABLE IF NOT EXISTS tcgplayer_prices (
  card_id          TEXT NOT NULL,
  subtype          TEXT NOT NULL,           -- 'Normal' | 'Foil' | …
  as_of            TEXT NOT NULL,           -- snapshot date (freshness)
  market_cents     INTEGER,
  low_cents        INTEGER,
  mid_cents        INTEGER,
  high_cents       INTEGER,
  direct_low_cents INTEGER,
  product_id       INTEGER NOT NULL,        -- TCGplayer product (affiliate routing later)
  product_url      TEXT,
  PRIMARY KEY (card_id, subtype)
);

-- Rules-based basket membership, recorded per rebalance date.
CREATE TABLE IF NOT EXISTS basket_members (
  index_id TEXT NOT NULL,                  -- 'PKMN','OP'
  as_of    TEXT NOT NULL,                  -- rebalance date
  card_id  TEXT NOT NULL,
  grade    TEXT NOT NULL,
  weight   REAL NOT NULL,                  -- liquidity weight share at rebalance
  PRIMARY KEY (index_id, as_of, card_id, grade)
);

-- Chained, liquidity-weighted index level, normalized to 100 at inception.
CREATE TABLE IF NOT EXISTS index_values (
  index_id  TEXT NOT NULL,
  as_of     TEXT NOT NULL,
  value     REAL NOT NULL,                 -- normalized (base = 100)
  raw_level REAL NOT NULL,                 -- pre-normalization level (audit)
  PRIMARY KEY (index_id, as_of)
);

-- ── Pop counts (roadmap layer 4): grader-reported population per card+grade.
-- Attached to the spine exactly like prices: source + as_of provenance,
-- refreshed on rotation (PSA free tier ≈100 calls/day).
CREATE TABLE IF NOT EXISTS pop_counts (
  source       TEXT NOT NULL,            -- 'psa' | 'cgc' | 'tag' | 'bgs'
  card_id      TEXT NOT NULL,
  grade        TEXT NOT NULL,            -- normalized ('PSA10')
  count        INTEGER NOT NULL,         -- population at this grade
  higher_count INTEGER,                  -- population above this grade
  as_of        TEXT NOT NULL,            -- ISO date of the observation
  PRIMARY KEY (source, card_id, grade, as_of)
);
CREATE INDEX IF NOT EXISTS idx_pop_card ON pop_counts(card_id, grade, as_of);

-- ── PSA cert archive: every cert we look up, kept verbatim. Doubles as the
-- future cert-based identification layer (a cert lookup returns the card's
-- full identity — converts number-only unmatchable listings into matched ones).
CREATE TABLE IF NOT EXISTS psa_certs (
  cert       TEXT PRIMARY KEY,
  spec_id    TEXT,
  card_id    TEXT,                       -- our matched canonical card, when known
  grade      TEXT,
  label      TEXT,                       -- human identity line from the cert
  raw        TEXT,                       -- full API response JSON (provenance)
  fetched_at TEXT NOT NULL
);

-- Sealed book daily tape (2026-07-23, tcgquant study): supply/price history
-- per product — units available, best ask, market. The signal layer
-- (inventory-days, supply contraction, CAGR) is just time-series over this;
-- history can't be backfilled, so the tape starts rolling the day the shelf
-- exists. One row per (day, product), idempotent.
CREATE TABLE IF NOT EXISTS sealed_book_log (
  as_of          TEXT NOT NULL,
  product_id     TEXT NOT NULL,
  units          INTEGER NOT NULL,            -- mint-deduped physical units live
  best_ask_cents INTEGER,
  market_cents   INTEGER,
  PRIMARY KEY (as_of, product_id)
);
