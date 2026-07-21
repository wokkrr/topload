/**
 * One Piece variant art — assign OFFICIAL parallel-art images to the variant
 * satellites the mop-up deliberately kept ([Alt Art], [Manga], [Winner], …).
 *
 * Bandai publishes every parallel printing's art as its own file (OP13-118,
 * OP13-118_p1 … _p4) and our vendored punk-records snapshots enumerate them.
 * VERIFIED LIVE 2026-07-21 (Sabo OP13-120 vs TCGplayer): the snapshot's
 * rarity field does NOT reliably identify which parallel is which artwork —
 * 'Special' pointed at the wanted-poster art while the red-manga art sat on a
 * 'SecretRare' parallel. So NO rarity heuristics. Assignment happens only
 * when it cannot be wrong:
 *
 *   1. CURATED MAP first (seed/op-variant-map.json: "CODE|label words" →
 *      parallel suffix, built by visually comparing parallels) — authoritative.
 *   2. Edition-style tags ([Winner]/[Prize]/[Serial] …) → BASE artwork
 *      (stamped printings share it).
 *   3. Any variant label on a code with EXACTLY ONE parallel → that parallel.
 *   4. Everything else stays artless and lands in the curation queue —
 *      honest empty beats wrong art on rows whose premium IS the artwork.
 *
 * Assignments are tagged image_kind='variant' and the pass RESETS its own
 * prior assignments first — fully re-derivable, trivially reversible, never
 * a borrow-art donor. Japanese satellites resolve against the JA snapshot.
 *
 *   node server/seed-op-variant-art.js --dry
 *   node server/seed-op-variant-art.js
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EDITION_RE = /\[(.*?(winner|champion|finalist|prize|serial|pre-?release|anniversary|judge|event|tournament).*?)\]/i;
const CODE_RE = /\b((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})\b/i;

/** snapshot {cards:{CODE:…, CODE_p1:…}} → Map(code → {base, parallels:[{url,rarity}]}) */
export function indexSnapshot(snap) {
  const byCode = new Map();
  for (const [key, c] of Object.entries(snap?.cards ?? {})) {
    const m = /^(.*?)(?:_p(\d+))?$/.exec(key);
    const code = m[1].toUpperCase();
    const entry = byCode.get(code) ?? { base: null, parallels: [] };
    const rec = { url: c.img_url ?? null, rarity: c.rarity ?? null };
    if (m[2]) entry.parallels.push(rec); else entry.base = rec;
    byCode.set(code, entry);
  }
  return byCode;
}

/** Normalize a bracket label for curated-map keys: '[Red Manga]' → 'red manga'. */
export const labelKey = (name) => (/\[([^\]]+)\]/.exec(name ?? '')?.[1] ?? '').toLowerCase().trim();

export function pickArt(name, entry, code, curated = {}) {
  if (!entry) return null;
  const { base, parallels } = entry;
  const curatedSuffix = curated[`${code}|${labelKey(name)}`];    // e.g. 'p3' or 'base'
  if (curatedSuffix) {
    if (curatedSuffix === 'base') return base?.url ?? null;
    const hit = parallels.find(p => p.url?.includes(`_${curatedSuffix}.`));
    return hit?.url ?? null;
  }
  if (EDITION_RE.test(name)) return base?.url ?? null;          // stamped printing, base artwork
  const lk = labelKey(name);
  // '[Foil]' EXACTLY (not 'SP Foil'/'Manga Foil …') = foiled BASE printing
  // (PRB "The Best" reprints) — base artwork, different treatment.
  if (lk === 'foil') return base?.url ?? null;
  if (parallels.length === 1) return parallels[0].url;          // only one alt art → no ambiguity
  // VISUALLY VERIFIED CONVENTIONS (2026-07-21, screenshots vs Bandai gallery):
  // 1. '_p1' is the STANDARD Alternate Art across sets (checked OP01-016,
  //    OP05-119 Gear-5 Luffy, OP07-051) — a bare '[Alternate Art]' label maps
  //    to p1. 'Alternate Art PRB01/PRB-02' is the SAME artwork reprinted with
  //    premium-booster foil (verified EB01-006: the PRB parallel repeats the
  //    p1 art), so it takes the p1 path too. Labels with other extra words
  //    (manga/red/…) do NOT take this path.
  if (/^alternate art( prb-?\d{2})?$/.test(lk)) {
    const p1 = parallels.find(pp => pp.url?.includes('_p1.'));
    if (p1) return p1.url;
  }
  // 2. '[SP]'/'[SP Foil]' = the SP treatment, which carries rarity 'Special'
  //    AND an SP-prefixed card code (verified OP07-051_p3 face: 'SP OP07-051').
  //    Only when exactly ONE Special parallel exists — else curation.
  if (/^sp( foil)?$/.test(lk)) {
    const specials = parallels.filter(pp => pp.rarity === 'Special');
    if (specials.length === 1) return specials[0].url;
  }
  return null;                                                  // multi-parallel → curation queue
}

export function opVariantArt(db, { dry = false, snapEn, snapJa, curated } = {}) {
  snapEn ??= JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'onepiece-catalog.json'), 'utf8'));
  snapJa ??= JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'onepiece-catalog-ja.json'), 'utf8'));
  if (!curated) {
    try { curated = JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'op-variant-map.json'), 'utf8')); } catch { curated = {}; }
  }
  const en = indexSnapshot(snapEn);
  const ja = indexSnapshot(snapJa);

  // Re-derive from scratch each run: rules/curation may have changed.
  if (!dry) db.prepare(`UPDATE cards SET image = NULL, image_kind = NULL WHERE image_kind = 'variant'`).run();
  const targets = db.prepare(
    `SELECT id, name, number, language FROM cards
     WHERE ip = 'OP' AND image IS NULL AND id LIKE 'op-pc%' AND instr(name, '[') > 0`
  ).all();
  const upd = db.prepare(`UPDATE cards SET image = ?, image_kind = 'variant' WHERE id = ?`);
  const res = { targets: targets.length, curatedEntries: Object.keys(curated).filter(k => k.includes('|')).length, noCode: 0, assigned: 0, ambiguous: 0, samples: [] };

  for (const t of targets) {
    const code = (CODE_RE.exec(t.number ?? '') ?? CODE_RE.exec(t.name ?? ''))?.[1]?.toUpperCase();
    if (!code) { res.noCode++; continue; }
    const map = /^japanese$/i.test(t.language ?? '') ? ja : en;
    const url = pickArt(t.name ?? '', map.get(code) ?? (map === ja ? en : ja).get(code), code, curated);
    if (!url) { res.ambiguous++; continue; }
    res.assigned++;
    if (res.samples.length < 10) res.samples.push(`${t.id} (${t.name.slice(0, 40)}) ← ${url.slice(url.lastIndexOf('/') + 1)}`);
    if (!dry) upd.run(url, t.id);
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const dry = process.argv.includes('--dry');
  console.log(`[op-variant-art]${dry ? ' DRY RUN' : ''}`, JSON.stringify(opVariantArt(db, { dry }), null, 1));
}
