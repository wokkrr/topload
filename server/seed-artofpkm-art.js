/**
 * Vintage Japanese art importer — artofpkm.com (found by Kaleb, 2026-07-22:
 * "card art for every single japanese pokemon card… pulled and matched with
 * our japanese pokemon for higher quality card art").
 *
 * Covers the eras nothing else reaches: PMCG base/gyms, the vending
 * Expansion Sheets, PMCG/era promos, Neo, VS, Web, e-Card. Probe verdicts
 * (2026-07-22): robots allows (only /admin,/users blocked); 419 sets; card
 * grids are IMAGES ONLY — identity lives in the filename slug
 * ('bulbasaur1.png', '1stp002.png') and, for nameless files, behind each
 * card's detail link. Card images wear class="card-cut" (set logos don't).
 *
 * Design rules:
 *  - DOWNLOAD ONCE into data/jpart/, serve from OUR disk (/jpart/…): their
 *    ActiveStorage URLs are signed and can rot, and a fan site should never
 *    carry our traffic. One gentle pass (≥700ms between fetches), then done.
 *  - Match conservatively: within an ALIASED set only, by card-name token
 *    identity; same-art bracket variants all receive the image; ambiguity
 *    (two different Pikachu promos) = skip, honest. Wrong art on a $200k
 *    card is worse than a bad photo of the right one (Kaleb doctrine).
 *  - Quality tier 'artofpkm': proper scans of the exact JP printing —
 *    replaces NULL, 'pricecharting' photos, and 'borrowed' EN-sibling art;
 *    never touches official/variant/tcgplayer.
 *
 *   node server/seed-artofpkm-art.js --dry            # crawl + match report, no downloads/writes
 *   node server/seed-artofpkm-art.js --sets=5,6,11    # specific sets
 *   node server/seed-artofpkm-art.js --deep           # follow detail links for nameless files (promos)
 *   node server/seed-artofpkm-art.js --seed-missing   # SPINE RULE: unknown printings in aliased sets
 *                                                     # become unpriced identity rows (pkmn-apk-*)
 *
 * WRITER (guard token: see[d]-). Resumable: cards already wearing
 * image_kind='artofpkm' are skipped; images already in data/jpart are not
 * re-downloaded.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = 'https://www.artofpkm.com';
const JPART_DIR = join(__dirname, '..', 'data', 'jpart');
const DELAY = Number(process.env.ARTOFPKM_DELAY_MS ?? 700);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Sorted-token name key: order-insensitive ('Pikachu Illustrator' ≡ 'Illustrator Pikachu'). */
export const tokenKey = (s) => (s ?? '').toLowerCase()
  .replace(/\[[^\]]*\]/g, ' ')                    // bracket labels are variant info, not identity
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');

/** 'bulbasaur1.png' → {name:'bulbasaur', num:'1'} · '1stp002.png' → {name:null, num:'002'} (nameless). */
export function parseSlug(filename) {
  const base = decodeURIComponent(filename ?? '').replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase();
  // modern shape: setcode_number_rand8
  let m = /^([a-z0-9-]+)_(\d{1,4})_[a-z0-9]{6,10}$/.exec(base);
  if (m) return { name: null, num: m[2].replace(/^0+(?=\d)/, '') };
  // vintage shape: nameslug + optional trailing digits
  m = /^([a-z][a-z-]*?)[-_]?(\d{0,4})$/.exec(base);
  if (!m) return { name: null, num: null };
  const name = m[1].replace(/-/g, '');
  // pure code-ish stems ('1stp', 'sheet') have no name value
  if (/^(sheet|set|logo|promo|unnumberedpromo|card|back)$/.test(name) || name.length < 3) return { name: null, num: m[2] || null };
  return { name, num: m[2] || null };
}

