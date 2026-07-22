/**
 * Import TCGplayer market data via the TCGCSV daily mirror (see adapters/
 * tcgcsv.js for what this feeds and why). Attach-only: products match into
 * the existing card spine or are counted unmatched — this importer NEVER
 * creates cards.
 *
 *   npm run import:tcgcsv                 (all of YGO, PKMN, OP)
 *   npm run import:tcgcsv -- --ip=OP
 * Env: TCGCSV_DELAY_MS (default 120), TCGCSV_MAX_GROUPS (testing cap)
 *
 * WRITER — on the droplet, queue behind the canonical guard like any other
 * writer (guard token: impor[t]-).
 */
import { openDb } from './db.js';
import { refreshOracle } from './oracle.js';
import { CATEGORY_IDS, fetchTcgcsv, mapGroupProducts, mapGroupSealed, normName } from './adapters/tcgcsv.js';

const cardLabel = (name) => (/\[([^\]]+)\]/.exec(name ?? '')?.[1] ?? '').toLowerCase().trim();
const isSatellite = (id) => /-(?:pc|tp)\d+$/.test(id);   // -tp = tcgplayer-seeded stubs (2026-07-22)

// Import targets: which TCGplayer category feeds which slice of the spine.
// PKMN_JA (category 85) is Japanese printings ONLY — a Japanese product must
// never attach marks/art to an English row and vice versa (different market,
// visibly different card), so each PKMN target gets a language-scoped universe.
export const TARGETS = {
  YGO: { ip: 'YGO' },
  PKMN: { ip: 'PKMN', langs: ['English', null] },
  OP: { ip: 'OP' },
  PKMN_JA: { ip: 'PKMN', langs: ['Japanese'] },
};

/**
 * Card-side set name, normalized for the set gate. PriceCharting console
 * names carry a franchise prefix and hard truncation ("Pokemon Japanese
 * Mysterious Mo…") while TCGplayer group names carry code prefixes ("ME04:
 * Chaos Rising") — stripping the franchise prefix lets containment bridge
 * both (live 2026-07-22: the unstripped compare left entire new sets and all
 * of Pokemon Japan unmatched). Falls back to the unstripped form when the
 * stripped remainder is too short to be evidence.
 */
export function cardSetKey(setName) {
  const n = normName(setName);
  const stripped = n.replace(/^pokemon (japanese |chinese |korean )?/, '');
  return stripped.length >= 3 ? stripped : n;
}

/** 'LOB-EN001' ↔ 'LOB-001' (YGO regional infix), '095/203' → '95' (PKMN collector no). */
export function numberKey(ip, number) {
  const n = String(number ?? '').trim().toUpperCase();
  if (!n) return null;
  if (ip === 'PKMN') return n.split('/')[0].replace(/^0+(?=\w)/, '');
  if (ip === 'YGO') return n.replace(/-(?:EN|E)(?=\d)/, '-');
  return n;
}

/**
 * Match mapped TCGCSV products against the card spine. Conservative:
 * number key must match; PKMN additionally gates on name AND set; variant
 * label picks between base/satellite rows; ambiguity = unmatched (honest).
 */
export function matchProducts(mapped, cards, ip) {
  const byNumber = new Map();
  for (const c of cards) {
    const k = numberKey(ip, c.number);
    if (!k) continue;
    (byNumber.get(k) ?? byNumber.set(k, []).get(k)).push(c);
  }
  const hits = [], misses = [];
  for (const p of mapped) {
    let cands = byNumber.get(numberKey(ip, p.number)) ?? [];
    if (ip === 'PKMN') {
      const pn = normName(p.name), gs = normName(p.group_name);
      cands = cands.filter(c => normName(c.name) === pn);
      cands = cands.filter(c => {
        const cs = cardSetKey(c.set_name);
        return cs && (cs === gs || cs.includes(gs) || gs.includes(cs));
      });
    }
    const en = cands.filter(c => (c.language ?? 'English') === 'English');
    if (en.length) cands = en;
    if (!cands.length) { misses.push(p); continue; }

    // Variant-label selection: exact label match > base-to-base > sole candidate.
    const exact = cands.filter(c => cardLabel(c.name) === p.label);
    const pool = exact.length ? exact
      : (p.label === '' ? cands.filter(c => cardLabel(c.name) === '') : (cands.length === 1 ? cands : []));
    if (!pool.length) { misses.push(p); continue; }
    pool.sort((a, b) => isSatellite(a.id) - isSatellite(b.id) || a.id.localeCompare(b.id));
    hits.push({ product: p, card: pool[0] });
  }
  return { hits, misses };
}

