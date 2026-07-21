/**
 * One-off repair: existing Courtyard rows carry the 3D pedestal render.
 * The HQ scans live at a constructible URL — static.courtyard.io/
 * graded-cards-scans/<GRADER>%20<serial>/slab_front|back.jpg (verified live
 * 2026-07-21) — built from the grader (grade prefix) + cert we already store.
 * Each candidate URL is VERIFIED with a request before replacing anything;
 * rows that don't verify keep their render. Idempotent; safe re-runs.
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const db = openDb();
const rows = db.prepare(
  `SELECT external_id, grade, cert FROM gacha_listings
   WHERE platform = 'courtyard' AND cert IS NOT NULL
     AND image LIKE '%graded-cards-renders%'`
).all();
const upd = db.prepare(
  `UPDATE gacha_listings SET image = ?, image_back = ? WHERE platform = 'courtyard' AND external_id = ?`
);
let fixed = 0, skipped = 0;
for (const r of rows) {
  const grader = /^([A-Z]+)/.exec(r.grade ?? '')?.[1];
  if (!grader || grader === 'RAW') { skipped++; continue; }
  const base = `https://static.courtyard.io/graded-cards-scans/${grader}%20${r.cert}`;
  try {
    const head = await timedFetch(`${base}/slab_front.jpg`, { method: 'HEAD' });
    if (!head.ok) { skipped++; continue; }
    upd.run(`${base}/slab_front.jpg`, `${base}/slab_back.jpg`, r.external_id);
    fixed++;
  } catch { skipped++; }
}
console.log(`[fix-courtyard-images] upgraded ${fixed} to HQ scans, ${skipped} kept renders (of ${rows.length})`);
