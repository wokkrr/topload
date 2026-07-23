/**
 * PC page-art layer — fill the artless VINTAGE/EXOTIC tail from PriceCharting
 * product pages (Kaleb, 2026-07-22: "we need to figure out how to get close
 * to 99% accurate card art for our pokemon catalog").
 *
 * Where it sits in the art stack: pokemontcg.io seeds cover canonical EN;
 * tcgcsv (cats 3 + 85) covers anything TCGplayer sells, incl. Pokemon Japan;
 * borrow-art covers same-artwork variant satellites. What's left is the
 * long vintage tail — Illustrator Pikachu, No Rarity, Masaki, vending — that
 * only PriceCharting models. We already license their data and every one of
 * these rows carries a PC id; their product page's og:image is their own
 * photo of the exact product.
 *
 * Deliberately gentle: value-sorted (highest-value artless first — coverage
 * where users actually look), hard --limit cap, ≥1.5s between fetches, one
 * page per product, honors a robots.txt Disallow on /game/ by refusing to
 * run (reported, not silently skipped).
 *
 * QUALITY TIER: BOTTOM (their images are product photos, quality varies —
 * Kaleb 2026-07-22: "some of the card art is very poor low quality"). This
 * layer only ever fills NULL; tcgplayer scans and borrowed official art
 * REPLACE 'pricecharting' images as their coverage grows — a PC photo is a
 * placeholder that heals into a scan, never a permanent fixture.
 *
 *   node server/seed-pc-page-art.js --probe          # 3 known ids: URL form + og:image shape + robots verdict
 *   node server/seed-pc-page-art.js --dry --limit=20 # resolve URLs, report, no fetch-writes
 *   node server/seed-pc-page-art.js --ip=PKMN --limit=500
 *
 * WRITER (guard token: see[d]-). Slug mapping needs the daily CSVs on disk
 * (data/imports) — same self-locating pattern as repair-variant-marks.
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';
import { extractChartData, storeChartHistory } from './pc-history.js';
import { latestCsvs } from './repair-variant-marks.js';
import { parseCsv } from './import-pricecharting-csv.js';

const WWW = 'https://www.pricecharting.com';

/** PC's URL slug: lowercase, '&'→'and', drop other punctuation, spaces→'-'. */
export const pcSlug = (s) => (s ?? '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[#[\]().,'’!/]/g, ' ')
  .replace(/[^a-z0-9 -]+/g, '').trim().replace(/\s+/g, '-');

export const pageUrl = (consoleName, productName) => `${WWW}/game/${pcSlug(consoleName)}/${pcSlug(productName)}`;

/** og:image out of a product page; PC's placeholder art counts as none. */
export function extractOgImage(html) {
  const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html ?? '')
    ?? /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html ?? '');
  const url = m?.[1] ?? null;
  if (!url || /no-image|placeholder|default/i.test(url)) return null;
  return url;
}

/**
 * PC serves product photos from a GCS bucket (images.pricecharting.com) and
 * does NOT set og:image (probe verdict, live 2026-07-22 — pages were 200 with
 * nothing to extract). Harvest every bucket URL in the page instead; first
 * match = the main product photo. A trailing /240.jpg thumbnail is upgraded
 * to the /1600.jpg original the site serves for the zoom view.
 */
