/**
 * MARK PROVENANCE FORENSICS (Kaleb, 2026-07-23). The worst-miss audit found
 * 6 of 8 blowups had NO same-set/number siblings — the bad mark lives on the
 * card itself, not on a look-alike. This tool answers WHERE that mark came
 * from, per card:
 *
 *   1. What PriceCharting product is the card wearing (external_ids.$.pricecharting)?
 *   2. Is that product still in the current daily guide CSV, and do its
 *      name/number/variant-label actually match OUR card?  (wrong-product attach)
 *   3. Is the mark FRESH (still refreshed by the nightly import) or FROZEN
 *      (product fell out of the guide / was gated → mark stuck in the past)?
 *   4. Does the mark faithfully mirror the guide's current price?  If yes and
 *      the sale still blew past it, the PRODUCT is the wrong printing for our
 *      card (base loose price on an Ultra Rare / alt-art row) — a mapping
 *      disease, cousin of the repair-variant-marks corruption but inverted:
 *      cheap base product attached to an expensive variant card.
 *
 * Read-only. Auto-selects the current worst misses when run bare.
 *   node server/diag-mark-provenance.js                 # worst 8 from 60d backtest
 *   node server/diag-mark-provenance.js --days=90       # widen the backtest window
 *   node server/diag-mark-provenance.js <card_id> [...] # explicit case files
 */
import { openDb } from './db.js';
import { oracleAccuracy } from './diag-oracle-accuracy.js';
import { latestCsvs } from './repair-variant-marks.js';
import { parseCsv, splitProductName, labelOf } from './import-pricecharting-csv.js';

