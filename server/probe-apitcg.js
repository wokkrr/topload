/**
 * Probe apitcg.com card shape (One Piece by default) so the catalog adapter
 * is built from real fields. Run on the server (no CORS):
 *   APITCG_API_KEY=... node server/probe-apitcg.js one-piece luffy
 */
const game = process.argv[2] ?? 'one-piece';
const q = process.argv[3] ?? 'luffy';
const key = process.env.APITCG_API_KEY;
if (!key) { console.error('APITCG_API_KEY not set'); process.exit(1); }

const res = await fetch(`https://api.apitcg.com/api/${game}/cards?name=${encodeURIComponent(q)}&limit=3`, {
  headers: { 'x-api-key': key },
});
console.log('HTTP', res.status);
const json = await res.json();
console.log('top-level keys:', Object.keys(json));
const list = json.data ?? json.cards ?? (Array.isArray(json) ? json : []);
console.log('count in page:', list.length, '| total:', json.totalCount ?? json.total ?? json.count ?? '?');
if (list[0]) {
  console.log('card field names:', Object.keys(list[0]));
  console.log('sample card:', JSON.stringify(list[0], null, 1).slice(0, 1200));
}