export function extractCardImage(html) {
  const urls = [...String(html ?? '').matchAll(/https?:\/\/[^"'\s>]*images\.pricecharting\.com[^"'\s>]*\.(?:jpe?g|png|webp)/gi)]
    .map(m => m[0]).filter(u => !/no-image|placeholder|default/i.test(u));
  if (!urls.length) return extractOgImage(html);
  return urls[0].replace(/\/240\.(jpe?g|png|webp)$/i, '/1600.$1');
}

/** pc id → {console, product} name map from the freshest daily CSVs. */
export function pcNameMap() {
  const map = new Map();
  for (const { text } of latestCsvs()) {
    for (const row of parseCsv(text)) {
      map.set(String(row.id), { console: (row['console-name'] ?? '').trim(), product: (row['product-name'] ?? '').trim() });
    }
  }
  return map;
}

const pcIdOf = (card) => {
  try { const ext = JSON.parse(card.external_ids ?? '{}'); if (ext.pricecharting) return String(ext.pricecharting); } catch { /* fall through */ }
  return /-pc(\d+)$/.exec(card.id)?.[1] ?? null;
};

export async function fillPageArt(db, { ips = ['PKMN', 'OP'], limit = 500, delayMs = 1500, dry = false, fetchImpl = timedFetch, log = console.log } = {}) {
  // Robots first — refuse loudly rather than crawl where we're not wanted.
  const robots = await (await fetchImpl(`${WWW}/robots.txt`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const disallowed = robots.split('\n').some(l => /^disallow:\s*\/game\b/i.test(l.trim()));
  if (disallowed) { log('[pc-art] robots.txt disallows /game/ — refusing to fetch product pages. Art for this tail needs another source.'); return { refused: true }; }

  const names = pcNameMap();
  const rows = db.prepare(
    `SELECT c.id, c.ip, c.name, c.external_ids, v.v value_cents FROM cards c
     JOIN (SELECT card_id, MAX(price_cents) v FROM latest_marks GROUP BY card_id) v ON v.card_id = c.id
     WHERE c.image IS NULL AND c.ip IN (${ips.map(() => '?').join(',')})
     ORDER BY v.v DESC`).all(...ips);

  const res = { scanned: 0, noPcId: 0, noCsvRow: 0, filled: 0, noImage: 0, httpErr: 0, samples: [] };
  const upd = db.prepare(`UPDATE cards SET image = ?, image_kind = 'pricecharting' WHERE id = ? AND image IS NULL`);

  for (const card of rows) {
    if (res.scanned >= limit) break;
    const pc = pcIdOf(card);
    if (!pc) { res.noPcId++; continue; }
    const n = names.get(pc);
    if (!n) { res.noCsvRow++; continue; }
    res.scanned++;
    const url = pageUrl(n.console, n.product);
    if (dry) { if (res.samples.length < 15) res.samples.push(`$${Math.round((card.value_cents ?? 0) / 100)} ${card.id} → ${url}`); continue; }
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html' } });
      if (!r.ok) { res.httpErr++; }
      else {
        const html = await r.text();
        const img = extractCardImage(html);
        if (!img) res.noImage++;
        else {
          res.filled += Number(upd.run(img, card.id).changes);
          if (res.samples.length < 15) res.samples.push(`$${Math.round((card.value_cents ?? 0) / 100)} ${card.id} ← ${img.slice(0, 80)}`);
        }
        // PASSIVE HISTORY HARVEST (2026-07-23): the page is already in hand —
        // extract its embedded 5.5-year monthly chart_data at zero extra
        // request cost. See pc-history.js for posture + bucket mapping.
        const chart = extractChartData(html);
        if (chart) res.historyPoints = (res.historyPoints ?? 0) + storeChartHistory(db, card.id, chart);
      }
    } catch { res.httpErr++; }
    // Unattended-safety: if the first dozen pages yield nothing, the URL form
    // or og:image shape is off — stop rather than burn the whole cap on 404s.
    if (!dry && res.scanned >= 12 && res.filled === 0) {
      res.aborted = 'first 12 pages produced no art — URL/og shape needs the probe checked';
      break;
    }
    await new Promise(r2 => setTimeout(r2, delayMs));
  }
  return res;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  if (process.argv.includes('--probe')) {
    // Known ids across the shapes that matter (from the live worklist):
    // vintage JP promo (Illustrator), bracketed variant (No Rarity), OP satellite.
    const names = pcNameMap();
    const probes = ['6715185', '3491979', '10845694'].map(id => ({ id, n: names.get(id) }));
    const robots = await (await timedFetch(`${WWW}/robots.txt`)).text();
    console.log('[pc-art probe] robots.txt /game rules:', robots.split('\n').filter(l => /game|disallow/i.test(l)).slice(0, 10).join(' | ') || '(none mention /game)');
    for (const p of probes) {
      if (!p.n) { console.log(`[pc-art probe] ${p.id}: not in latest CSVs`); continue; }
      const url = pageUrl(p.n.console, p.n.product);
      try {
        const r = await timedFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html' } });
        const html = r.ok ? await r.text() : '';
        console.log(`[pc-art probe] ${p.id} "${p.n.product}" → HTTP ${r.status} · image ${extractCardImage(html) ?? '(none)'}`);
        // Show the raw image markup so extraction failures are diagnosable
        // from the log alone (og:image came back empty on the first live run).
        const tags = [...html.matchAll(/<img[^>]{0,300}>/gi)].map(m => m[0].slice(0, 160));
        for (const t of tags.slice(0, 4)) console.log(`    img: ${t}`);
        if (!tags.length) console.log('    (no <img> tags — image likely set via CSS/JS; first 2 image-ish lines below)',
          [...html.matchAll(/[^\n]{0,60}(?:image|photo)[^\n]{0,80}/gi)].slice(0, 2).map(m => m[0]).join(' | '));
      } catch (e) { console.log(`[pc-art probe] ${p.id} → ${e.message}`); }
      await new Promise(r2 => setTimeout(r2, 1500));
    }
    process.exit(0);
  }
  const db = openDb();
  const res = await fillPageArt(db, {
    ips: (arg('ip', 'PKMN,OP')).split(','),
    limit: Number(arg('limit', 500)),
    delayMs: Number(arg('delay', 1500)),
    dry: process.argv.includes('--dry'),
  });
  console.log(`[pc-art]${process.argv.includes('--dry') ? ' DRY RUN' : ''}`, JSON.stringify(res, null, 1));
}
