/**
 * Data client — the only place the UI touches the network.
 * Everything renders from these four calls; swap the API without touching UI.
 */

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export const api = {
  /** [{index_id, series:[{as_of, value}]}] — normalized to 100 at window start */
  indexes: (days = 90) => get(`/api/indexes?days=${days}`),
  /** top |Δ| movers with confidence */
  movers: (window = 1) => get(`/api/movers?window=${window}`),
  /** current basket membership with marks */
  basket: (index = 'PKMN') => get(`/api/basket?index=${index}`),
  /** gacha listings with grade-matched oracle comps */
  gacha: () => get('/api/gacha'),
  /** aggregator platform coverage map */
  platforms: () => get('/api/platforms'),
  /** screener: all tracked cards with latest marks */
  cards: (ip) => get(`/api/cards${ip ? `?ip=${ip}` : ''}`),
  /** card meta + latest mark per grade */
  card: (id) => get(`/api/cards/${encodeURIComponent(id)}`),
  /** oracle mark history for one card */
  cardSeries: (id, grade = 'raw', days = 90) =>
    get(`/api/cards/${encodeURIComponent(id)}/series?grade=${grade}&days=${days}`),
};

export const fmtUsd = (cents) =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const fmtPct = (p) =>
  p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
