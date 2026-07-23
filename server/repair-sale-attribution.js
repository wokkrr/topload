/**
 * SALE-ATTRIBUTION REPAIR (Kaleb + forensics, 2026-07-23). The sale-suspect
 * run named three diseases; this is the cure for the two curable-today ones:
 *
 * PHASE 1 — REPOINT (courtyard/base sales; external_id = '<0xhash>:<tokenId…>'):
 *   nft_registry is the item-name ledger and rematch.js --listings-only
 *   re-attributes it with the CURRENT strict matcher — but sales rows keep
 *   their insert-day card_id forever. This phase re-points each resolvable
 *   sale to its registry item's current card_id/grade (exactly-one mint-prefix
 *   match required; ambiguous or missing → untouched). Run rematch FIRST so
 *   the registry is trustworthy (heals the Mewtwo-vs-Genesect sinkhole rows).
 *
 * PHASE 2 — QUARANTINE (price-implausible, e.g. pre-registry whales we can
 *   never name: Switch $1000 / Vikavolt $649 / Sada $500 raw):
 *   a non-outlier sale ≥5x above or ≤1/5 below its reference is flagged
 *   is_outlier=1 with an auditable reason — NEVER deleted (doctrine).
 *   Reference priority:
 *     1. latest same-grade EXTERNAL mark (pricecharting first, tcgplayer
 *        second) — an anchor the whale itself cannot poison. This is why the
 *        Sanji trap doesn't fool it: three matching $150 misattributed sales
 *        vote for each other, but the guide's $2.26 loose outvotes them.
 *     2. median of the card's OTHER non-outlier same-grade sales (≥3).
 *   Skipped when both sale and ref are under $20 (penny noise).
 *
 * Order matters: repoint runs first so a re-homed sale is judged (and its
 * new siblings' medians computed) on the row where it now belongs.
 *
 * AFTER a live run: npm run oracle:refresh — rebuilds marks without the
 * quarantined whales (un-poisons Sanji-class solds marks).
 *
 *   node server/repair-sale-attribution.js          # DRY RUN (default)
 *   node server/repair-sale-attribution.js --live
 */
import { openDb } from './db.js';

const usd = (c) => `$${(c / 100).toFixed(c < 1000 ? 2 : 0)}`;

