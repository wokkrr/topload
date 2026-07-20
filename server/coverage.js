/**
 * Coverage audit — makes data gaps VISIBLE instead of silent. The north star
 * is "the data terminal for everything trading cards", so anything we carry
 * but can't match to a tracked card is a crack to see, not to ignore.
 *
 * Run:  npm run coverage           (all platforms)
 *       npm run coverage -- mnstr  (one platform)
 *
 * Prints, per platform: listings, matched %, and the biggest UNMATCHED
 * buckets (by set) per franchise — i.e. exactly what to fix or catalogue next.
 */
import { openDb } from './db.js';

const db = openDb();
const only = process.argv[2] ?? null;

const platforms = db.prepare(
  `SELECT platform, COUNT(*) n, SUM(card_id IS NOT NULL) matched
   FROM gacha_listings ${only ? 'WHERE platform = ?' : ''}
   GROUP BY platform ORDER BY n DESC`
).all(...(only ? [only] : []));

// Derive a rough "set" bucket from unmatched titles: the run of words between
// the year and the grade token, minus card-specific tail — coarse but enough
// to see which SETS we're missing (the actionable unit).
function setBucket(title) {
  const t = (title ?? '').replace(/\bpsa|cgc|bgs|sgc|beckett|ace\b.*$/i, '');
  const m = t.match(/\b(19|20)\d\d\b\s+(.*)/);
  const body = (m ? m[2] : t).toLowerCase();
  // keep the first ~5 words as the set signature
  return body.split(/\s+/).slice(0, 5).join(' ').trim() || '(unknown)';
}

console.log('\n=== Topload coverage audit ===\n');
let totN = 0, totM = 0;
for (const p of platforms) {
  totN += p.n; totM += p.matched;
  const pct = p.n ? Math.round((p.matched / p.n) * 100) : 0;
  console.log(`${p.platform.toUpperCase().padEnd(16)} ${String(p.matched).padStart(5)}/${String(p.n).padEnd(5)} matched  (${pct}%)`);

  // Unmatched buckets per IP for this platform
  const un = db.prepare(
    `SELECT category, item_name FROM gacha_listings
     WHERE platform = ? AND card_id IS NULL`
  ).all(p.platform);
  if (!un.length) continue;
  const byCat = {};
  for (const r of un) {
    const cat = r.category ?? '?';
    (byCat[cat] ??= {});
    const b = setBucket(r.item_name);
    byCat[cat][b] = (byCat[cat][b] ?? 0) + 1;
  }
  for (const [cat, buckets] of Object.entries(byCat)) {
    const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const catTotal = Object.values(buckets).reduce((a, b) => a + b, 0);
    console.log(`   ${cat} — ${catTotal} unmatched, top sets:`);
    for (const [set, n] of top) console.log(`      ${String(n).padStart(3)}  ${set}`);
  }
  console.log('');
}
const totPct = totN ? Math.round((totM / totN) * 100) : 0;
console.log(`${'ALL'.padEnd(16)} ${String(totM).padStart(5)}/${String(totN).padEnd(5)} matched  (${totPct}%)\n`);
