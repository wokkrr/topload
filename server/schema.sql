-- Topload oracle schema
-- Identity: a card is (ip, name, set, number, variant); market granularity is (card_id, grade).

CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,        -- slug, e.g. 'pkmn-151-charizard-ex-199'
  ip           TEXT NOT NULL,           -- 'PKMN' | 'OP' (Yu-Gi-Oh later)
  name         TEXT NOT NULL,
  set_name     TEXT,
  number       TEXT,
  variant      TEXT NOT NULL DEFAULT '',-- 'holo', 'alt-art', ...
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

-- Daily oracle mark per (card, grade), computed from non-outlier solds.
CREATE TABLE IF NOT EXISTS oracle_prices (
  card_id     TEXT NOT NULL,
  grade       TEXT NOT NULL,
  as_of       TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  sales_7d    INTEGER NOT NULL,
  sales_30d   INTEGER NOT NULL,
  confidence  REAL NOT NULL,               -- 0..1, see oracle.js
  PRIMARY KEY (card_id, grade, as_of)
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