/** Pick the mark price: card's own foil-ness decides the subtype, Normal default. */
export function markPrice(product, cardName) {
  const wantFoil = /reverse|foil|holo/i.test(cardLabel(cardName));
  const row = (wantFoil && product.prices.Foil) ? product.prices.Foil
    : (product.prices.Normal ?? product.prices.Foil ?? Object.values(product.prices)[0]);
  return row?.market_cents ?? null;
}

export async function importTcgcsv(db, { ips = ['YGO', 'PKMN', 'OP', 'PKMN_JA'], asOf, delayMs = 120, maxGroups = Infinity, fetchImpl, createStubs = process.env.TCGCSV_CREATE_STUBS !== '0', sealedBucket = process.env.TCGCSV_SEALED !== '0' } = {}) {
  const insPrice = db.prepare(
    `INSERT OR REPLACE INTO tcgplayer_prices
     (card_id, subtype, as_of, market_cents, low_cents, mid_cents, high_cents, direct_low_cents, product_id, product_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insMark = db.prepare(
    `INSERT OR REPLACE INTO external_marks (source, card_id, grade, as_of, price_cents, sales_volume)
     VALUES ('tcgplayer', ?, 'raw', ?, ?, NULL)`);
  const attach = db.prepare(
    `UPDATE cards SET external_ids = json_set(COALESCE(external_ids, '{}'), '$.tcgplayer', ?) WHERE id = ?`);
  // Art fallback (Kaleb, 2026-07-21: "work down the chase high value cards for
  // Pokemon and yugioh that don't have card art"): TCGplayer's product image
  // IS the exact printing — clean scans, correct variant. Fills artless cards,
  // and ONLY when the variant label matches EXACTLY (a loosely-matched mark is
  // fine; a loosely-matched IMAGE is visibly wrong art).
  // QUALITY TIERING (Kaleb, 2026-07-22: "some of the card art is very poor low
  // quality… match higher quality card art"): a clean TCGplayer scan may also
  // REPLACE a 'pricecharting' product photo (the lowest tier — often a phone
  // shot); it never touches official/variant/borrowed art. The stack heals
  // upward as coverage grows.
  const fillArt = db.prepare(
    `UPDATE cards SET image = ?, image_kind = 'tcgplayer'
     WHERE id = ? AND (image IS NULL OR image_kind = 'pricecharting')`);
  // Relevant-data enrichment (Kaleb, 2026-07-22): the set's release date rides
  // every tcgcsv group (publishedOn) — never stored until now. COALESCE: first
  // writer wins, better sources (per-product PC dates) are not overwritten.
  const fillReleased = db.prepare(
    `UPDATE cards SET released_at = COALESCE(released_at, ?) WHERE id = ?`);
  // THE SPINE RULE (Kaleb, 2026-07-22: "full scope complete card database").
  // Unmatched products stop vanishing: each becomes a `<ip>-tp<productId>`
  // stub with name/number/set/art/date — closing the new-set EN gap AND the
  // modern-JP gap the moment TCGplayer models a card, instead of waiting for
  // the canonical seed to catch up. Stubs are satellites (canonical rows win
  // ties; the mop-up absorbs them when the real seed arrives). Variant labels
  // ride in brackets, house convention. TCGCSV_CREATE_STUBS=0 disables.
  const insStub = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, language, image, image_kind, released_at, external_ids)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, 'tcgplayer', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, set_name = excluded.set_name, number = excluded.number`);
  const stripGroupCode = (g) => (g ?? '').replace(/^[A-Za-z0-9.]{1,8}:\s*/, '').trim();
  const bracketed = (p) => p.label
    ? `${p.name} [${p.label.replace(/\b[a-z]/g, (c) => c.toUpperCase())}]`
    : p.name;
  // THE SEALED BUCKET (Kaleb, 2026-07-22): boxes/ETBs/decks land in the
  // separate `products` shelf with daily price history — on hand, in house,
  // never mixed into card comps, unsurfaced until wanted. TCGCSV_SEALED=0 off.
  const insProduct = db.prepare(
    `INSERT INTO products (id, ip, name, set_name, language, kind, image, released_at, external_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, set_name = excluded.set_name, kind = excluded.kind`);
  const insProductPrice = db.prepare(
    `INSERT OR REPLACE INTO product_prices (product_id, subtype, as_of, market_cents, low_cents, mid_cents, high_cents, direct_low_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const summary = {};
  for (const key of ips) {
    const catId = CATEGORY_IDS[key];
    const target = TARGETS[key];
    if (!catId || !target) continue;
    const ip = target.ip;
    let cards = db.prepare(`SELECT id, name, number, set_name, language FROM cards WHERE ip = ?`).all(ip);
    if (target.langs) {
      const want = new Set(target.langs.map(l => l ?? 'English'));
      cards = cards.filter(c => want.has(c.language ?? 'English'));
    }
    const groups = (await fetchTcgcsv(`/${catId}/groups`, { fetchImpl })).slice(0, maxGroups);
    let products = 0, matched = 0, marks = 0, artFilled = 0, stubs = 0, sealed = 0, unmatchedSample = [];
    for (const g of groups) {
      let mapped, sealedRows = [];
      try {
        const [ps, prs] = [
          await fetchTcgcsv(`/${catId}/${g.groupId}/products`, { fetchImpl }),
          await fetchTcgcsv(`/${catId}/${g.groupId}/prices`, { fetchImpl }),
        ];
        mapped = mapGroupProducts(ps, prs, g);
        if (sealedBucket) sealedRows = mapGroupSealed(ps, prs, g);
      } catch (e) {
        console.warn(`[tcgcsv] ${ip} ${g.name}: ${e.message} — skipping group`);
        continue;
      }
      const { hits, misses } = matchProducts(mapped, cards, ip);
      products += mapped.length;
      if (unmatchedSample.length < 8) unmatchedSample.push(...misses.slice(0, 8 - unmatchedSample.length).map(m => `${m.name} ${m.number} (${m.group_name})`));
      db.exec('BEGIN');
      for (const p of sealedRows) {
        const pid = `${ip.toLowerCase()}-tp${p.product_id}`;
        insProduct.run(pid, ip, p.name, stripGroupCode(p.group_name),
          target.langs?.includes('Japanese') ? 'Japanese' : 'English',
          p.kind, p.image_url, p.group_published, JSON.stringify({ tcgplayer: String(p.product_id) }));
        for (const [subtype, r] of Object.entries(p.prices)) {
          insProductPrice.run(pid, subtype, asOf, r.market_cents, r.low_cents, r.mid_cents, r.high_cents, r.direct_low_cents);
        }
        sealed++;
      }
      if (createStubs) {
        for (const p of misses) {
          const stubId = `${ip.toLowerCase()}-tp${p.product_id}`;
          insStub.run(stubId, ip, bracketed(p), stripGroupCode(p.group_name), p.number,
            target.langs?.includes('Japanese') ? 'Japanese' : 'English',
            p.image_url ?? null, p.group_published ?? null,
            JSON.stringify({ tcgplayer: String(p.product_id) }));
          for (const [subtype, r] of Object.entries(p.prices)) {
            insPrice.run(stubId, subtype, asOf, r.market_cents, r.low_cents, r.mid_cents, r.high_cents, r.direct_low_cents, p.product_id, p.url);
          }
          const mp = markPrice(p, bracketed(p));
          if (mp != null) { insMark.run(stubId, asOf, mp); marks++; }
          stubs++;
        }
      }
      for (const { product, card } of hits) {
        for (const [subtype, r] of Object.entries(product.prices)) {
          insPrice.run(card.id, subtype, asOf, r.market_cents, r.low_cents, r.mid_cents, r.high_cents, r.direct_low_cents, product.product_id, product.url);
        }
        const mp = markPrice(product, card.name);
        if (mp != null) { insMark.run(card.id, asOf, mp); marks++; }
        attach.run(String(product.product_id), card.id);
        if (product.image_url && cardLabel(card.name) === product.label) {
          artFilled += fillArt.run(product.image_url, card.id).changes;
        }
        if (product.group_published) fillReleased.run(product.group_published, card.id);
        matched++;
      }
      db.exec('COMMIT');
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    summary[key] = { groups: groups.length, products, matched, unmatched: products - matched, stubs, sealed, marks, artFilled };
    console.log(`[tcgcsv] ${key}:`, JSON.stringify(summary[key]));
    if (unmatchedSample.length) console.log(`[tcgcsv] ${key} unmatched sample: ${unmatchedSample.join(' · ')}`);
  }
  return summary;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ipArg = process.argv.find(a => a.startsWith('--ip='))?.slice(5);
  const db = openDb();
  const asOf = new Date().toISOString().slice(0, 10);
  const res = await importTcgcsv(db, {
    ips: ipArg && ipArg !== 'ALL' ? [ipArg] : undefined, asOf,
    delayMs: Number(process.env.TCGCSV_DELAY_MS ?? 120),
    maxGroups: Number(process.env.TCGCSV_MAX_GROUPS ?? Infinity),
  });
  console.log('[tcgcsv] refreshing oracle for', asOf, '…');
  console.log('[tcgcsv]', JSON.stringify(refreshOracle(db, [asOf])));
  console.log('[tcgcsv] done:', JSON.stringify(res));
}
