/**
 * Catalog integrity gate — the "rock solid" check for the Topload Card
 * Database. Run after seeding/refreshing all three franchises:
 *
 *   npm run catalog:verify
 *
 * Verifies, per franchise: canonical counts, duplicate ids, missing
 * name/number/image, stale non-canonical remnants — then smoke-tests the
 * MATCHER against real listing-title shapes for each franchise so a catalog
 * regression can't silently break attribution. Exits 1 on any failure.
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';

const db = openDb(process.env.TOPLOAD_DB ?? undefined); // TOPLOAD_DB overrides for scratch runs
let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

const CANON = {
  PKMN: `json_extract(external_ids, '$.ptcgdata') IS NOT NULL`,
  OP: `json_extract(external_ids, '$.punkrecords') IS NOT NULL`,
  YGO: `json_extract(external_ids, '$.ygoprodeck') IS NOT NULL`,
};
// Sanity floors — a fetch/seed that silently truncated should trip these.
const MIN_CANONICAL = { PKMN: 15000, OP: 4000, YGO: 25000 };

console.log('\n=== Topload Card Database — integrity gate ===\n');

for (const [ip, canonSql] of Object.entries(CANON)) {
  console.log(`${ip}:`);
  const total = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ip=?`).get(ip).n;
  const canon = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ip=? AND ${canonSql}`).get(ip).n;
  const old = total - canon;
  if (canon >= MIN_CANONICAL[ip]) ok(`${canon} canonical cards (floor ${MIN_CANONICAL[ip]})`);
  else fail(`only ${canon} canonical cards — below floor ${MIN_CANONICAL[ip]} (seed missing/truncated?)`);
  if (old > 0) console.log(`  · ${old} non-canonical remnants (kept for sales FK — fine unless growing)`);

  const noName = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ip=? AND ${canonSql} AND (name IS NULL OR name='')`).get(ip).n;
  const noNum = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ip=? AND ${canonSql} AND (number IS NULL OR number='')`).get(ip).n;
  const noImg = db.prepare(`SELECT COUNT(*) n FROM cards WHERE ip=? AND ${canonSql} AND image IS NULL`).get(ip).n;
  if (noName === 0) ok('no missing names'); else fail(`${noName} canonical cards missing name`);
  if (noNum === 0) ok('no missing numbers'); else fail(`${noNum} canonical cards missing number`);
  if (noImg === 0) ok('no missing images'); else console.log(`  · ${noImg} canonical cards without an image (non-fatal)`);
  console.log('');
}

// Cross-franchise: ids are globally unique by construction (prefixed); verify anyway.
const dupIds = db.prepare(`SELECT COUNT(*) - COUNT(DISTINCT id) d FROM cards`).get().d;
if (dupIds === 0) ok('no duplicate card ids across franchises'); else fail(`${dupIds} duplicate ids`);

// Orphan checks: every attribution must point at a real card.
for (const [t, col] of [['sales', 'card_id'], ['gacha_listings', 'card_id']]) {
  const orphans = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col} IS NOT NULL AND ${col} NOT IN (SELECT id FROM cards)`).get().n;
  if (orphans === 0) ok(`no orphaned ${t}.${col}`); else fail(`${orphans} orphaned rows in ${t}`);
}

// Matcher smoke tests — real listing-title shapes per franchise against the
// LIVE catalog. If seeds are current these must resolve to canonical ids.
console.log('\nmatcher smoke tests (live catalog):');
const SMOKE = [
  ['PKMN', '1999 Pokemon Base Set Charizard Holo #4/102 PSA 9', 'pkmn-base1-4'],
  // NB: OP07-013 is Masked Deuce, NOT Trafalgar Law (Law = OP07-047). A live
  // MNSTR listing pairs "Trafalgar Law" with "#013" (Treasure Rare quirk) and
  // the matcher CORRECTLY refuses it — keep this smoke test on the real pairing.
  ['OP', '2024 One Piece Op07-500 Years in the Future Trafalgar Law #047 PSA 10', 'op-op07-047'],
  ['YGO', '2002 Yu-Gi-Oh Legend of Blue Eyes LOB-001 Blue-Eyes White Dragon 1st Edition PSA 9', 'ygo-lob-'],
];
for (const [ip, title, expected] of SMOKE) {
  const universe = db.prepare(`SELECT id, name, number, set_name FROM cards WHERE ip=?`).all(ip);
  const hit = matchListing(title, universe);
  if (hit && hit.startsWith(expected)) ok(`${ip}: "${title.slice(0, 55)}…" → ${hit}`);
  else fail(`${ip}: "${title.slice(0, 55)}…" → ${hit ?? 'NO MATCH'} (expected ${expected}*)`);
}

console.log(failures === 0
  ? '\n=== ALL CHECKS PASSED — the spine is solid ===\n'
  : `\n=== ${failures} FAILURE(S) — fix before building on top ===\n`);
process.exit(failures === 0 ? 0 : 1);
