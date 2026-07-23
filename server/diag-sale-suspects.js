/**
 * SALE-SUSPECT FORENSICS (2026-07-23, the provenance reversal). The mark-
 * provenance run proved the marks are mostly HONEST — guide, TCGPlayer, and
 * the card's other sales all agree; one whale sale is the intruder. So the
 * disease is SALE MISATTRIBUTION: an expensive variant item (SAR / parallel /
 * manga art / different card entirely) sold on a venue and the indexer pinned
 * it to the cheap base row. Two mechanisms make it sticky:
 *   - nft_registry keeps the FIRST attribution forever (COALESCE on conflict),
 *     so items matched under older, looser matcher rules never heal;
 *   - sales rows copy card_id at insert time and are never re-pointed.
 *
 * This tool names the actual items behind the misses:
 *   - courtyard/base sales embed the tokenId in external_id ('<hash>:<mint18>')
 *     → EXACT registry item resolved per sale (name + registry grade);
 *   - phygitals/collectorcrypt sales are signature-keyed (no mint on the row)
 *     → prints the LINEUP: every registry item currently attributed to the
 *       card on that venue, so the intruder can be picked out by name.
 *
 * Whale flag: sale ≥4x (or ≤1/4x) the card's median mark across grades.
 *
 * Read-only. Auto-selects backtest worst misses when run bare.
 *   node server/diag-sale-suspects.js [--days=60] [card_id …]
 */
import { openDb } from './db.js';
import { oracleAccuracy } from './diag-oracle-accuracy.js';

const usd = (c) => c == null ? '—' : `$${(c / 100).toFixed(c < 1000 ? 2 : 0)}`;

export function saleSuspects(db, cardIds, { days = 60 } = {}) {
  const qCard = db.prepare(`SELECT id, ip, name, set_name, number, variant, language FROM cards WHERE id = ?`);
  const qSales = db.prepare(
    `SELECT id, grade, price_cents, sold_at, source, external_id, is_outlier FROM sales
     WHERE card_id = ? AND date(sold_at) >= date('now', ?) ORDER BY price_cents DESC`);
  const qMarks = db.prepare(`SELECT grade, price_cents FROM latest_marks WHERE card_id = ?`);
  // Exact resolution: registry mint starts with the tokenId fragment after ':'.
  const qMint = db.prepare(
    `SELECT mint, item_name, grade, category, card_id FROM nft_registry
     WHERE mint LIKE ? || '%' LIMIT 2`);
  const qLineup = db.prepare(
    `SELECT platform, mint, item_name, grade FROM nft_registry WHERE card_id = ? ORDER BY platform, item_name`);

  return cardIds.map((id) => {
    const card = qCard.get(id);
    if (!card) return { id, error: 'NO SUCH CARD' };
    const marks = qMarks.all(id);
    const med = (() => {
      const xs = marks.map(m => m.price_cents).sort((a, b) => a - b);
      const m = Math.floor(xs.length / 2);
      return xs.length ? (xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) : null;
    })();
    const sales = qSales.all(id, `-${days} day`).map((s) => {
      // Judge against the SAME grade's mark when we have one (a $2.44 raw sale
      // is honest next to a $2 raw mark even if the card's PSA10 mark is $25);
      // cross-grade median is the fallback for unmarked grades.
      const ref = marks.find(m => m.grade === s.grade)?.price_cents ?? med;
      const whale = ref != null && (s.price_cents >= 4 * ref || s.price_cents <= ref / 4);
      let resolved = null;
      const frag = /^(?:0x[0-9a-fA-F]+):(.+)$/.exec(s.external_id ?? '')?.[1];
      if (frag && (s.source === 'courtyard' || s.source === 'base')) {
        const hits = qMint.all(frag);
        resolved = hits.length === 1 ? hits[0] : hits.length > 1 ? { ambiguous: hits.length } : { missing: true };
      }
      return { ...s, whale, resolved };
    });
    return { id, card, medianMarkCents: med, sales, lineup: qLineup.all(id) };
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
  for (const c of saleSuspects(db, ids, { days })) {
    console.log(`== ${c.id} ==`);
    if (c.error) { console.log(`  ${c.error}\n`); continue; }
    console.log(`  card: "${c.card.name}" · ${c.card.set_name ?? '?'} #${c.card.number ?? '?'} · variant "${c.card.variant}" · ${c.card.language ?? 'English'} · median mark ${usd(c.medianMarkCents)}`);
    for (const s of c.sales) {
      const tag = s.whale ? ' 🐳 WHALE' : '';
      const out = s.is_outlier ? ' · outlier-flagged' : '';
      let who = '';
      if (s.resolved?.item_name != null) {
        const drift = s.resolved.card_id !== c.id ? ` · registry NOW says ${s.resolved.card_id} (sale row never re-pointed)` : '';
        who = `\n        sold item: "${s.resolved.item_name}" · registry grade ${s.resolved.grade ?? '?'}${drift}`;
      } else if (s.resolved?.missing) who = '\n        sold item: (tokenId not in registry — pre-registry sale)';
      else if (s.resolved?.ambiguous) who = `\n        sold item: ambiguous mint prefix (${s.resolved.ambiguous} hits)`;
      console.log(`  sale ${s.grade.padEnd(7)} ${usd(s.price_cents).padStart(9)} · ${String(s.sold_at).slice(0, 10)} · ${s.source}${out}${tag}${who}`);
    }
    if (c.sales.some(s => s.whale && !s.resolved?.item_name)) {
      console.log(`  lineup — every registry item currently attributed to this card (the intruder is in here):`);
      for (const r of c.lineup) console.log(`    [${r.platform}] "${r.item_name}" · grade ${r.grade ?? '?'} · ${r.mint.slice(0, 10)}…`);
      if (!c.lineup.length) console.log('    (none — attribution happened without a registry row)');
    }
    console.log('');
  }
  console.log('Next: whale sales whose sold-item name is a different card/variant get re-pointed or outlier-flagged; then oracle:refresh un-poisons the solds marks.');
}