export function repairSaleAttribution(db, { live = false, ratio = 5, floorCents = 2000 } = {}) {
  const res = { repointed: 0, regraded: 0, ambiguous: 0, unresolvable: 0,
                quarantined: 0, repointSamples: [], quarantineSamples: [] };

  // ---- PHASE 1: REPOINT resolvable on-chain sales to their registry item ----
  const candidates = db.prepare(
    `SELECT id, card_id, grade, price_cents, external_id, source FROM sales
     WHERE external_id LIKE '0x%:%'`).all();
  const qMint = db.prepare(`SELECT card_id, grade, item_name FROM nft_registry WHERE mint LIKE ? || '%' LIMIT 2`);
  const updSale = db.prepare(`UPDATE sales SET card_id = ?, grade = ? WHERE id = ?`);
  const moved = new Map();   // saleId → new home; lets the DRY run judge phase 2 post-repoint, same as live
  if (live) db.exec('BEGIN');
  for (const s of candidates) {
    const frag = /^0x[0-9a-fA-F]+:(.+)$/.exec(s.external_id)?.[1];
    if (!frag) continue;
    const hits = qMint.all(frag);
    if (hits.length !== 1) { res[hits.length ? 'ambiguous' : 'unresolvable']++; continue; }
    const reg = hits[0];
    if (!reg.card_id) { res.unresolvable++; continue; }
    const newGrade = reg.grade ?? s.grade;
    if (reg.card_id === s.card_id && newGrade === s.grade) continue;
    if (reg.card_id !== s.card_id) res.repointed++; else res.regraded++;
    if (res.repointSamples.length < 12) {
      res.repointSamples.push(`${usd(s.price_cents)} ${s.grade} ${s.source}: ${s.card_id} → ${reg.card_id} ${newGrade} ("${(reg.item_name ?? '').slice(0, 52)}")`);
    }
    moved.set(s.id, { card_id: reg.card_id, grade: newGrade });
    if (live) updSale.run(reg.card_id, newGrade, s.id);
  }

  // ---- PHASE 2: QUARANTINE price-implausible sales ----
  // External same-grade anchors (whale-proof): pricecharting > tcgplayer.
  const extRows = db.prepare(
    `SELECT card_id, grade, source, price_cents FROM external_marks e
     WHERE source IN ('pricecharting', 'tcgplayer')
       AND as_of = (SELECT MAX(as_of) FROM external_marks e2
                    WHERE e2.card_id = e.card_id AND e2.grade = e.grade AND e2.source = e.source)`).all();
  const ext = new Map();
  for (const r of extRows) {
    const k = `${r.card_id}|${r.grade}`;
    if (!ext.has(k) || r.source === 'pricecharting') ext.set(k, { cents: r.price_cents, name: r.source });
  }
  // Sales grouped for sibling medians — phase-1 moves applied in memory so
  // the DRY run judges the exact post-repoint world the live run would.
  const sales = db.prepare(`SELECT id, card_id, grade, price_cents, sold_at, source FROM sales WHERE is_outlier = 0`).all()
    .map(s => moved.has(s.id) ? { ...s, ...moved.get(s.id) } : s);
  const byKey = new Map();
  for (const s of sales) (byKey.get(`${s.card_id}|${s.grade}`) ?? byKey.set(`${s.card_id}|${s.grade}`, []).get(`${s.card_id}|${s.grade}`)).push(s);
  const flag = db.prepare(`UPDATE sales SET is_outlier = 1, outlier_reason = ? WHERE id = ?`);
  for (const [key, group] of byKey) {
    const anchor = ext.get(key);
    for (const s of group) {
      let refCents = anchor?.cents ?? null, refName = anchor ? `${anchor.name} mark` : null;
      if (refCents == null) {
        const others = group.filter(o => o.id !== s.id).map(o => o.price_cents).sort((a, b) => a - b);
        if (others.length >= 3) {
          const m = Math.floor(others.length / 2);
          refCents = others.length % 2 ? others[m] : (others[m - 1] + others[m]) / 2;
          refName = `median of ${others.length} sibling sales`;
        }
      }
      if (refCents == null || refCents <= 0) continue;
      if (Math.max(s.price_cents, refCents) < floorCents) continue;
      const r = s.price_cents / refCents;
      if (r < ratio && r > 1 / ratio) continue;
      res.quarantined++;
      if (res.quarantineSamples.length < 15) {
        res.quarantineSamples.push(`${usd(s.price_cents)} ${s.grade} · ${String(s.sold_at).slice(0, 10)} · ${s.source} · ${key.split('|')[0]} — ${r >= ratio ? `${r.toFixed(0)}x above` : `${(1 / r).toFixed(0)}x below`} ${refName} ${usd(refCents)}`);
      }
      if (live) flag.run(`price-implausible: ${r >= ratio ? `${r.toFixed(1)}x above` : `${(1 / r).toFixed(1)}x below`} ${refName} ${usd(refCents)} (repair 2026-07-23)`, s.id);
    }
  }
  if (live) db.exec('COMMIT');
  return res;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const live = process.argv.includes('--live');
  const res = repairSaleAttribution(openDb(), { live });
  console.log(`[repair:sale-attribution]${live ? ' LIVE' : ' DRY RUN'}`);
  console.log(`  phase 1 repoint: ${res.repointed} re-pointed · ${res.regraded} re-graded · ${res.ambiguous} ambiguous (untouched) · ${res.unresolvable} unresolvable (untouched)`);
  for (const s of res.repointSamples) console.log(`    ${s}`);
  console.log(`  phase 2 quarantine: ${res.quarantined} flagged price-implausible (is_outlier=1, never deleted)`);
  for (const s of res.quarantineSamples) console.log(`    ${s}`);
  console.log(live
    ? '  NEXT: npm run oracle:refresh — rebuild marks without the quarantined whales.'
    : '  Dry run — nothing written. Re-run with --live after reviewing samples. RUN rematch --listings-only FIRST so the registry is current.');
}