/** Squashed-name key for slug comparison ('Mr. Mime' → 'mrmime'). */
export const squashName = (s) => (s ?? '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]/g, '');

/**
 * Alias their set h1 → our PC-side set-name fragment. Auto: normalized
 * equality/containment after stripping the franchise prefix. Curated
 * overrides for the known divergences (community translations vs PC names).
 */
const OVERRIDES = new Map(Object.entries({
  'base set': 'expansion pack',
  'expansion sheet no 1 blue version': 'vending',
  'expansion sheet no 2 red version': 'vending',
  'expansion sheet no 3 green version': 'vending',
  'pmcg promos': 'promo',
  'neo promotional cards': 'promo',
  'e promotional cards': 'promo',
  'rocket gang': 'team rocket',
  'the secret of the fossil': 'fossil',
  'pokemon jungle': 'jungle',
  'pokemon card vs': 'vs',
  'pokemon card web': 'web',
  'base expansion pack': 'expedition expansion pack',
}));
export function aliasFor(theirH1, ourSetKeys) {
  const norm = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(theirH1);
  const o = OVERRIDES.get(t);
  const want = o ?? t;
  if (!want) return null;
  // exact → containment either way (PC truncates; their names add subtitles)
  const hit = ourSetKeys.find(k => k === want)
    ?? ourSetKeys.find(k => k.includes(want) || want.includes(k));
  return hit ?? null;
}

const ourSetKey = (s) => (s ?? '').toLowerCase().replace(/^pokemon (japanese |chinese |korean )?/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Extract per-card {href, img, filename} blocks from a set page (card-cut imgs only). */
export function parseSetPage(html) {
  const out = [];
  for (const chunk of String(html ?? '').split('<a ').slice(1)) {
    if (!chunk.includes('card-cut')) continue;
    const href = /^[^>]*href="([^"]+)"/.exec(chunk)?.[1] ?? null;
    const img = /src="(\/rails\/active_storage\/[^"]+)"/.exec(chunk)?.[1]
      ?? /src="(https?:\/\/[^"]*\/rails\/active_storage\/[^"]+)"/.exec(chunk)?.[1] ?? null;
    if (!img) continue;
    const filename = decodeURIComponent(img.split('/').pop() ?? '');
    out.push({ href, img: img.startsWith('http') ? img : `${HOST}${img}`, filename });
  }
  const h1 = (/<h1[^>]*>([^<]{0,120})/.exec(html)?.[1] ?? '').trim();
  return { h1, cards: out };
}

