/**
 * DIAG (read-only): per-set completeness report card — our spine vs
 * collect.rip's checklists (Kaleb, 2026-07-22: "use it in tandem for cross
 * referencing our database"; the spine mandate: "strong and complete").
 *
 * Their API (mapped from the app bundle, live 2026-07-22):
 *   GET api.collect.rip/all-sets        → 384 sets {id, name, count, release_date, image_tcgplayer_id, game_id}
 *   GET api.collect.rip/cards/<setId>   → the checklist (tcgplayer-id keyed)
 * '-pokemon-japan' ids are the Japanese sets. This diag:
 *   1. count-audit EVERY set (1 API call): their count vs our row count per
 *      aliased set → the report card;
 *   2. itemize the WORST offenders (few calls, throttled): which numbers we
 *      are missing, and whether a tcgplayer-id join would rescue them.
 * Run BEFORE tonight's spine-rule ingest = baseline; re-run after = proof.
 *
 *   node server/diag-set-completeness.js [--detail=8]
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const API = 'https://api.collect.rip';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJson = async (path) => {
  const r = await timedFetch(`${API}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json', origin: 'https://collect.rip', referer: 'https://collect.rip/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
};

const norm = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/^[a-z0-9.]{1,8}:\s*/, '')                       // 'M5: Abyss Eye' → 'abyss eye'
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\band\b/g, ' ')                                 // 'Black and White' ≡ 'Black & White' (live miss, 2026-07-22)
  .replace(/\s+/g, ' ').trim();
const ourKey = (s) => norm((s ?? '').replace(/^pokemon (japanese |chinese |korean )?/i, ''));

const db = openDb();
const detail = Number(process.argv.find(a => a.startsWith('--detail='))?.slice(9) ?? 8);

// Our side: PKMN rows grouped by (language-bucket, set-key).
const ours = { en: new Map(), jp: new Map() };
for (const c of db.prepare(`SELECT name, number, set_name, language FROM cards WHERE ip = 'PKMN'`).all()) {
  const bucket = c.language === 'Japanese' ? 'jp' : 'en';
  const k = ourKey(c.set_name);
  if (!k) continue;
  (ours[bucket].get(k) ?? ours[bucket].set(k, []).get(k)).push(c);
}

const sets = await getJson('/all-sets');
console.log(`[completeness] their sets: ${sets.length} · our PKMN set-keys: EN ${ours.en.size} · JP ${ours.jp.size}`);

const rows = [];
for (const s of sets) {
  if (s.game_id !== 'pokemon') continue;
  const jp = /-pokemon-japan$/.test(s.id);
  const bucket = jp ? 'jp' : 'en';
  const want = norm(s.name);
  const keys = [...ours[bucket].keys()];
  const key = keys.find(k => k === want) ?? keys.find(k => k.includes(want) || want.includes(k));
  const have = key ? ours[bucket].get(key).length : 0;
  rows.push({ id: s.id, name: s.name, jp, theirCount: s.count ?? 0, have, key: key ?? null });
}
const unknown = rows.filter(r => !r.key);
const short = rows.filter(r => r.key && r.have < r.theirCount).sort((a, b) => (b.theirCount - b.have) - (a.theirCount - a.have));
const okOrOver = rows.filter(r => r.key && r.have >= r.theirCount);
console.log(`\n== REPORT CARD == aligned-or-over: ${okOrOver.length} · SHORT: ${short.length} · sets we don't recognize AT ALL: ${unknown.length}`);
const missingTotal = short.reduce((a, r) => a + (r.theirCount - r.have), 0) + unknown.reduce((a, r) => a + r.theirCount, 0);
console.log(`   missing cards implied: ~${missingTotal.toLocaleString()} (short sets ${short.reduce((a, r) => a + r.theirCount - r.have, 0).toLocaleString()} + unknown sets ${unknown.reduce((a, r) => a + r.theirCount, 0).toLocaleString()})`);

