/**
 * PROBE (read-only): TCGdex Japanese coverage vs our artless-JP worklist.
 *
 * The art census (2026-07-22) put PKMN at 41.8% artless, and the top of the
 * by-value worklist is vintage JAPANESE (Illustrator Pikachu $214k, No Rarity
 * Charizard, Masaki Gengar, the Shinings…) — exactly what pokemontcg.io does
 * not carry. TCGdex (api.tcgdex.net) is multilingual with a `ja` locale and
 * per-card image URLs; the open question is whether its JA coverage reaches
 * VINTAGE sets (1996-2001 expansion packs, vending series, old promos) or
 * only the modern era. This probe answers that before we build the importer.
 *
 * Reports, without writing anything:
 *   1. TCGdex ja sets: count + the 30 EARLIEST by releaseDate (id, name,
 *      date, card counts) — the vintage shelf, if it exists.
 *   2. One vintage set detail: card entry shape + whether image URLs exist.
 *   3. OUR side: top artless+priced Japanese PKMN sets by value (distinct PC
 *      set names + counts) — the demand list the alias map must cover.
 *
 *   node server/probe-tcgdex.js
 */
import { openDb } from './db.js';
import { timedFetch } from './net.js';

const API = 'https://api.tcgdex.net/v2';

async function getJson(path) {
  const res = await timedFetch(`${API}${path}`, { headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`tcgdex HTTP ${res.status} for ${path}`);
  return res.json();
}

const sets = await getJson('/ja/sets');
console.log(`[tcgdex] ja sets: ${sets.length}`);

// Set list endpoint entries are {id, name, logo?, symbol?, cardCount:{total,official}}
// — releaseDate needs the detail endpoint. Sort by id heuristics is unreliable,
// so pull details for a bounded sample: all sets (the ja list is small enough
// to walk politely) with a tiny delay.
const detailed = [];
for (const s of sets) {
  try {
    const d = await getJson(`/ja/sets/${encodeURIComponent(s.id)}`);
    detailed.push({ id: s.id, name: d.name, releaseDate: d.releaseDate ?? '', total: d.cardCount?.total ?? null });
  } catch (e) {
    detailed.push({ id: s.id, name: s.name, releaseDate: '?', total: s.cardCount?.total ?? null, err: e.message.slice(0, 40) });
  }
  await new Promise(r => setTimeout(r, 120));
}
detailed.sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999'));
console.log('\n== EARLIEST 30 JA SETS (the vintage shelf) ==');
for (const d of detailed.slice(0, 30)) {
  console.log(`${(d.releaseDate || '????-??-??').padEnd(11)} ${String(d.id).padEnd(14)} ${String(d.total ?? '?').padStart(4)} cards  ${d.name}${d.err ? '  (detail err: ' + d.err + ')' : ''}`);
}

// 2. One vintage set's card shape + image availability.
const probe = detailed.find(d => (d.releaseDate || '') < '2002' && d.total) ?? detailed[0];
if (probe) {
  const d = await getJson(`/ja/sets/${encodeURIComponent(probe.id)}`);
  const cards = d.cards ?? [];
  const withImg = cards.filter(c => c.image).length;
  console.log(`\n== SAMPLE SET ${probe.id} "${d.name}" (${probe.releaseDate}) ==`);
  console.log(`cards: ${cards.length} · with image field: ${withImg}`);
  for (const c of cards.slice(0, 3)) console.log(`  ${c.localId ?? '?'} · ${c.name} · image: ${c.image ?? '(none)'}`);
  if (cards[0]?.image) console.log(`  (full art URL form: <image>/high.webp — e.g. ${cards[0].image}/high.webp)`);
}

// 3. Our demand list: artless+priced Japanese PKMN by PC set name.
const db = openDb();
const rows = db.prepare(
  `SELECT c.set_name, COUNT(*) n, SUM(v.v) value_cents
   FROM cards c
   JOIN (SELECT card_id, MAX(price_cents) v FROM latest_marks GROUP BY card_id) v ON v.card_id = c.id
   WHERE c.ip = 'PKMN' AND c.image IS NULL AND c.language = 'Japanese'
   GROUP BY c.set_name ORDER BY value_cents DESC LIMIT 25`).all();
console.log('\n== OUR ARTLESS+PRICED JAPANESE PKMN, BY PC SET NAME (alias-map demand list) ==');
for (const r of rows) {
  console.log(`$${String(Math.round((r.value_cents ?? 0) / 100)).padStart(9)}  ${String(r.n).padStart(5)} cards  ${r.set_name ?? '(no set)'}`);
}
console.log(`\n[tcgdex] probe done — read-only, nothing written.`);
