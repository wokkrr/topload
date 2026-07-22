/**
 * PKMN/YGO satellite mop-up — retire duplicate-identity rows (Kaleb,
 * 2026-07-22, Phantasmal Flames: same physical card listed twice in the
 * Card Database).
 *
 * Mechanism being repaired: a NEW SET reaches PriceCharting before our
 * vendored catalog snapshot carries it → ingest honestly creates satellite
 * rows (id …-pc<n>) for the unmatched products → a later catalog refresh
 * adds the canonical rows → the same card has two marked identities.
 *
 * CONSERVATIVE BY CONSTRUCTION — a satellite is absorbed only when ALL hold:
 *   1. no bracket label (bracketed = PC's separate VARIANT products —
 *      [Reverse Holo], [1st Edition], [Stamped], [EB Games]… — legitimately
 *      distinct rows; merging them would pollute base comps, the exact sin
 *      caught in the OP mop-up's live dry run 2026-07-21);
 *   2. number-key equality (PKMN '130' ≡ '130/94'; YGO '-EN' infix-blind);
 *   3. EXPLICIT set gate: normalized set names equal after stripping the
 *      PC prefix ('Pokemon '/'YuGiOh ') — containment either way;
 *   4. the conservative matcher confirms on the gated candidate set
 *      (name + language routing).
 * Everything else is KEPT — still priced, still searchable; never guess.
 *
 *   node server/mopup-satellites.js --ip=PKMN --dry
 *   node server/mopup-satellites.js --ip=ALL
 *
 * FK-safety (same pattern as mopup-op-satellites): sales re-pointed before
 * any delete; satellites with remaining sales never deleted; marks move with
 * UPDATE OR IGNORE + leftover-drop; pricecharting/tcgplayer external ids
 * merged onto the canonical (COALESCE — never overwrite).
 *
 * AFTER a live run: `npm run oracle:refresh` rebuilds marks onto canonical
 * ids — that is when the duplicate rows disappear from the lookup.
 * WRITER — queue behind the canonical guard (its filename carries no guard
 * token on purpose; run it via the guard-wait wrapper like other one-shots).
 */
import { openDb } from './db.js';
import { matchListing } from './match.js';
import { numberKey } from './import-tcgcsv.js';

const isSat = (id) => /-pc\d+$/.test(id);
const normSet = (s) => (s ?? '').toLowerCase().replace(/^\s*(pokemon|yugioh)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function mopupSatellites(db, { ip, dry = false } = {}) {
  const all = db.prepare(`SELECT id, name, number, set_name, language, external_ids FROM cards WHERE ip = ?`).all(ip);
  const canonical = all.filter(c => !isSat(c.id));
  const sats = all.filter(c => isSat(c.id));
  const byNum = new Map();
  for (const c of canonical) {
    const k = numberKey(ip, c.number);
    if (k) (byNum.get(k) ?? byNum.set(k, []).get(k)).push(c);
  }

  const res = { ip, satellites: sats.length, matched: 0, keptVariant: 0, keptUnmatched: 0,
                marksMoved: 0, marksDroppedDup: 0, tcgPricesMoved: 0, salesMoved: 0,
                listingsRepointed: 0, registryRepointed: 0, retired: 0, samples: [] };
  if (!dry) db.exec('BEGIN');

  const moveMarks = db.prepare(`UPDATE OR IGNORE external_marks SET card_id = ? WHERE card_id = ?`);
  const dropLeftoverMarks = db.prepare(`DELETE FROM external_marks WHERE card_id = ?`);
  const moveTcg = db.prepare(`UPDATE OR IGNORE tcgplayer_prices SET card_id = ? WHERE card_id = ?`);
  const dropLeftoverTcg = db.prepare(`DELETE FROM tcgplayer_prices WHERE card_id = ?`);
  const moveSales = db.prepare(`UPDATE sales SET card_id = ? WHERE card_id = ?`);
  const moveListings = db.prepare(`UPDATE gacha_listings SET card_id = ? WHERE card_id = ?`);
  const moveRegistry = db.prepare(`UPDATE nft_registry SET card_id = ? WHERE card_id = ?`);
  const attachExt = db.prepare(
    `UPDATE cards SET external_ids = json_set(json_set(external_ids,
       '$.pricecharting', COALESCE(json_extract(external_ids, '$.pricecharting'), json_extract(?, '$.pricecharting')),
       '$.tcgplayer', COALESCE(json_extract(external_ids, '$.tcgplayer'), json_extract(?, '$.tcgplayer'))),
       '$.absorbed_pc', json_extract(?, '$.pricecharting'))
     WHERE id = ?`);
  const dropSat = db.prepare(`DELETE FROM cards WHERE id = ? AND id NOT IN (SELECT DISTINCT card_id FROM sales)`);
  const dropDerived = [
    db.prepare(`DELETE FROM oracle_prices WHERE card_id = ?`),
    db.prepare(`DELETE FROM latest_marks  WHERE card_id = ?`),
    db.prepare(`DELETE FROM basket_members WHERE card_id = ?`),
  ];

  for (const sat of sats) {
    if (/\[|\]/.test(sat.name ?? '')) { res.keptVariant++; continue; }
    const k = numberKey(ip, sat.number);
    const satSet = normSet(sat.set_name);
    // Gates 2+3: same number key AND set-name agreement (containment covers
    // subtitle drift like 'Base Set' vs 'Base Set Shadowless' — but the
    // matcher below still has to confirm the name).
    const candidates = (k ? byNum.get(k) ?? [] : []).filter(c => {
      const cs = normSet(c.set_name);
      return cs && satSet && (cs === satSet || cs.includes(satSet) || satSet.includes(cs));
    });
    if (!candidates.length) { res.keptUnmatched++; continue; }
    // Gate 4: conservative matcher (name + language routing) on the gated set.
    const title = `${sat.name ?? ''} ${sat.number ?? ''} ${sat.set_name ?? ''}`.trim();
    const hit = matchListing(title, candidates);
    if (!hit) { res.keptUnmatched++; continue; }
    res.matched++;
    if (res.samples.length < 10) res.samples.push(`${sat.id} → ${hit}  (${title.slice(0, 64)})`);
    if (dry) continue;

    res.marksMoved += Number(moveMarks.run(hit, sat.id).changes);
    res.marksDroppedDup += Number(dropLeftoverMarks.run(sat.id).changes);
    res.tcgPricesMoved += Number(moveTcg.run(hit, sat.id).changes);
    dropLeftoverTcg.run(sat.id);
    res.salesMoved += Number(moveSales.run(hit, sat.id).changes);
    res.listingsRepointed += Number(moveListings.run(hit, sat.id).changes);
    res.registryRepointed += Number(moveRegistry.run(hit, sat.id).changes);
    attachExt.run(sat.external_ids ?? '{}', sat.external_ids ?? '{}', sat.external_ids ?? '{}', hit);
    for (const d of dropDerived) d.run(sat.id);
    res.retired += Number(dropSat.run(sat.id).changes);
  }

  if (!dry) db.exec('COMMIT');
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const dry = process.argv.includes('--dry');
  const ipArg = process.argv.find(a => a.startsWith('--ip='))?.slice(5) ?? 'ALL';
  for (const ip of ipArg === 'ALL' ? ['PKMN', 'YGO'] : [ipArg]) {
    console.log(`[mopup:${ip}]${dry ? ' DRY RUN' : ''}`, JSON.stringify(mopupSatellites(db, { ip, dry }), null, 1));
  }
  if (!dry) console.log('[mopup] NEXT: npm run oracle:refresh — that is when the duplicate rows disappear.');
}
