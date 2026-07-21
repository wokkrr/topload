/** What image fields does MNSTR's collection API actually carry? (Back-image
 *  hunt — their site shows slab backs; we only capture `image`.)
 *  node server/probe-mnstr-images.js   (droplet) */
import { timedFetch } from './net.js';
const res = await timedFetch('https://api.mnstr.xyz/mnstr/collection', { headers: { 'User-Agent': 'Mozilla/5.0' } });
const cards = (await res.json())?.data ?? [];
console.log(`fetched ${cards.length}\n--- all keys of card[0] ---`);
console.log(Object.keys(cards[0] ?? {}).join(', '));
console.log('\n--- image-ish fields on 3 samples ---');
for (const c of cards.slice(0, 3)) {
  const img = Object.fromEntries(Object.entries(c).filter(([k, v]) =>
    /image|img|photo|media|picture|back|front|url/i.test(k) || (typeof v === 'string' && /https?:\/\//.test(v))));
  console.log(JSON.stringify({ title: c.title?.slice(0, 40), ...img }, null, 1));
}