// The other direction (Kaleb, 2026-07-23: "make sure we have the correct
// number AND no duplicates"): sets where we hold MORE than the reference.
// Bracketed variants legitimately exceed a base checklist, so the overage
// compare uses our UNBRACKETED rows only.
console.log('\n== OVERAGES (more unbracketed rows than their count — duplicate fingerprints) ==');
const over = rows.filter(r => r.key).map(r => {
  const pool = ours[r.jp ? 'jp' : 'en'].get(r.key) ?? [];
  const base = pool.filter(c => !/\[/.test(c.name ?? '')).length;
  return { ...r, base, overBy: base - r.theirCount };
}).filter(r => r.overBy > 0).sort((a, b) => b.overBy - a.overBy);
for (const r of over.slice(0, 15)) console.log(`  +${String(r.overBy).padStart(4)} over  ${r.jp ? 'JP' : 'EN'}  ${r.name} (${r.theirCount} expected, ${r.base} unbracketed rows)`);
if (!over.length) console.log('  none — no set holds more base rows than the reference expects.');

// Internal dupe census — needs no external reference at all: multiple
// UNBRACKETED rows sharing (set, number, name) are the canonical+satellite
// pairs the mop-up exists to absorb. Zero here = the lookup page is clean.
console.log('\n== INTERNAL DUPLICATE SUSPECTS (same set + number + name, >1 unbracketed row) ==');
let dupeGroups = 0, dupeRows = 0;
const dupeSamples = [];
for (const bucket of ['en', 'jp']) {
  for (const [setKey, pool] of ours[bucket]) {
    const groups = new Map();
    for (const c of pool) {
      if (/\[/.test(c.name ?? '')) continue;
      const num = String(c.number ?? '').toUpperCase().split('/')[0].replace(/^0+(?=\w)/, '');
      if (!num) continue;
      const k = `${num}|${(c.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      (groups.get(k) ?? groups.set(k, []).get(k)).push(c);
    }
    for (const [, g] of groups) {
      if (g.length > 1) {
        dupeGroups++; dupeRows += g.length - 1;
        if (dupeSamples.length < 12) dupeSamples.push(`${g[0].name} — ${g.map(c => c.set_name).join(' vs ')} (${bucket.toUpperCase()} ${setKey})`);
      }
    }
  }
}
console.log(`  groups: ${dupeGroups} · surplus rows: ${dupeRows}${dupeGroups ? '' : ' — CLEAN'}`);
for (const s of dupeSamples) console.log(`    ${s}`);

console.log('\n== WORST SHORTFALLS (their count vs ours) ==');
for (const r of short.slice(0, 25)) console.log(`  ${String(r.theirCount - r.have).padStart(5)} short  ${r.jp ? 'JP' : 'EN'}  ${r.name} (${r.theirCount} vs ${r.have})  → matched '${r.key}'`);
console.log('\n== SETS UNKNOWN TO US (no set-key match at all) ==');
for (const r of unknown.slice(0, 20)) console.log(`  ${String(r.theirCount).padStart(4)} cards  ${r.jp ? 'JP' : 'EN'}  ${r.name} (${r.id})`);

// Itemize the worst few: what exactly is missing, and can tcgplayer ids rescue?
const tpAttached = new Set(db.prepare(
  `SELECT json_extract(external_ids, '$.tcgplayer') tp FROM cards WHERE json_extract(external_ids, '$.tcgplayer') IS NOT NULL`).all().map(r => String(r.tp)));
console.log(`\n== ITEMIZED (worst ${detail}; our tcgplayer-attached ids: ${tpAttached.size}) ==`);
let shapePrinted = false;
for (const r of [...short, ...unknown].slice(0, detail)) {
  await sleep(650);
  try {
    const j = await getJson(`/cards/${r.id}`);
    const cards = Array.isArray(j) ? j : j.cards ?? j.data ?? [];
    if (!shapePrinted && cards[0]) { console.log(`  [card shape] keys: ${Object.keys(cards[0]).join(', ')}`); console.log(`  [card shape] first: ${JSON.stringify(cards[0]).slice(0, 240)}`); shapePrinted = true; }
    const pool = r.key ? ours[r.jp ? 'jp' : 'en'].get(r.key) : [];
    const ourNums = new Set((pool ?? []).map(c => String(c.number ?? '').toUpperCase().split('/')[0].replace(/^0+(?=\w)/, '')));
    const missing = [];
    let tpRescuable = 0, products = 0;
    for (const c of cards) {
      const rawNum = String(c.number ?? c.card_number ?? '').trim();
      // number 'N/A'/empty = sealed product or accessory — their checklists
      // include boxes/ETBs/code cards; our spine is a SINGLES database.
      // Graded separately, never counted as a missing card (live 2026-07-22:
      // virtually every 'missing' entry was a booster box).
      if (!rawNum || /^n\/?a$/i.test(rawNum)) { products++; continue; }
      const num = rawNum.toUpperCase().split('/')[0].replace(/^0+(?=\w)/, '');
      const tp = String(c.image_tcgplayer_id ?? c.tcgplayer_id ?? c.tcgplayerId ?? '');
      const known = (num && ourNums.has(num)) || (tp && tpAttached.has(tp));
      if (!known) { missing.push(`${c.name ?? '?'} #${rawNum}`); if (tp) tpRescuable++; }
    }
    console.log(`  ${r.name} (${r.jp ? 'JP' : 'EN'}): ${missing.length} SINGLES missing of ${cards.length - products} (+${products} sealed/products, out of scope) · ${tpRescuable} w/ tcgplayer id · e.g. ${missing.slice(0, 5).join(' · ') || '(none — fully covered)'}`);
  } catch (e) { console.log(`  ${r.name}: /cards/${r.id} → ${e.message}`); }
}
console.log('\n[completeness] read-only. The importer that follows: seed missing checklist entries as identity rows (tcgplayer-id keyed where present).');
