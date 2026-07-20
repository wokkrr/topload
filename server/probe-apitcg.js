/** Find the right apitcg game slug + card shape. node server/probe-apitcg.js */
const key = process.env.APITCG_API_KEY;
if (!key) { console.error('APITCG_API_KEY not set'); process.exit(1); }
const BASE = 'https://apitcg.com/api';

const slugs = ['onepiece', 'one-piece', 'one_piece', 'op', 'pokemon', 'pokémon', 'digimon', 'dragon-ball-fusion', 'unionarena'];

for (const slug of slugs) {
  try {
    const res = await fetch(`${BASE}/${slug}/cards?limit=1`, { headers: { 'x-api-key': key } });
    const body = await res.text();
    let json = null; try { json = JSON.parse(body); } catch {}
    const list = json?.data ?? json?.cards ?? (Array.isArray(json) ? json : []);
    if (json && !json.error && list.length) {
      console.log(`\n✓ ${slug} → HTTP ${res.status}`);
      console.log('  top keys:', Object.keys(json), '| total:', json.totalCount ?? json.total ?? '?');
      console.log('  card fields:', Object.keys(list[0]));
      console.log('  sample:', JSON.stringify(list[0], null, 1).slice(0, 1500));
    } else {
      console.log(`✗ ${slug} → ${res.status} ${json?.error ? JSON.stringify(json.error).slice(0, 50) : body.slice(0, 40)}`);
    }
  } catch (e) { console.log(`✗ ${slug} → ERR ${String(e.message).slice(0, 40)}`); }
}
