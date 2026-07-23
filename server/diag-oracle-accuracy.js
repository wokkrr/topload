/**
 * Oracle accuracy backtest (Kaleb, 2026-07-23: "I still have no idea how
 * accurate our price oracle actually is so that's one that I want to make
 * sure we continue to monitor for accuracy.")
 *
 * Method — the honest one: for every verified sale in the window, look up
 * the Oracle price for that (card, grade) as of the day BEFORE the sale
 * (never same-day: a sale must not grade the mark it just moved), and
 * measure the miss. Real sales are the exam; the Oracle can't study for it.
 *
 * Reported per slice (all / by IP / by basis / by price band):
 *   scored     — sales where a prior-day mark existed
 *   coverage   — scored / eligible sales (a mark we couldn't score is a gap)
 *   MdAPE      — median absolute % error (the headline; robust to whales)
 *   bias       — median signed % error (+ = Oracle prices HIGH vs realized)
 *   within 10/25% — share of sales landing inside those bands
 *
 * Read-only. Run:  node server/diag-oracle-accuracy.js [--days=60]
 */
import { openDb } from './db.js';

export function oracleAccuracy(db, { days = 60 } = {}) {
  const rows = db.prepare(`
    SELECT s.card_id, s.grade, s.price_cents AS sale_cents, date(s.sold_at) AS sold_on, s.source, c.ip,
           (SELECT o.price_cents FROM oracle_prices o
             WHERE o.card_id = s.card_id AND o.grade = s.grade AND o.as_of < date(s.sold_at)
             ORDER BY o.as_of DESC LIMIT 1) AS oracle_cents,
           (SELECT o.basis FROM oracle_prices o
             WHERE o.card_id = s.card_id AND o.grade = s.grade AND o.as_of < date(s.sold_at)
             ORDER BY o.as_of DESC LIMIT 1) AS basis
    FROM sales s JOIN cards c ON c.id = s.card_id
    WHERE s.is_outlier = 0 AND s.price_cents >= 200
      AND date(s.sold_at) >= date('now', ?)`).all(`-${days} day`);

  const scored = rows.filter(r => r.oracle_cents != null && r.oracle_cents > 0)
    .map(r => ({ ...r, err: (r.sale_cents - r.oracle_cents) / r.oracle_cents }));

  const med = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const stat = (subset) => {
    if (!subset.length) return null;
    const abs = subset.map(r => Math.abs(r.err));
    return {
      scored: subset.length,
      mdape: +(med(abs) * 100).toFixed(1),
      bias: +(med(subset.map(r => r.err)) * 100).toFixed(1),
      within10: +((subset.filter(r => Math.abs(r.err) <= 0.10).length / subset.length) * 100).toFixed(0),
      within25: +((subset.filter(r => Math.abs(r.err) <= 0.25).length / subset.length) * 100).toFixed(0),
    };
  };
  const band = (c) => c < 5_000 ? '<$50' : c < 50_000 ? '$50-500' : '$500+';
  const groupBy = (keyFn) => {
    const out = {};
    for (const r of scored) (out[keyFn(r)] ??= []).push(r);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, stat(v)]));
  };

  return {
    windowDays: days,
    eligibleSales: rows.length,
    coveragePct: rows.length ? +((scored.length / rows.length) * 100).toFixed(1) : null,
    all: stat(scored),
    byIp: groupBy(r => r.ip),
    byBasis: groupBy(r => r.basis ?? '?'),
    // THE VENUE QUESTION (Kaleb, 2026-07-23): "what others are valuing the
    // slab as vs what the realistic market value would be if you tried to
    // sell on open market." Our solds are venue sales; our externals are
    // largely eBay-derived. Positive bias on a venue = that venue realizes
    // ABOVE our blended mark (venue premium); the spread between venue
    // slices IS the appraisal-vs-realizable gap, measured.
    bySource: groupBy(r => r.source ?? '?'),
    byPriceBand: groupBy(r => band(r.sale_cents)),
    worstMisses: [...scored].sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 8)
      .map(r => ({ card: r.card_id, grade: r.grade, sold: `$${(r.sale_cents/100).toFixed(0)}`,
                   oracle: `$${(r.oracle_cents/100).toFixed(0)}`, errPct: +(r.err * 100).toFixed(0), on: r.sold_on })),
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 60);
  const r = oracleAccuracy(openDb(), { days });
  console.log(`== ORACLE ACCURACY BACKTEST (${days}d) ==`);
  console.log(`eligible sales: ${r.eligibleSales} · scored: ${r.all?.scored ?? 0} (coverage ${r.coveragePct}%)`);
  if (r.all) {
    console.log(`ALL: MdAPE ${r.all.mdape}% · bias ${r.all.bias > 0 ? '+' : ''}${r.all.bias}% · within 10%: ${r.all.within10}% · within 25%: ${r.all.within25}%`);
    console.log('\nBY TCG:');
    for (const [k, v] of Object.entries(r.byIp)) console.log(`  ${k.padEnd(5)} scored ${String(v.scored).padStart(5)} · MdAPE ${v.mdape}% · bias ${v.bias > 0 ? '+' : ''}${v.bias}% · ≤10%: ${v.within10}% · ≤25%: ${v.within25}%`);
    console.log('BY BASIS (solds-backed vs external estimate):');
    for (const [k, v] of Object.entries(r.byBasis)) console.log(`  ${k.padEnd(9)} scored ${String(v.scored).padStart(5)} · MdAPE ${v.mdape}% · bias ${v.bias > 0 ? '+' : ''}${v.bias}%`);
    console.log('BY SALES VENUE (bias here = venue premium/discount vs the blended mark):');
    for (const [k, v] of Object.entries(r.bySource)) console.log(`  ${k.padEnd(14)} scored ${String(v.scored).padStart(5)} · MdAPE ${v.mdape}% · bias ${v.bias > 0 ? '+' : ''}${v.bias}%`);
    console.log('BY PRICE BAND:');
    for (const [k, v] of Object.entries(r.byPriceBand)) console.log(`  ${k.padEnd(8)} scored ${String(v.scored).padStart(5)} · MdAPE ${v.mdape}% · bias ${v.bias > 0 ? '+' : ''}${v.bias}%`);
    console.log('\nWORST MISSES (investigate — bad match? variant? stale mark?):');
    for (const w of r.worstMisses) console.log(`  ${w.errPct > 0 ? '+' : ''}${w.errPct}%  ${w.card} ${w.grade} · sold ${w.sold} vs oracle ${w.oracle} on ${w.on}`);
  } else {
    console.log('No scoreable sales in window.');
  }
}