// Mirrors CSV_GRADE_FIELDS in import-pricecharting-csv.js (not exported there).
const GRADE_TO_CSV_FIELD = {
  raw: 'loose-price', PSA9: 'graded-price', PSA10: 'manual-only-price',
  'G9.5': 'box-only-price', BGS10: 'bgs-10-price', CGC10: 'condition-17-price',
};
const usd = (c) => c == null ? '—' : `$${(c / 100).toFixed(c < 1000 ? 2 : 0)}`;
const cents = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export function markProvenance(db, cardIds, { guide } = {}) {
  guide ??= (() => {
    const m = new Map();
    for (const { text, ip } of latestCsvs()) {
      for (const row of parseCsv(text)) m.set(String(row.id), { ...row, __ip: ip });
    }
    return m;
  })();

  const qCard = db.prepare(`SELECT * FROM cards WHERE id = ?`);
  const qMarks = db.prepare(
    `SELECT grade, COUNT(*) n, MIN(as_of) first, MAX(as_of) last,
            (SELECT price_cents FROM external_marks e2 WHERE e2.card_id = e.card_id
              AND e2.source = e.source AND e2.grade = e.grade ORDER BY as_of DESC LIMIT 1) last_cents,
            source
     FROM external_marks e WHERE card_id = ? GROUP BY source, grade ORDER BY source, grade`);
  const qLatest = db.prepare(
    `SELECT grade, price_cents, basis, source, as_of, confidence FROM latest_marks WHERE card_id = ? ORDER BY grade`);
  const qSales = db.prepare(
    `SELECT grade, price_cents, sold_at, source, is_outlier FROM sales WHERE card_id = ?
     ORDER BY sold_at DESC LIMIT 6`);

  return cardIds.map((id) => {
    const card = qCard.get(id);
    if (!card) return { id, verdicts: ['NO SUCH CARD'] };
    let pc = null;
    try { pc = JSON.parse(card.external_ids ?? '{}').pricecharting ?? null; } catch { /* keep null */ }
    pc = pc != null ? String(pc) : (/-pc(\d+)$/.exec(id)?.[1] ?? null);
    const row = pc ? guide.get(pc) : null;
    const marks = qMarks.all(id);
    const latest = qLatest.all(id);
    const sales = qSales.all(id);

    const verdicts = [];
    if (!pc) {
      verdicts.push('NO PC ATTACHMENT — marks (if any) came from another source; check latest_marks basis');
    } else if (!row) {
      verdicts.push(`FROZEN: pc ${pc} is NOT in the current daily guide — nightly import can never refresh this mark; it is stuck at its last import date`);
    } else {
      const prod = splitProductName(row['product-name']);
      const prodLabel = labelOf(row['product-name']);
      const cardLabel = labelOf(card.name);
      if (row.__ip && row.__ip !== card.ip) verdicts.push(`WRONG-IP ATTACH: product is in the ${row.__ip} guide, card is ${card.ip}`);
      if (prod.number && card.number && prod.number.toLowerCase() !== card.number.toLowerCase()) {
        verdicts.push(`NUMBER MISMATCH: product "#${prod.number}" vs card "#${card.number}" — wrong-product attach`);
      }
      const a = prod.name.toLowerCase(), b = (card.name ?? '').replace(/\[[^\]]*\]/g, '').trim().toLowerCase();
      if (a && b && !a.includes(b) && !b.includes(a)) {
        verdicts.push(`NAME MISMATCH: product "${prod.name}" vs card "${card.name}" — wrong-product attach`);
      }
      if (prodLabel !== cardLabel) {
        verdicts.push(`VARIANT-LABEL MISMATCH: product [${prodLabel || 'base'}] vs card [${cardLabel || 'base'}] — a ${prodLabel || 'base'} printing's prices on a ${cardLabel || 'base'} row`);
      }
      // Freshness + faithfulness, per grade the guide prices.
      for (const [grade, field] of Object.entries(GRADE_TO_CSV_FIELD)) {
        const guideCents = cents(row[field]);
        const mark = marks.find(m => m.source === 'pricecharting' && m.grade === grade);
        if (!mark) continue;
        const ageDays = Math.round((Date.now() - Date.parse(mark.last)) / 86_400_000);
        if (ageDays > 30) verdicts.push(`STALE ${grade}: last pricecharting mark ${mark.last} (${ageDays}d old) — gated or dropped by the import since`);
        if (guideCents != null && Math.abs(guideCents - mark.last_cents) / guideCents <= 0.02) {
          verdicts.push(`FAITHFUL ${grade}: mark ${usd(mark.last_cents)} mirrors today's guide ${usd(guideCents)} — if sales still blow past it, the attached PRODUCT is the wrong printing for this card (or the guide's ${field} is thin)`);
        }
      }
      if (!verdicts.length) verdicts.push('attachment looks coherent — suspect thin guide data or a market move the guide lags');
    }
    return {
      id, card, pc, guideRow: row ? {
        product: row['product-name'], console: row['console-name'],
        loose: row['loose-price'], graded: row['graded-price'], manualOnly: row['manual-only-price'],
        volume: row['sales-volume'],
      } : null,
      marks, latest, sales, verdicts,
    };
  });
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 60);
  let ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!ids.length) {
    ids = [...new Set(oracleAccuracy(db, { days }).worstMisses.map(w => w.card))];
    console.log(`(no card ids given — auto-selected ${ids.length} worst misses from the ${days}d backtest)\n`);
  }
  for (const c of markProvenance(db, ids)) {
    console.log(`== ${c.id} ==`);
    if (c.card) {
      console.log(`  card: "${c.card.name}" · ${c.card.set_name ?? '?'} #${c.card.number ?? '?'} · variant "${c.card.variant}" · ${c.card.language ?? 'English'} · pc ${c.pc ?? '—'}`);
      if (c.guideRow) console.log(`  guide today: "${c.guideRow.product}" (${c.guideRow.console}) · loose ${c.guideRow.loose || '—'} · graded ${c.guideRow.graded || '—'} · PSA10-field ${c.guideRow.manualOnly || '—'} · vol ${c.guideRow.volume || '—'}`);
      for (const m of c.marks) console.log(`  marks[${m.source}] ${m.grade.padEnd(7)} ${String(m.n).padStart(4)} pts · ${m.first} → ${m.last} · last ${usd(m.last_cents)}`);
      for (const l of c.latest) console.log(`  oracle ${l.grade.padEnd(7)} ${usd(l.price_cents).padStart(9)} · ${l.basis}${l.source ? `/${l.source}` : ''} · as of ${l.as_of} · conf ${l.confidence}`);
      for (const s of c.sales) console.log(`  sale   ${s.grade.padEnd(7)} ${usd(s.price_cents).padStart(9)} · ${s.sold_at.slice(0, 10)} · ${s.source}${s.is_outlier ? ' · OUTLIER' : ''}`);
    }
    for (const v of c.verdicts) console.log(`  ▶ ${v}`);
    console.log('');
  }
  console.log('Verdict key: FROZEN = product fell out of the guide (mark stuck in time) · MISMATCH = wrong product attached · FAITHFUL = our pipeline is honest, the attachment itself prices the wrong printing.');
}
