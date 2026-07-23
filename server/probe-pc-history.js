/**
 * PriceCharting HISTORY recon (2026-07-23, Kaleb: charts "look very weak"
 * without past price history; PC's API/CSV are current-day-only by policy —
 * "Historic prices and historic sales are not supported").
 *
 * Their product pages RENDER year-scale price charts, so the history is
 * delivered with the page. This probe fetches ONE product page (same polite
 * fetcher/robots posture as the nightly art pass) and reports: is the chart
 * data embedded, in what shape, at what cadence, and how far back?
 * RECON ONLY — nothing is ingested; informs the ask to PC + the decision.
 *
 *   node server/probe-pc-history.js [pc-product-id]   (default: a liquid card)
 */
const id = process.argv[2] ?? '959112';   // known-good pc id from our catalog
const url = `https://www.pricecharting.com/game/${id}`;

const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
console.log(`[probe] GET ${url} → HTTP ${res.status} (final: ${res.url})`);
const html = await res.text();
console.log(`[probe] page bytes: ${html.length}`);

// Known embedding patterns on PC pages over the years.
const hits = [];
for (const pat of ['VGPC', 'chart_data', 'chartData', 'price_history', 'priceHistory', 'Highcharts', 'series:', 'data:[[']) {
  const i = html.indexOf(pat);
  if (i >= 0) hits.push(`${pat} @${i}`);
}
console.log('[probe] pattern hits:', hits.length ? hits.join(' · ') : 'NONE');

// Extract the largest JS object/array near a chart_data-ish hit and summarize.
const m = /VGPC\.chart_data\s*=\s*(\{[\s\S]*?\});/.exec(html) ?? /chart_data\s*[:=]\s*(\{[\s\S]*?\})[;,]/.exec(html);
if (m) {
  try {
    const data = JSON.parse(m[1]);
    const keys = Object.keys(data);
    console.log('[probe] chart_data keys:', keys.join(', '));
    for (const k of keys.slice(0, 6)) {
      const series = data[k];
      if (Array.isArray(series) && series.length) {
        const first = series[0], last = series[series.length - 1];
        const d = (p) => Array.isArray(p) ? new Date(p[0]).toISOString().slice(0, 10) : JSON.stringify(p).slice(0, 40);
        console.log(`[probe]   ${k}: ${series.length} points · ${d(first)} → ${d(last)} · sample last: ${JSON.stringify(last)}`);
      }
    }
  } catch (e) {
    console.log('[probe] chart_data found but not plain JSON:', m[1].slice(0, 200));
  }
} else {
  // Chart may load via XHR — hunt for a fetch URL in the page JS.
  const x = /["'](\/[a-z-]*(?:chart|history)[a-z\/-]*\?[^"']*)["']/i.exec(html);
  console.log('[probe] no embedded chart_data;', x ? `possible XHR path: ${x[1]}` : 'no obvious history XHR path either');
  console.log('[probe] context around first VGPC hit:', html.slice(Math.max(0, html.indexOf('VGPC')), html.indexOf('VGPC') + 300).replace(/\s+/g, ' '));
}
