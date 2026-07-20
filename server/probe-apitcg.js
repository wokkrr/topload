/**
 * Probe apitcg card shape. Run on the server (no CORS):
 *   node server/probe-apitcg.js one-piece luffy
 * Tries the known host variants and reports which returns valid card JSON.
 */
const game = process.argv[2] ?? 'one-piece';
const q = process.argv[3] ?? 'luffy';
const key = process.env.APITCG_API_KEY;
if (!key) { console.error('APITCG_API_KEY not set'); process.exit(1); }

const bases = [
  'https://www.apitcg.com/api',
  'https://apitcg.com/api',
  'https://api.apitcg.com/api',
];

for (const base of bases) {
  const url = `${base}/${game}/cards?name=${encodeURIComponent(q)}&limit=3`;
  try {
    const res = await fetch(url, { headers: { 'x-api-key': key }, redirect: 'follow' });
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    console.log(`\n=== ${base} → HTTP ${res.status} (${ct.slice(0, 30)}) ===`);
    if (!ct.includes('json')) { console.log('  (non-JSON:', body.slice(0, 80).replace(/\s+/g, ' '), ')'); continue; }
    const json = JSON.parse(body);
    console.log('  top-level keys:', Object.keys(json));
    const list = json.data ?? json.cards ?? (Array.isArray(json) ? json : []);
    console.log('  page count:', list.length, '| total:', json.totalCount ?? json.total ?? json.count ?? '?');
    if (list[0]) {
      console.log('  card field names:', Object.keys(list[0]));
      console.log('  sample card:', JSON.stringify(list[0], null, 1).slice(0, 1400));
    }
    if (list.length) break; // found the working host
  } catch (e) {
    console.log(`\n=== ${base} → ERROR ${String(e.message).slice(0, 60)} ===`);
  }
}
