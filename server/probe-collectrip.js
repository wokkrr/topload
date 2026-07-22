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

// 3. If a JSON API is guessable, try the obvious shapes.
await new Promise(r => setTimeout(r, 600));
for (const guess of ['/api/setlists/base-set-pokemon', '/setlists/base-set-pokemon.json']) {
  try {
    const t = await get(guess);
    console.log(`\n[collectrip] ${guess} → ${t.length} bytes: ${t.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`\n[collectrip] ${guess} → ${e.message}`); }
}
console.log('\n[collectrip] probe done — read-only.');
