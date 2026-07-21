/**
 * One-off repair: rewrite already-ingested Phygitals image URLs from the
 * browser-hostile irys gateway to their servable CDN (see fixImageUrl in the
 * adapter — future ingests store the CDN form directly). Idempotent.
 */
import { openDb } from './db.js';
import { fixImageUrl } from './adapters/phygitals-listings.js';

const db = openDb();
const rows = db.prepare(
  `SELECT platform, external_id, image FROM gacha_listings
   WHERE platform = 'phygitals' AND image LIKE '%gateway.irys.xyz%'`
).all();
const upd = db.prepare(`UPDATE gacha_listings SET image = ? WHERE platform = ? AND external_id = ?`);
let n = 0;
for (const r of rows) {
  const fixed = fixImageUrl(r.image);
  if (fixed !== r.image) { upd.run(fixed, r.platform, r.external_id); n++; }
}
console.log(`[fix-phygitals-images] rewrote ${n} of ${rows.length} gateway URLs`);
