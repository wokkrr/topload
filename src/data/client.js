/**
 * Data client — the only place the UI touches the network.
 * Everything renders from these four calls; swap the API without touching UI.
 */

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
  /** live asks under the oracle mark (grade-matched, deduped, banded) */
  deals: (limit = 15) => get(`/api/deals?limit=${limit}`),
  /** gacha listings with grade-matched oracle comps */
  gacha: () => get('/api/gacha'),
  /** aggregator platform coverage map */
  platforms: () => get('/api/platforms'),
  /** screener: tracked cards with latest marks (q/ip/grade/sort filters) */
  cards: ({ q, ip, grade, sort, limit } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (ip) p.set('ip', ip);
    if (grade) p.set('grade', grade);
    if (sort) p.set('sort', sort);
    if (limit) p.set('limit', limit);
    const qs = p.toString();
    return get(`/api/cards${qs ? `?${qs}` : ''}`);
  },
  /** card meta + latest mark per grade */
  card: (id) => get(`/api/cards/${encodeURIComponent(id)}`),
  /** oracle mark history for one card */
  cardSeries: (id, grade = 'raw', days = 90) =>
    get(`/api/cards/${encodeURIComponent(id)}/series?grade=${grade}&days=${days}`),
  /** recent raw solds for one card */
  cardSales: (id) => get(`/api/cards/${encodeURIComponent(id)}/sales`),
  /** global on-chain sales tape */
  recentSales: () => get('/api/sales/recent'),
  /** Binder: bulk live values for locally-stored positions */
  binderMarks: (positions) => post('/api/binder/marks', { positions }),
};

/** Marketplace display names — no chain/crypto jargon on user surfaces. */
export const PLATFORM_LABELS = {
  collectorcrypt: 'Collector Crypt',
  beezie: 'Beezie',
  phygitals: 'Phygitals',
  courtyard: 'Courtyard',
  mnstr: 'MNSTR',
};

export const fmtUsd = (cents) =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const fmtPct = (p) =>
  p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
