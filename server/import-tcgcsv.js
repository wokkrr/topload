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
import { CATEGORY_IDS, fetchTcgcsv, mapGroupProducts, normName } from './adapters/tcgcsv.js';

const cardLabel = (name) => (/\[([^\]]+)\]/.exec(name ?? '')?.[1] ?? '').toLowerCase().trim();
const isSatellite = (id) => /-pc\d+$/.test(id);

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
        const cs = normName(c.set_name);
        return cs === gs || cs.includes(gs) || gs.includes(cs);
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

export async function importTcgcsv(db, { ips = ['YGO', 'PKMN', 'OP'], asOf, delayMs = 120, maxGroups = Infinity, fetchImpl } = {}) {
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
  // IS the exact printing — clean scans, correct variant. Fills ONLY artless
  // cards, and ONLY when the variant label matches EXACTLY (a loosely-matched
  // mark is fine; a loosely-matched IMAGE is visibly wrong art).
  const fillArt = db.prepare(
    `UPDATE cards SET image = ?, image_kind = 'tcgplayer' WHERE id = ? AND image IS NULL`);

  const summary = {};
  for (const ip of ips) {
    const catId = CATEGORY_IDS[ip];
    if (!catId) continue;
    const cards = db.prepare(`SELECT id, name, number, set_name, language FROM cards WHERE ip = ?`).all(ip);
    const groups = (await fetchTcgcsv(`/${catId}/groups`, { fetchImpl })).slice(0, maxGroups);
    let products = 0, matched = 0, marks = 0, artFilled = 0, unmatchedSample = [];
    for (const g of groups) {
      let mapped;
      try {
        const [ps, prs] = [
          await fetchTcgcsv(`/${catId}/${g.groupId}/products`, { fetchImpl }),
          await fetchTcgcsv(`/${catId}/${g.groupId}/prices`, { fetchImpl }),
        ];
        mapped = mapGroupProducts(ps, prs, g);
      } catch (e) {
        console.warn(`[tcgcsv] ${ip} ${g.name}: ${e.message} — skipping group`);
        continue;
      }
      const { hits, misses } = matchProducts(mapped, cards, ip);
      products += mapped.length;
      if (unmatchedSample.length < 8) unmatchedSample.push(...misses.slice(0, 8 - unmatchedSample.length).map(m => `${m.name} ${m.number} (${m.group_name})`));
      db.exec('BEGIN');
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
        matched++;
      }
      db.exec('COMMIT');
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    summary[ip] = { groups: groups.length, products, matched, unmatched: products - matched, marks, artFilled };
    console.log(`[tcgcsv] ${ip}:`, JSON.stringify(summary[ip]));
    if (unmatchedSample.length) console.log(`[tcgcsv] ${ip} unmatched sample: ${unmatchedSample.join(' · ')}`);
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
