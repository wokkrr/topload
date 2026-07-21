/**
 * Language-sibling printings: the SAME card issued in another language
 * (EN ↔ JP is the pair collectors actually price-compare — JP printings of
 * chase cards often trade at a large discount or premium to EN, and Kaleb
 * wants that spread visible on the card page; backlog item "EN/JP
 * side-by-side", built 2026-07-21 while the evening chain ran).
 *
 * Matching is deliberately conservative — a wrong sibling is worse than none:
 *   1. Candidates share ip + printed number (OP codes and YGO numbers are
 *      global across languages) — or ip + exact name when the card has no
 *      number (PC promo rows).
 *   2. The base name (bracket label stripped, case-insensitive) must ALSO
 *      match. Catalog rows always carry English/romanized display names, so
 *      this holds across languages and kills number-collision false pairs
 *      (Pokémon set numbers repeat across sets).
 *   3. One best sibling per language: exact variant-label match beats
 *      base-only, having a live mark beats not, then lowest id for
 *      determinism.
 *
 * Returns [{ id, language, name, set_name, number, grade, price_cents }] —
 * grade/price from the sibling's TOP latest mark (is_top precompute), null
 * when the sibling is tracked but unpriced.
 */

/** '[Alternate Art]' stripped + lowercased: variant-blind base identity. */
const stripLabel = (name) =>
  (name ?? '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Bracket label lowercased ('' when none) — variant identity. */
const variantLabel = (name) => (/\[([^\]]+)\]/.exec(name ?? '')?.[1] ?? '').toLowerCase().trim();

export function findLanguageSiblings(db, card) {
  if (!card?.id || !card?.ip) return [];
  const lang = card.language ?? 'English';
  const cands = card.number
    ? db.prepare(`SELECT id, name, set_name, number, language FROM cards
                  WHERE ip = ? AND number = ? AND id != ? AND language IS NOT NULL AND language != ?
                  LIMIT 200`).all(card.ip, card.number, card.id, lang)
    : db.prepare(`SELECT id, name, set_name, number, language FROM cards
                  WHERE ip = ? AND name = ? AND id != ? AND language IS NOT NULL AND language != ?
                  LIMIT 200`).all(card.ip, card.name, card.id, lang);
  if (!cands.length) return [];

  const base = stripLabel(card.name);
  const label = variantLabel(card.name);
  const markStmt = db.prepare(
    `SELECT grade, price_cents FROM latest_marks WHERE card_id = ? AND is_top = 1`);

  const best = new Map(); // language → { row, score, mark }
  for (const c of cands) {
    if (stripLabel(c.name) !== base) continue;               // rule 2: same base identity
    const score = variantLabel(c.name) === label ? 2 : 0;    // exact variant beats base-only
    const mark = markStmt.get(c.id) ?? null;
    const prev = best.get(c.language);
    const better = !prev
      || score > prev.score
      || (score === prev.score && !!mark && !prev.mark)
      || (score === prev.score && !!mark === !!prev.mark && c.id < prev.row.id);
    if (better) best.set(c.language, { row: c, score, mark });
  }

  return [...best.values()]
    .sort((a, b) => a.row.language.localeCompare(b.row.language))
    .map(({ row, mark }) => ({
      id: row.id, language: row.language, name: row.name,
      set_name: row.set_name, number: row.number,
      grade: mark?.grade ?? null, price_cents: mark?.price_cents ?? null,
    }));
}
