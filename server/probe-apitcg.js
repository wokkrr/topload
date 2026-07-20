/**
 * Probe apitcg card shape. Run on the server:
 *   node server/probe-apitcg.js one-piece
 */
const game = process.argv[2] ?? 'one-piece';
const key = process.env.APITCG_API_KEY;
if (!key) { console.error('APITCG_API_KEY not set'); process.exit(1); }
const BASE = 'https://apitcg.com/api';

const queries = [
  `/${game}/cards`,
  `/${game}/cards?limit=3`,
  `/${game}/cards?page=1&limit=3`,
  `/${game}/cards?name=luffy`,
  `/${game}/cards?property=name&value=luffy`,
  `/${game}/cards?code=OP01-001`,
  `/${game}/sets`,
];

for (const path of queries) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': key } });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    console.log(`\n=== ${path} → HTTP ${res.status} ===`);
    if (!json) { console.log('  non-JSON:', body.slice(0, 100).replace(/\s+/g, ' ')); continue; }
    if (json.error) { console.log('  error:', JSON.stringify(json.error).slice(0, 200)); continue; }
    const list = json.data ?? json.cards ?? (Array.isArray(json) ? json : []);
    console.log('  top keys:', Object.keys(json), '| page count:', list.length, '| total:', json.totalCount ?? json.total ?? '?');
    if (list[0]) {
      console.log('  card fields:', Object.keys(list[0]));
      console.log('  sample:', JSON.stringify(list[0], null, 1).slice(0, 1400));
      break;
    }
  } catch (e) { console.log(`\n=== ${path} → ERR ${String(e.message).slice(0, 60)} ===`); }
}
