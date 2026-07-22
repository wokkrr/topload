/**
 * PROBE (read-only): collect.rip set checklists — Kaleb, 2026-07-22: "an
 * expansive set list for pokemon english and japanese broken down with
 * individual cards. Maybe you can use it in tandem for cross referencing
 * our database?"
 *
 * Role if viable: a COMPLETENESS AUDITOR for the spine — a third-party
 * checklist of what SHOULD exist per set (EN + JP, 1996-2026, ~350 sets) to
 * diff against what we have. Their set pages render the card list
 * client-side (WebFetch saw only "102 cards"), so the data lives in embedded
 * JSON (__NEXT_DATA__-style) or an API the page calls — this probe finds
 * which, and prints the per-card shape.
 *
 *   node server/probe-collectrip.js
 */
import { timedFetch } from './net.js';

const HOST = 'https://collect.rip';
const get = async (path) => {
  const r = await timedFetch(`${HOST}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'text/html,application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.text();
};

// 0. robots
const robots = await (await timedFetch(`${HOST}/robots.txt`)).text().catch(() => '');
console.log('[collectrip] robots disallows:', robots.split('\n').filter(l => /^disallow:/i.test(l.trim())).join(' | ') || '(nothing)');

// 1. Set index: count + slug shapes (EN vs JP).
const index = await get('/setlists?game=pokemon');
const slugs = [...new Set([...index.matchAll(/href="\/setlists\/([a-z0-9-]+)\/?"/g)].map(m => m[1]))];
const jp = slugs.filter(s => s.endsWith('-pokemon-japan'));
console.log(`[collectrip] set slugs: ${slugs.length} total · ${jp.length} japan · ${slugs.length - jp.length} other`);
console.log('  samples:', slugs.slice(0, 6).join(' · '));
console.log('  jp samples:', jp.slice(0, 6).join(' · '));

// 2. One set page: find where the card data lives.
await new Promise(r => setTimeout(r, 600));
const page = await get('/setlists/base-set-pokemon/');
console.log(`\n[collectrip] base-set page: ${page.length} bytes`);
// Next.js-style embedded state?
for (const marker of ['__NEXT_DATA__', '__NUXT__', 'window.__remixContext', 'application/json']) {
  const i = page.indexOf(marker);
  if (i >= 0) console.log(`  marker '${marker}' at ${i}: …${page.slice(i, i + 220).replace(/\s+/g, ' ')}…`);
}
// API endpoints referenced in scripts?
const apis = [...new Set([...page.matchAll(/["'](\/(?:api|_next\/data)\/[^"']{0,120})["']/g)].map(m => m[1]))];
console.log(`  api-ish paths: ${apis.slice(0, 8).join(' · ') || '(none in markup)'}`);
// Card-looking JSON inline?
const cardish = [...page.matchAll(/[^\n]{0,50}(?:"card_?(?:name|number)"|"number":"|"cards":\[)[^\n]{0,160}/gi)].slice(0, 4);
for (const c of cardish) console.log(`  cardish: ${c[0].trim().slice(0, 190)}`);

// 3. The shell is a 3.6KB SPA (live 2026-07-22) — the data endpoint lives in
//    the JS bundle. Fetch the scripts the shell references and grep them for
//    endpoint strings.
const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
console.log(`\n[collectrip] shell scripts: ${scripts.join(' · ') || '(none)'}`);
for (const src of scripts.slice(0, 3)) {
  await new Promise(r => setTimeout(r, 600));
  try {
    const js = await get(src.startsWith('http') ? src.replace(HOST, '') : src);
    console.log(`\n[collectrip] bundle ${src} (${js.length} bytes) — endpoint candidates:`);
    const eps = [...new Set([
      ...[...js.matchAll(/["'`](\/[a-z0-9_/-]{2,60}(?:api|cards|sets|setlist)[a-z0-9_/${}.-]{0,60})["'`]/gi)].map(m => m[1]),
      ...[...js.matchAll(/["'`](https?:\/\/[^"'`]{8,110})["'`]/g)].map(m => m[1]).filter(u => /api|supabase|firebase|firestore|graphql|cdn|\.json/i.test(u)),
    ])];
    for (const e of eps.slice(0, 20)) console.log(`  ${e}`);
    // fetch()/axios call sites with a little context
    for (const m of [...js.matchAll(/[^\n]{0,40}fetch\([^\n]{0,120}/g)].slice(0, 6)) {
      console.log(`  fetch: ${m[0].replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  } catch (e) { console.log(`  bundle fetch failed: ${e.message}`); }
}
// 4. v3 (2026-07-22): the bundle exposed https://api.collect.rip + /all-sets.
//    Hit it, learn the set shape, then find/guess the per-set cards route.
const api = async (path) => {
  const r = await timedFetch(`https://api.collect.rip${path}`, { headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json', origin: HOST, referer: `${HOST}/` } });
  return { status: r.status, text: r.ok ? await r.text() : '' };
};
await new Promise(r => setTimeout(r, 600));
const all = await api('/all-sets');
console.log(`\n[collectrip] GET api.collect.rip/all-sets → ${all.status} · ${all.text.length} bytes`);
if (all.text) {
  console.log('  head:', all.text.slice(0, 400).replace(/\s+/g, ' '));
  try {
    const j = JSON.parse(all.text);
    const arr = Array.isArray(j) ? j : j.sets ?? j.data ?? [];
    console.log(`  entries: ${arr.length} · first entry keys: ${Object.keys(arr[0] ?? {}).join(', ')}`);
    console.log('  first entry:', JSON.stringify(arr[0]).slice(0, 300));
    // Guess per-set card routes from the first entry's identifiers.
    const s0 = arr.find(s => /base.?set/i.test(JSON.stringify(s))) ?? arr[0];
    const idents = [s0?.slug, s0?.id, s0?.set_id].filter(Boolean);
    for (const idn of idents) {
      for (const shape of [`/set/${idn}`, `/sets/${idn}`, `/set-cards/${idn}`, `/cards?set=${idn}`, `/setlist/${idn}`]) {
        await new Promise(r => setTimeout(r, 500));
        const t = await api(shape);
        console.log(`  ${shape} → ${t.status}${t.text ? ` · ${t.text.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
        if (t.status === 200) break;
      }
      if (idents.length) break;
    }
  } catch { console.log('  (not JSON)'); }
}
// Bundle context around the all-sets literal — how the app builds sibling URLs.
try {
  const js = await get(scripts[0]);
  const i = js.indexOf('all-sets');
  if (i >= 0) console.log('\n[collectrip] bundle context @all-sets:', js.slice(Math.max(0, i - 250), i + 350).replace(/\s+/g, ' '));
} catch { /* fine */ }
console.log('\n[collectrip] probe done — read-only.');
