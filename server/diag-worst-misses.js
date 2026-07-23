/**
 * Worst-miss forensics (2026-07-23) — the accuracy backtest's biggest errors
 * are identity errors, not pricing errors: "oracle said $2, sold for $649"
 * means the SALE was attributed to the wrong card (usually a base printing
 * absorbing an alt-art/secret-rare sibling's sale), or the card's raw mark
 * belongs to a different variant than what actually traded.
 *
 * For each of the N worst misses this prints the full case file:
 *   - the sale (source, external_id, title-ish info we stored, date, price)
 *   - the card it was attributed to (name/set/number/variant, its marks)
 *   - SIBLING SUSPECTS: same set + same number, different variant/name —
 *     ranked by how close their Oracle price is to the sale price (the
 *     sibling whose price "explains" the sale is usually the right home)
 *
 * Read-only. Run:  node server/diag-worst-misses.js [--days=60] [--top=12]
 */
import { openDb } from './db.js';
import { oracleAccuracy } from './diag-oracle-accuracy.js';

const db = openDb();
const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 60);
const top = Number(process.argv.find(a => a.startsWith('--top='))?.slice(6) ?? 12);

const misses = oracleAccuracy(db, { days }).worstMisses.slice(0, top);
console.log(`== WORST-MISS FORENSICS (${days}d, top ${misses.length}) ==\n`);

const saleStmt = db.prepare(`
  SELECT s.source, s.external_id, s.sold_at, s.price_cents, s.grade
  FROM sales s WHERE s.card_id = ? AND s.grade = ? AND s.price_cents = ? LIMIT 1`);
const cardStmt = db.prepare(`SELECT id, name, set_name, number, variant, language FROM cards WHERE id = ?`);
const sibStmt = db.prepare(`
  SELECT c.id, c.name, lm.grade, lm.price_cents
  FROM cards c JOIN latest_marks lm ON lm.card_id = c.id
  WHERE c.set_name = (SELECT set_name FROM cards WHERE id = ?)
    AND c.number = (SELECT number FROM cards WHERE id = ?)
    AND c.id <> ?`);

for (const m of misses) {
  const saleCents = Math.round(Number(m.sold.replace('$', '')) * 100);
  const card = cardStmt.get(m.card);
  const sale = saleStmt.get(m.card, m.grade, saleCents) ?? saleStmt.get(m.card, m.grade, saleCents + 99) ?? {};
  console.log(`▸ ${m.errPct > 0 ? '+' : ''}${m.errPct}%  sold ${m.sold} vs oracle ${m.oracle} · ${m.on}`);
  console.log(`  card: ${card?.id} — "${card?.name}" · ${card?.set_name} #${card?.number}${card?.variant ? ` · [${card.variant}]` : ''}${card?.language && card.language !== 'English' ? ` · ${card.language}` : ''}`);
  if (sale.source) console.log(`  sale: ${sale.source} ${sale.external_id ?? ''} · grade ${sale.grade}`);
  const sibs = sibStmt.all(m.card, m.card, m.card)
    .map(s => ({ ...s, fit: Math.abs(Math.log((s.price_cents || 1) / saleCents)) }))
    .sort((a, b) => a.fit - b.fit).slice(0, 3);
  if (sibs.length) {
    console.log('  sibling suspects (whose price explains the sale):');
    for (const s of sibs) {
      const ratio = (s.price_cents / saleCents);
      console.log(`    ${ratio > 0.5 && ratio < 2 ? '★' : ' '} ${s.id} "${s.name}" ${s.grade} $${(s.price_cents / 100).toFixed(0)}`);
    }
  } else {
    console.log('  no same-set/number siblings — likely a stale/placeholder mark on the card itself, not misattribution');
  }
  console.log('');
}
console.log('★ = sibling whose Oracle price is within 2x of the sale — the probable true home.');
console.log(`Fixes: re-point the sale (matcher alias) OR the card's mark is the wrong variant's. Each fix teaches the matcher.`);
