/**
 * PROBE (read-only): artofpkm.com — Kaleb found it 2026-07-22: "looks like it
 * has the card art for every single japanese pokemon card… may be able to be
 * pulled and matched with our japanese pokemon for higher quality card art."
 *
 * Verified via index page: complete VINTAGE JP coverage — PMCG base/gyms,
 * Expansion Sheets (the vending series), PMCG Promos, Neo, VS, Web, e-Card —
 * exactly the eras TCGplayer Japan (2005+) can't reach. Rails/ActiveStorage
 * app: images are SIGNED redirect URLs (not guessable, can rot) → the
 * importer that follows this probe must DOWNLOAD each image once into our
 * own store, never hotlink. It's a fan project: crawl gently (≥800ms), and
 * flag their about/credits for a possible courtesy note before a full pull.
 *
 * Reports: robots verdict · set index size · per-set card/image markup from
 * three vintage sets · our artless-JP demand list vs their set names.
 *
 *   node server/probe-artofpkm.js
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const HOST = 'https://www.artofpkm.com';
const DELAY = 800;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = async (path) => {
  const r = await timedFetch(`${HOST}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.text();
};

// 0. Robots — refuse loudly if they don't want crawlers.
const robots = await (await timedFetch(`${HOST}/robots.txt`)).text().catch(() => '');
const dis = robots.split('\n').filter(l => /^disallow:/i.test(l.trim()));
console.log(`[artofpkm] robots.txt disallows: ${dis.length ? dis.join(' | ') : '(nothing)'}`);
if (dis.some(l => /disallow:\s*\/(sets|cards|$)/i.test(l.trim()) && /disallow:\s*\/\s*$/i.test(l.trim()))) {
  console.log('[artofpkm] site-wide disallow — stop here and consider reaching out instead.');
  process.exit(0);
}

// 1. The set index.
const index = await get('/cards');
const sets = [...index.matchAll(/href="\/sets\/(\d+)"[^>]*>([^<]{0,80})/g)]
  .map(m => ({ id: m[1], name: m[2].trim() }));
const uniq = [...new Map(sets.map(s => [s.id, s])).values()];
console.log(`[artofpkm] set links on /cards: ${uniq.length}`);
for (const s of uniq.slice(0, 10)) console.log(`  /sets/${s.id} — ${s.name || '(name in markup elsewhere)'}`);

// 2. Three vintage sets: markup shapes for the importer.
for (const { id, label } of [
  { id: '5', label: 'PMCG Promos (Illustrator country)' },
  { id: '11', label: 'Expansion Sheet No.1 (vending)' },
  { id: '6', label: 'PMCG Base Set' },
]) {
  await sleep(DELAY);
  try {
    const html = await get(`/sets/${id}`);
    const imgs = [...html.matchAll(/\/rails\/active_storage\/[^"'\s]+/g)].map(m => m[0]);
    console.log(`\n== /sets/${id} (${label}) ==`);
    console.log(`  h1: ${(/<h1[^>]*>([^<]{0,90})/.exec(html)?.[1] ?? '?').trim()}`);
    console.log(`  active_storage URLs: ${imgs.length}`);
    // FULL image tags — the card↔image identity lives in alt/aria, not hrefs
    // (v1 probe found zero card links on vintage pages).
    const tags = [...html.matchAll(/<img[^>]{0,500}active_storage[^>]{0,500}>/g)].map(m => m[0]);
    for (const t of tags.slice(0, 3)) console.log(`  tag: ${t.slice(0, 320)}`);
    // Any inline JSON payload (Rails/Turbo apps often embed card data).
    const json = [...html.matchAll(/[^\n]{0,40}(?:data-[a-z-]*cards|"cards"|card_number|"number")[^\n]{0,120}/gi)].slice(0, 3);
    for (const j of json) console.log(`  json-ish: ${j[0].trim().slice(0, 150)}`);
    // The tail of two full image URLs (filenames were truncated in v1).
    for (const u of imgs.slice(0, 2)) console.log(`  url-tail: …${u.slice(-90)}`);
  } catch (e) { console.log(`\n== /sets/${id} (${label}) == ${e.message}`); }
}

// 3. Our demand: artless+priced JP PKMN by PC set name — the alias-map worklist.
const db = openDb();
const rows = db.prepare(
  `SELECT c.set_name, COUNT(*) n, SUM(v.v) value_cents
   FROM cards c JOIN (SELECT card_id, MAX(price_cents) v FROM latest_marks GROUP BY card_id) v ON v.card_id = c.id
   WHERE c.ip = 'PKMN' AND c.language = 'Japanese'
     AND (c.image IS NULL OR c.image_kind = 'pricecharting')
   GROUP BY c.set_name ORDER BY value_cents DESC LIMIT 20`).all();
console.log('\n== OUR ARTLESS-OR-PHOTO-ONLY JAPANESE PKMN, BY PC SET NAME (alias worklist) ==');
for (const r of rows) console.log(`$${String(Math.round((r.value_cents ?? 0) / 100)).padStart(9)}  ${String(r.n).padStart(5)} cards  ${r.set_name ?? '(no set)'}`);
console.log('\n[artofpkm] probe done — read-only. Importer design: crawl set pages → download images ONCE into data/jpart/ → serve statically; match by set alias + card number from their filenames.');
