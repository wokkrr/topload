/**
 * Language-tag migration: the PriceCharting satellite cards ARE the Japanese
 * (and Chinese/Korean) catalogs for Pokémon and Yu-Gi-Oh — romanized names in
 * listing dialect, JP set names, numbers, and ATTACHED PRICES — they just
 * never declared a language, so routing/filters couldn't see them.
 *
 *   npm run catalog:langtags
 *
 * Sets cards.language from the set_name (PriceCharting console-names put the
 * language right in the set: 'Pokemon Japanese Eevee Heroes'). Conservative
 * string match, idempotent, reversible (language only). After this + a
 * rematch, JP Pokémon listings route to these rows AND show comps at once —
 * their marks were here all along.
 *
 * One Piece note: canonical -ja rows already exist; tagging OP satellites is
 * still correct metadata, and ties resolve to canonical (-0.25 satellite
 * penalty) — the marks migration to canonical is the separate mop-up script.
 */
import { openDb } from './db.js';

export function tagLanguages(db) {
  db.exec('BEGIN');
  const res = {};
  for (const [pattern, language] of [
    ['%japanese%', 'Japanese'],
    ['%chinese%', 'Chinese'],
    ['%korean%', 'Korean'],
  ]) {
    const r = db.prepare(
      `UPDATE cards SET language = ?
       WHERE set_name LIKE ? AND language != ?`
    ).run(language, pattern, language);
    res[language] = Number(r.changes);
  }
  db.exec('COMMIT');
  // Per-franchise Japanese counts, for the log.
  res.japaneseByIp = Object.fromEntries(
    db.prepare(`SELECT ip, COUNT(*) n FROM cards WHERE language='Japanese' GROUP BY ip`).all().map(r => [r.ip, r.n])
  );
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  console.log('[catalog:langtags]', JSON.stringify(tagLanguages(db), null, 1));
  console.log('[catalog:langtags] NEXT: npm run rematch -- --listings-only (language routing now sees these rows)');
}
