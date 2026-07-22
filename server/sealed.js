/**
 * THE SEALED BOOK (Kaleb, 2026-07-23): sealed product is FUNGIBLE — "they
 * all kind of ARE the same… the only thing different is the price." So the
 * desk's Sealed section becomes an order book: ONE entry per product, the
 * cheapest live ask as the buy box, remaining units stacked as depth.
 * "Cheapest listing would obviously be sold first and if that sells the
 * next one becomes the listing."
 *
 * DOUBLE-SPEND GUARD (Kaleb: "phygitals lists collector crypt sealed
 * product… make sure they are not for the same product"): platforms
 * tokenize sealed inventory like slabs, and listings carry nft_address —
 * a mirror listing carries the SAME underlying token. Depth counts
 * PHYSICAL UNITS: listings sharing a mint collapse to one unit at the
 * cheaper ask (naturally the host — mirrors add checkout markup). Listings
 * without a mint fall back to (platform, external_id) uniqueness — they
 * can't be cross-venue deduped, which is honest-approximate, not wrong.
 *
 * Matching doctrine unchanged: a listing joins a product only when the
 * product's full name evidence appears in the title (with ETB-class
 * abbreviations expanded). Ambiguous → ungrouped, never wrongly grouped.
 */

const squash = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Expand marketplace abbreviations so 'PE ETB' can meet 'Elite Trainer Box'. */
export const expandTitle = (t) => squash(t)
  .replace(/\betb\b/g, 'elite trainer box')
  .replace(/\bbb\b/g, 'booster box')
  .replace(/\bpc\b/g, 'pokemon center');

const STOP = new Set(['pokemon', 'the', 'of', 'and', 'tcg', 'sealed', 'new', 'factory']);
const tokensOf = (s) => s.split(' ').filter(w => w.length >= 2 && !STOP.has(w));

/**
 * Attribute sealed listings to products. A product matches when EVERY
 * distinctive token of its name appears in the expanded title; among
 * multiple matches the most specific (most tokens) wins, ties = ungrouped.
 */
export function matchSealedToProducts(listings, products) {
  const compiled = products.map(p => ({ id: p.id, toks: tokensOf(squash(p.name)) })).filter(p => p.toks.length >= 2);
  const out = new Map();
  for (const l of listings) {
    const title = ` ${expandTitle(l.item_name)} `;
    let best = null, bestLen = 0, tied = false;
    for (const p of compiled) {
      if (!p.toks.every(t => title.includes(` ${t} `))) continue;
      if (p.toks.length > bestLen) { best = p.id; bestLen = p.toks.length; tied = false; }
      else if (p.toks.length === bestLen && p.id !== best) tied = true;
    }
    if (best && !tied) out.set(l.external_id, best);
  }
  return out;
}

/**
 * Build the book: per product with live inventory — buy box (cheapest
 * physical unit), depth ladder, unit count, and the product's market price
 * for the deal read ("market $102 · best ask $89.99").
 */
export function buildSealedBook(db) {
  const listings = db.prepare(
    `SELECT platform, external_id, item_name, price_cents, nft_address, product_id, image, proof, seen_at
     FROM gacha_listings WHERE product_id IS NOT NULL`).all();
  const byProduct = new Map();
  for (const l of listings) {
    (byProduct.get(l.product_id) ?? byProduct.set(l.product_id, []).get(l.product_id)).push(l);
  }
  const prodStmt = db.prepare(`SELECT id, ip, name, set_name, language, kind, image, released_at FROM products WHERE id = ?`);
  const mktStmt = db.prepare(
    `SELECT market_cents FROM product_prices WHERE product_id = ? AND market_cents IS NOT NULL
     ORDER BY as_of DESC LIMIT 1`);
  const out = [];
  for (const [pid, ls] of byProduct) {
    const p = prodStmt.get(pid);
    if (!p) continue;
    // DOUBLE-SPEND GUARD: one physical unit per mint; mintless fall back to
    // their own (platform, external_id) — never cross-deduped.
    const byUnit = new Map();
    for (const l of ls) {
      const unit = l.nft_address ? `mint:${l.nft_address}` : `row:${l.platform}:${l.external_id}`;
      const cur = byUnit.get(unit);
      if (!cur || l.price_cents < cur.price_cents) byUnit.set(unit, l);   // mirror collapses to cheaper ask (the host)
    }
    const units = [...byUnit.values()].sort((a, b) => a.price_cents - b.price_cents);
    const mkt = mktStmt.get(pid)?.market_cents ?? null;
    out.push({
      product_id: pid, name: p.name, set_name: p.set_name, ip: p.ip,
      language: p.language, kind: p.kind, image: p.image, released_at: p.released_at,
      units: units.length,
      mirrors_collapsed: ls.length - units.length,
      best: { platform: units[0].platform, external_id: units[0].external_id, price_cents: units[0].price_cents, image: units[0].image, proof: units[0].proof ?? null, nft_address: units[0].nft_address ?? null, item_name: units[0].item_name },
      asks: units.slice(0, 8).map(u => ({ platform: u.platform, price_cents: u.price_cents })),
      market_cents: mkt,
      discount: mkt && mkt > 0 ? +(1 - units[0].price_cents / mkt).toFixed(3) : null,
    });
  }
  // Deals first: deepest discount to market, then cheapest.
  return out.sort((a, b) => (b.discount ?? -9) - (a.discount ?? -9) || a.best.price_cents - b.best.price_cents);
}

/**
 * Daily tape (tcgquant study, 2026-07-23): snapshot the book into
 * sealed_book_log — units live, best ask, market — one row per (day,
 * product). Supply signals (inventory-days, contraction, CAGR) are just
 * time-series over this, and history can't be backfilled: the tape rolls
 * from day one even though nothing surfaces it yet.
 */
export function logSealedBook(db, asOf) {
  const book = buildSealedBook(db);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sealed_book_log (as_of, product_id, units, best_ask_cents, market_cents)
     VALUES (?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (const b of book) ins.run(asOf, b.product_id, b.units, b.best.price_cents ?? null, b.market_cents);
  db.exec('COMMIT');
  return { logged: book.length };
}

/** Ingest pass: (re)attribute today's sealed listings to the product shelf. */
export function attributeSealedListings(db, { isSealedFn }) {
  const listings = db.prepare(
    `SELECT platform, external_id, item_name, grade FROM gacha_listings`).all()
    .filter(l => isSealedFn(l));
  const products = db.prepare(`SELECT id, name FROM products`).all();
  if (!products.length || !listings.length) return { sealedListings: listings.length, attributed: 0 };
  const matches = matchSealedToProducts(listings, products);
  const upd = db.prepare(`UPDATE gacha_listings SET product_id = ? WHERE platform = ? AND external_id = ?`);
  db.exec('BEGIN');
  let n = 0;
  for (const l of listings) {
    const pid = matches.get(l.external_id) ?? null;
    if (pid) n++;
    upd.run(pid, l.platform, l.external_id);
  }
  db.exec('COMMIT');
  return { sealedListings: listings.length, attributed: n };
}
