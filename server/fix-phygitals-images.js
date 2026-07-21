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
   WHERE platform = 'phygitals' AND (image LIKE '%gateway.irys.xyz%' OR image LIKE '%-cropped')`
).all();
const upd = db.prepare(`UPDATE gacha_listings SET image = ? WHERE platform = ? AND external_id = ?`);
let n = 0;
for (const r of rows) {
  // Gateway URLs → their CDN (plain); stored '-cropped' URLs → plain.
  const plain = r.image.includes('gateway.irys.xyz') ? fixImageUrl(r.image) : r.image.replace(/-cropped$/, '');
  if (plain !== r.image) { upd.run(plain, r.platform, r.external_id); n++; }
}
console.log(`[fix-phygitals-images] rewrote ${n} of ${rows.length} gateway URLs`);
