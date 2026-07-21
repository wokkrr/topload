/**
 * PSA pop-count indexer (roadmap layer 4) — cert-driven.
 *
 * We hold PSA cert numbers on 1,000+ live listings. Each GetByCertNumber call
 * returns BOTH the population (TotalPopulation / PopulationHigher at the
 * cert's grade) AND the card's full identity (Brand/CardNumber/Subject/
 * Variety/SpecID) — so every call feeds two layers: pop_counts on the spine,
 * and the psa_certs archive that later powers cert-based identification of
 * number-only listings.
 *
 *   npm run psa:pop            # spend today's budget on the top-priority certs
 *   PSA_DAILY_BUDGET=100 …     # raise when the API tier is upgraded
 *
 * QUOTA REALITY (probed live 2026-07-21): the free tier allows **1 call/day**
 * ("API calls quota exceeded! maximum admitted 1 per Day"). Default budget is
 * therefore 1; the design assumes an eventual paid tier — priority order
 * makes even the trickle worthwhile (most expensive listed slabs first).
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const BASE = 'https://api.psacard.com/publicapi';

/** Pure: PSACert payload → {grade, pop} rows + archive record. Fixture-tested
 *  against the live 2026-07-21 response shape. */
export function mapCert(psaCert) {
  if (!psaCert?.CertNumber) return null;
  const gm = /([0-9]+(?:\.[0-9])?)/.exec(psaCert.CardGrade ?? '');
  const grade = gm ? `PSA${parseFloat(gm[1])}` : null;
  return {
    cert: String(psaCert.CertNumber),
    spec_id: psaCert.SpecID != null ? String(psaCert.SpecID) : null,
    grade,
    label: [psaCert.Year, psaCert.Brand, psaCert.CardNumber ? `#${psaCert.CardNumber}` : null,
            psaCert.Subject, psaCert.Variety].filter(Boolean).join(' '),
    pop: Number.isFinite(psaCert.TotalPopulation) ? psaCert.TotalPopulation : null,
    pop_higher: Number.isFinite(psaCert.PopulationHigher) ? psaCert.PopulationHigher : null,
  };
}

/**
 * Priority: PSA-graded listings whose certs we've never looked up (or are
 * >60d stale), most expensive first — the slabs users actually look at.
 */
export function pickCerts(db, budget) {
  return db.prepare(
    `SELECT g.cert, g.card_id, MAX(g.price_cents) price
     FROM gacha_listings g
     LEFT JOIN psa_certs p ON p.cert = g.cert
     WHERE g.cert IS NOT NULL AND g.grade LIKE 'PSA%'
       AND (p.cert IS NULL OR p.fetched_at < date('now', '-60 days'))
     GROUP BY g.cert
     ORDER BY price DESC
     LIMIT ?`
  ).all(budget);
}

export async function runPsaPop(db, { budget = Number(process.env.PSA_DAILY_BUDGET ?? 1), fetchImpl = timedFetch, token = process.env.PSA_API_TOKEN } = {}) {
  const summary = { budget, attempted: 0, stored: 0, quotaHit: false, errors: 0 };
  if (!token) { console.warn('[psa:pop] PSA_API_TOKEN not set — skipping'); return summary; }
  const targets = pickCerts(db, budget);
  const today = new Date().toISOString().slice(0, 10);

  const insPop = db.prepare(
    `INSERT OR REPLACE INTO pop_counts (source, card_id, grade, count, higher_count, as_of)
     VALUES ('psa', ?, ?, ?, ?, ?)`
  );
  const insCert = db.prepare(
    `INSERT OR REPLACE INTO psa_certs (cert, spec_id, card_id, grade, label, raw, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const t of targets) {
    summary.attempted++;
    try {
      const res = await fetchImpl(`${BASE}/cert/GetByCertNumber/${t.cert}`, { headers: { authorization: `bearer ${token}` } });
      if (res.status === 429) { summary.quotaHit = true; console.warn('[psa:pop] daily quota exhausted — stopping'); break; }
      if (!res.ok) { summary.errors++; continue; }
      const mapped = mapCert((await res.json())?.PSACert);
      if (!mapped) { summary.errors++; continue; }
      insCert.run(mapped.cert, mapped.spec_id, t.card_id ?? null, mapped.grade, mapped.label,
                  JSON.stringify({ pop: mapped.pop, pop_higher: mapped.pop_higher }), today);
      // Pop attaches to OUR card identity when the listing is matched; the
      // cert archive keeps identity regardless (future cert-based matching).
      if (t.card_id && mapped.grade && mapped.pop != null) {
        insPop.run(t.card_id, mapped.grade, mapped.pop, mapped.pop_higher, today);
        summary.stored++;
      }
    } catch (e) { summary.errors++; console.warn(`[psa:pop] ${t.cert}: ${e.message}`); }
  }
  console.log('[psa:pop]', JSON.stringify(summary));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPsaPop(openDb()).catch(e => { console.error(e); process.exit(1); });
}
