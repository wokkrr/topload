/**
 * One Piece variant art — assign OFFICIAL parallel-art images to the variant
 * satellites the mop-up deliberately kept ([Alt Art], [Manga], [Winner], …).
 *
 * Bandai publishes every parallel printing's art as its own file (OP13-118,
 * OP13-118_p1 … _p4) and our vendored punk-records snapshots enumerate them
 * with rarity labels — the manga-art printings are rarity 'Special'. So the
 * art for these rows already sits in files we own; this pass maps each PC
 * variant label to a parallel image ONLY when the mapping is unambiguous:
 *
 *   1. Edition-style tags ([Winner]/[Prize]/[Serial] …) reuse the BASE
 *      artwork (stamped printings) → base image.
 *   2. Manga-class labels → the code's Special-rarity parallel, iff exactly 1.
 *   3. Any other variant label → the code's parallel, iff the code has
 *      exactly 1 (564 EN codes), else exactly 1 non-Special parallel.
 *   4. Anything still ambiguous stays artless — honest empty beats wrong art
 *      on rows whose entire premium IS the artwork.
 *
 * Japanese satellites resolve against the JA snapshot (Japanese printings'
 * own art). Assigned rows get image_kind='borrowed' (inferred assignment —
 * distinguishable + reversible), and never become borrow-art donors.
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
const MANGA_RE = /\[(.*?(manga|\bsp\b).*?)\]/i;
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

export function pickArt(name, entry) {
  if (!entry) return null;
  const { base, parallels } = entry;
  if (EDITION_RE.test(name)) return base?.url ?? null;          // stamped printing, base artwork
  if (MANGA_RE.test(name)) {
    const specials = parallels.filter(p => p.rarity === 'Special');
    return specials.length === 1 ? specials[0].url : null;
  }
  if (parallels.length === 1) return parallels[0].url;
  const nonSpecial = parallels.filter(p => p.rarity !== 'Special');
  return nonSpecial.length === 1 ? nonSpecial[0].url : null;    // else ambiguous → stay empty
}

export function opVariantArt(db, { dry = false, snapEn, snapJa } = {}) {
  snapEn ??= JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'onepiece-catalog.json'), 'utf8'));
  snapJa ??= JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'onepiece-catalog-ja.json'), 'utf8'));
  const en = indexSnapshot(snapEn);
  const ja = indexSnapshot(snapJa);

  const targets = db.prepare(
    `SELECT id, name, number, language FROM cards
     WHERE ip = 'OP' AND image IS NULL AND id LIKE 'op-pc%' AND instr(name, '[') > 0`
  ).all();
  const upd = db.prepare(`UPDATE cards SET image = ?, image_kind = 'borrowed' WHERE id = ?`);
  const res = { targets: targets.length, noCode: 0, assigned: 0, ambiguous: 0, samples: [] };

  for (const t of targets) {
    const code = (CODE_RE.exec(t.number ?? '') ?? CODE_RE.exec(t.name ?? ''))?.[1]?.toUpperCase();
    if (!code) { res.noCode++; continue; }
    const map = /^japanese$/i.test(t.language ?? '') ? ja : en;
    const url = pickArt(t.name ?? '', map.get(code) ?? (map === ja ? en : ja).get(code));
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