async function fetchText(url) {
  const r = await timedFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

export async function importArtofpkm(db, { sets = null, dry = false, deep = false, seedMissing = false, limit = Infinity, fetchImpl = fetchText, log = console.log } = {}) {
  mkdirSync(JPART_DIR, { recursive: true });
  // Candidates: JP PKMN rows whose art this tier may improve.
  const cands = db.prepare(
    `SELECT id, name, number, set_name FROM cards
     WHERE ip = 'PKMN' AND language = 'Japanese'
       AND (image IS NULL OR image_kind IN ('pricecharting', 'borrowed'))`).all();
  const bySet = new Map();
  for (const c of cands) {
    const k = ourSetKey(c.set_name);
    (bySet.get(k) ?? bySet.set(k, []).get(k)).push(c);
  }
  // Alias + set-name context comes from the WHOLE JP catalog (arted rows
  // included) — a fully-illustrated set must still alias so --seed-missing
  // can add the printings it lacks.
  const allJp = db.prepare(`SELECT name, set_name FROM cards WHERE ip = 'PKMN' AND language = 'Japanese'`).all();
  const setNameByKey = new Map();
  const namesByKey = new Map();
  for (const c of allJp) {
    const k = ourSetKey(c.set_name);
    if (k && !setNameByKey.has(k)) setNameByKey.set(k, c.set_name);
    if (k) (namesByKey.get(k) ?? namesByKey.set(k, new Set()).get(k)).add(squashName(c.name));
  }
  const ourSetKeys = [...setNameByKey.keys()];
  const upd = db.prepare(
    `UPDATE cards SET image = ?, image_kind = 'artofpkm'
     WHERE id = ? AND (image IS NULL OR image_kind IN ('pricecharting', 'borrowed'))`);
  // THE SPINE RULE (Kaleb, 2026-07-22: "full scope complete card database…
  // can't have a broken spine"): an image in an aliased set that matches NO
  // row — not even an arted one — is a card our catalog doesn't know exists.
  // --seed-missing turns it into an unpriced identity row (name, set, number,
  // clean art, artofpkm provenance) instead of a dead end.
  const insSeed = db.prepare(
    `INSERT INTO cards (id, ip, name, set_name, number, variant, language, image, image_kind, external_ids)
     VALUES (?, 'PKMN', ?, ?, ?, '', 'Japanese', ?, 'artofpkm', ?)
     ON CONFLICT(id) DO NOTHING`);

  // Set list: explicit --sets or the full index.
  let setIds = sets;
  if (!setIds) {
    const index = await fetchImpl(`${HOST}/cards`);
    setIds = [...new Set([...index.matchAll(/href="\/sets\/(\d+)"/g)].map(m => m[1]))];
    await sleep(DELAY);
  }

  const res = { setsVisited: 0, setsAliased: 0, imagesSeen: 0, matched: 0, applied: 0, downloaded: 0,
                nameless: 0, ambiguous: 0, unmatchedName: 0, knownElsewhere: 0, deepFetched: 0,
                seedable: 0, seeded: 0, samples: [], seedSamples: [], unaliased: [] };

  for (const sid of setIds) {
    if (res.applied >= limit) break;
    let page;
    try { page = parseSetPage(await fetchImpl(`${HOST}/sets/${sid}`)); }
    catch (e) { log(`[artofpkm] /sets/${sid}: ${e.message} — skipping`); continue; }
    await sleep(DELAY);
    res.setsVisited++;
    const alias = aliasFor(page.h1, ourSetKeys);
    if (!alias) { if (res.unaliased.length < 25) res.unaliased.push(`${sid}:${page.h1}`); continue; }
    res.setsAliased++;
    const pool = bySet.get(alias) ?? [];
    // A fully-arted set has no upgrade pool but may still hide printings we
    // don't know exist — seed-missing walks it anyway.
    if (!pool.length && !seedMissing) continue;

    for (const card of page.cards) {
      if (res.applied >= limit) break;
      res.imagesSeen++;
      const slug = parseSlug(card.filename);
      let name = slug.name;
      let displayName = name ? name[0].toUpperCase() + name.slice(1) : null;
      // Nameless file (promos): the detail page carries the name — deep mode only.
      if (!name && deep && card.href) {
        try {
          const detail = await fetchImpl(card.href.startsWith('http') ? card.href : `${HOST}${card.href}`);
          res.deepFetched++;
          const h1 = (/<h1[^>]*>([^<]{0,120})/.exec(detail)?.[1] ?? '').trim()
            || (/<title>([^<|]{0,120})/.exec(detail)?.[1] ?? '').trim();
          if (h1) { displayName = h1; name = squashName(h1); }
        } catch { /* stays nameless */ }
        await sleep(DELAY);
      }
      if (!name) { res.nameless++; continue; }

      // All same-art variants of this name in the aliased set get the image.
      const hitsByName = pool.filter(c => squashName(c.name) === name || tokenKey(c.name) === tokenKey(name));
      if (!hitsByName.length) {
        // Not in the upgradeable pool. Known elsewhere in the set (already
        // wearing better art) → nothing to do. UNKNOWN to the whole catalog →
        // this printing doesn't exist in our database: seed the identity.
        if (namesByKey.get(alias)?.has(name)) { res.knownElsewhere++; continue; }
        if (!seedMissing || !displayName) { res.unmatchedName++; continue; }
        res.seedable++;
        const file = `${sid}_${card.filename.replace(/[^a-zA-Z0-9._-]/g, '')}`;
        if (res.seedSamples.length < 10) res.seedSamples.push(`${displayName} · ${page.h1} (${card.filename})`);
        if (dry) continue;
        try {
          const path = join(JPART_DIR, file);
          if (!existsSync(path)) {
            const r = await timedFetch(card.img, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!r.ok) continue;
            writeFileSync(path, Buffer.from(await r.arrayBuffer()));
            res.downloaded++;
            await sleep(DELAY);
          }
          const id = `pkmn-apk-${sid}-${name}${slug.num ? `-${slug.num}` : ''}`.slice(0, 64);
          const made = insSeed.run(id, displayName, setNameByKey.get(alias), slug.num ?? null,
            `/jpart/${file}`, JSON.stringify({ artofpkm: `${sid}/${card.filename}` })).changes;
          res.seeded += Number(made);
        } catch { /* next card */ }
        continue;
      }
      // Distinct IDENTITIES (beyond bracket variants) sharing a name = ambiguous.
      const distinctNums = new Set(hitsByName.map(c => (c.number ?? '').toString()));
      if (distinctNums.size > 3) { res.ambiguous++; continue; }   // e.g. six different Pikachu promos

      res.matched++;
      const file = `${sid}_${card.filename.replace(/[^a-zA-Z0-9._-]/g, '')}` || `${sid}_${res.matched}.png`;
      const path = join(JPART_DIR, file);
      if (res.samples.length < 12) res.samples.push(`${hitsByName.map(c => c.id).join('+')} ← ${card.filename} (${page.h1})`);
      if (dry) continue;
      try {
        if (!existsSync(path)) {
          const r = await timedFetch(card.img, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!r.ok) continue;
          writeFileSync(path, Buffer.from(await r.arrayBuffer()));
          res.downloaded++;
          await sleep(DELAY);
        }
        for (const c of hitsByName) res.applied += Number(upd.run(`/jpart/${file}`, c.id).changes);
      } catch { /* next card */ }
    }
    log(`[artofpkm] /sets/${sid} "${page.h1}" → alias '${alias}' · pool ${pool.length} · running: ${JSON.stringify({ matched: res.matched, applied: res.applied, nameless: res.nameless })}`);
  }
  return res;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const res = await importArtofpkm(openDb(), {
    sets: arg('sets')?.split(','),
    dry: process.argv.includes('--dry'),
    deep: process.argv.includes('--deep'),
    seedMissing: process.argv.includes('--seed-missing'),
    limit: Number(arg('limit') ?? Infinity),
  });
  console.log(`[artofpkm]${process.argv.includes('--dry') ? ' DRY RUN' : ''}`, JSON.stringify(res, null, 1));
  if (res.unaliased.length) console.log('[artofpkm] unaliased sets (extend OVERRIDES as needed):', res.unaliased.join(' · '));
}
