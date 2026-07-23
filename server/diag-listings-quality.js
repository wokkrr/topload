/**
 * LISTINGS QUALITY AUDIT (Kaleb, 2026-07-23: "look through the listings…
 * make sure they all are populating correctly. Correct listing images,
 * proper filters, buy buttons that are instant buys — so we know everything
 * is ready for the frictionless buy flow.")
 *
 * Sections:
 *   A. INVENTORY        — per-platform counts, match rate, freshness, price sanity
 *   B. BUY-BUTTON TRUTH — every row must be able to route (mirrors
 *                         listingUrl's exact preconditions); inquiry leakage
 *                         must be ZERO; dead-end Buy Now = doctrine violation
 *   C. FILTER INTEGRITY — rows invisible to franchise/grader/language
 *                         filters (NULL ip, unnormalized grades)
 *   D. IMAGES           — real photo vs art-fallback vs nothing; live-URL
 *                         spot check (4 per platform, HEAD requests)
 *   E. MIRRORS          — same mint/cert live on multiple venues (dedupe +
 *                         host-routing substrate for the buy flow)
 *
 * Read-only + a handful of sampled image fetches.
 * Run:  node server/diag-listings-quality.js
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const db = openDb();
const all = db.prepare(`
  SELECT g.platform, g.external_id, g.card_id, g.item_name, g.category, g.grade, g.price_cents,
         g.listed_at, g.seen_at, g.image, g.image_back, g.nft_address, g.proof, g.cert, g.fmv_usd,
         g.listing_type, g.product_id, c.ip AS card_ip, c.language
  FROM gacha_listings g LEFT JOIN cards c ON c.id = g.card_id`).all();

const plats = [...new Set(all.map(l => l.platform))].sort();
const by = (p) => all.filter(l => l.platform === p);
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—';

/** listingUrl preconditions, mirrored exactly from src/ui/tables.jsx. */
const canRoute = (l) =>
  (l.platform === 'collectorcrypt' && !!l.nft_address) ||
  (l.platform === 'courtyard' && !!l.proof) ||
  (l.platform === 'mnstr' && !!l.proof) ||
  (l.platform === 'phygitals' && !!l.proof) ||
  (l.platform === 'beezie' && !!l.proof && l.proof.includes(':'));

const GRADE_OK = /^(?:raw|G9\.5|(?:PSA|BGS|CGC|TAG|SGC|AGS|ACE)(?:\d{1,2}(?:\.5)?|Auth))$/;

console.log(`== LISTINGS QUALITY AUDIT · ${all.length} live rows · ${plats.length} platforms ==\n`);

console.log('A. INVENTORY');
for (const p of plats) {
  const L = by(p);
  const matched = L.filter(l => l.card_id).length;
  const newest = L.map(l => l.seen_at ?? '').sort().at(-1)?.slice(0, 10);
  const zero = L.filter(l => !l.price_cents || l.price_cents <= 0).length;
  const whale = L.filter(l => l.price_cents > 25_000_000).length;
  console.log(`  ${p.padEnd(15)} ${String(L.length).padStart(6)} rows · matched ${pct(matched, L.length).padStart(6)} · newest seen ${newest}`
    + (zero ? ` · ⚠ ${zero} zero-priced` : '') + (whale ? ` · ⚠ ${whale} >$250k` : ''));
}

console.log('\nB. BUY-BUTTON TRUTH (a Buy Now that cannot route or is not instant = broken promise)');
let routeFail = 0;
for (const p of plats) {
  const L = by(p);
  const cant = L.filter(l => !canRoute(l));
  routeFail += cant.length;
  if (cant.length) {
    console.log(`  ⚠ ${p}: ${cant.length} rows CANNOT build a buy link (missing ${p === 'collectorcrypt' ? 'nft_address' : 'proof/slug'})`);
    for (const c of cant.slice(0, 3)) console.log(`      e.g. ${c.external_id} "${(c.item_name ?? '').slice(0, 48)}"`);
  }
}
if (!routeFail) console.log('  ✓ every listing can build its marketplace buy link');
const inquiry = all.filter(l => l.listing_type === 'inquiry');
console.log(inquiry.length
  ? `  ⚠ INQUIRY LEAKAGE: ${inquiry.length} non-instant rows on the desk (should be 0): ${inquiry.slice(0, 3).map(l => l.external_id).join(', ')}`
  : '  ✓ zero inquiry/intake rows on the desk — every Buy Now is instant');
