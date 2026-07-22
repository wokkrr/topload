/**
 * DIAG (read-only): cert-number cross-validation — listings vs the PSA cert
 * archive.
 *
 * A cert number is GROUND TRUTH: the grading company's own record of exactly
 * which card sits in the slab and what grade it earned. Every listing that
 * carries a cert we've archived can be audited three ways (Kaleb, 2026-07-22:
 * "if we can confidently read and match and organize all this data it would
 * be massive"):
 *   1. GRADE AUDIT — listing says PSA10, cert says PSA9 → mislisted or
 *      mis-parsed; either way that comp is poison until resolved.
 *   2. MATCH AUDIT — listing matched to card X, cert matched to card Y →
 *      one of the matchers is wrong; certs outrank title-matching.
 *   3. RESCUE LIST — listing unmatched but its cert knows the card →
 *      free attribution upgrade, no fuzzy matching needed.
 *
 * Read-only reporter; the repair (cert-first attribution in the ingest
 * matchers) gets built on what this finds.
 *
 *   node server/diag-certs.js
 */
import { openDb } from './db.js';

const db = openDb();

const certs = db.prepare(`SELECT COUNT(*) n, SUM(card_id IS NOT NULL) matched FROM psa_certs`).get();
const withCert = db.prepare(`SELECT COUNT(*) n FROM gacha_listings WHERE cert IS NOT NULL AND cert != ''`).get().n;
console.log(`[certs] archive: ${certs.n} certs (${certs.matched ?? 0} matched to cards) · listings carrying a cert: ${withCert}`);

// Overlap: listings whose cert is in the archive.
const joined = db.prepare(
  `SELECT l.platform, l.external_id, l.item_name, l.grade AS l_grade, l.card_id AS l_card,
          c.grade AS c_grade, c.card_id AS c_card, c.label
   FROM gacha_listings l JOIN psa_certs c ON c.cert = l.cert
   WHERE l.cert IS NOT NULL AND l.cert != ''`).all();
console.log(`[certs] overlap (listing cert found in archive): ${joined.length}`);

const norm = (g) => String(g ?? '').toUpperCase().replace(/[\s_-]+/g, '');
const gradeMismatch = [], matchMismatch = [], rescue = [];
for (const r of joined) {
  if (r.c_grade && r.l_grade && norm(r.l_grade) !== norm(r.c_grade)) gradeMismatch.push(r);
  if (r.c_card && r.l_card && r.c_card !== r.l_card) matchMismatch.push(r);
  if (r.c_card && !r.l_card) rescue.push(r);
}

console.log(`\n== 1. GRADE AUDIT — listing grade vs cert grade: ${gradeMismatch.length} mismatches ==`);
for (const r of gradeMismatch.slice(0, 12)) {
  console.log(`  ${r.platform} ${r.external_id}: listing '${r.l_grade}' vs cert '${r.c_grade}' — ${String(r.item_name).slice(0, 60)}`);
}
console.log(`\n== 2. MATCH AUDIT — listing card vs cert card: ${matchMismatch.length} disagreements (certs outrank fuzzy matching) ==`);
for (const r of matchMismatch.slice(0, 12)) {
  console.log(`  ${r.platform} ${r.external_id}: matched '${r.l_card}' but cert says '${r.c_card}' (${String(r.label ?? '').slice(0, 50)})`);
}
console.log(`\n== 3. RESCUE LIST — unmatched listings whose cert knows the card: ${rescue.length} free attributions ==`);
for (const r of rescue.slice(0, 12)) {
  console.log(`  ${r.platform} ${r.external_id} → ${r.c_card} — ${String(r.item_name).slice(0, 60)}`);
}
console.log('\n[diag-certs] read-only, nothing written. If the overlap is thin, the cert archive needs feeding (indexer-psa-pop) before cert-first attribution pays.');