const intake = db.prepare(`SELECT COUNT(*) n, SUM(graduated_at IS NOT NULL) g FROM mnstr_intake_log`).get();
console.log(`  ℹ MNSTR intake monitor: ${intake.n} tracked · ${intake.g ?? 0} graduated to instant-buy so far`);

console.log('\nC. FILTER INTEGRITY (rows the filters cannot see)');
for (const p of plats) {
  const L = by(p);
  const noIp = L.filter(l => l.card_id && !l.card_ip).length;
  const orphanNoCat = L.filter(l => !l.card_id && !l.category).length;
  const oddGrades = [...new Set(L.map(l => l.grade ?? 'raw').filter(g => !GRADE_OK.test(g)))];
  const bits = [];
  if (noIp) bits.push(`${noIp} matched-but-no-franchise`);
  if (orphanNoCat) bits.push(`${orphanNoCat} unmatched-and-no-category (invisible to TCG filter)`);
  if (oddGrades.length) bits.push(`odd grades: ${oddGrades.slice(0, 6).join(', ')}`);
  console.log(`  ${bits.length ? '⚠' : '✓'} ${p.padEnd(15)}${bits.length ? bits.join(' · ') : 'clean'}`);
}
const jp = all.filter(l => l.language === 'Japanese').length;
console.log(`  ℹ language filter substrate: ${jp} listings on Japanese-tagged cards`);

console.log('\nD. IMAGES');
for (const p of plats) {
  const L = by(p);
  const own = L.filter(l => l.image).length;
  const artFallback = L.filter(l => !l.image && l.card_id).length;   // desk shows card art badged NOT ITEM
  const nothing = L.filter(l => !l.image && !l.card_id).length;
  console.log(`  ${p.padEnd(15)} own photo ${pct(own, L.length).padStart(6)} · art-fallback ${String(artFallback).padStart(5)} · no visual ${nothing}`);
}
console.log('  live-URL spot check (4/platform):');
for (const p of plats) {
  const sample = by(p).filter(l => l.image && /^https?:/.test(l.image)).slice(0, 4);
  let ok = 0, dead = [];
  for (const s of sample) {
    try {
      const r = await timedFetch(s.image, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) ok++; else dead.push(`${s.external_id}→HTTP${r.status}`);
    } catch { dead.push(`${s.external_id}→ERR`); }
  }
  const proxied = by(p).filter(l => l.image && !/^https?:/.test(l.image)).length;
  console.log(`    ${p.padEnd(15)} ${ok}/${sample.length} live${dead.length ? ` · dead: ${dead.join(' ')}` : ''}${proxied ? ` · ${proxied} via our proxy (not URL-checked)` : ''}`);
}

console.log('\nE. MIRRORS (cross-venue same-item — buy-flow routing substrate)');
const byMint = new Map();
for (const l of all) if (l.nft_address && !/^(?:base|flow):/.test(l.nft_address)) (byMint.get(l.nft_address) ?? byMint.set(l.nft_address, []).get(l.nft_address)).push(l);
const mirrors = [...byMint.values()].filter(g => new Set(g.map(x => x.platform)).size > 1);
console.log(`  ${mirrors.length} tokens live on 2+ venues (host-vs-mirror routing applies)`);
for (const g of mirrors.slice(0, 4)) {
  console.log(`    ${g[0].nft_address.slice(0, 10)}… → ${g.map(x => `${x.platform} $${(x.price_cents / 100).toFixed(0)}`).join(' · ')}`);
}
const byCert = new Map();
for (const l of all) if (l.cert) (byCert.get(l.cert) ?? byCert.set(l.cert, []).get(l.cert)).push(l);
const certDupes = [...byCert.values()].filter(g => new Set(g.map(x => x.platform)).size > 1);
console.log(`  ${certDupes.length} cert numbers live on 2+ venues (same slab, cross-listed)`);

console.log('\nDone. ⚠ lines are the pre-buy-flow worklist; ✓ means ready.');
