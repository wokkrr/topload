/**
 * PSA public API probe — see the REAL response shape before wiring the pop
 * indexer (tonight's law: probe before build). Uses cert numbers we already
 * hold from live listings, so the very first calls are production-relevant.
 *
 *   PSA_API_TOKEN=... node server/probe-psa.js [certNumber]
 *
 * Run on the droplet (open egress). Defaults to a cert seen live today
 * (PSA 8 Dark Charizard on Collector Crypt). Free tier ≈100 calls/day —
 * this probe spends 1–3.
 */
import { timedFetch } from './net.js';
import { openDb } from './db.js';

const token = process.env.PSA_API_TOKEN;
if (!token) { console.error('PSA_API_TOKEN not set — add it to /opt/topload/.env'); process.exit(1); }

const BASE = 'https://api.psacard.com/publicapi';
const H = { authorization: `bearer ${token}` };

async function probe(cert) {
  console.log(`\n=== GetByCertNumber/${cert} ===`);
  const res = await timedFetch(`${BASE}/cert/GetByCertNumber/${cert}`, { headers: H });
  console.log('HTTP', res.status);
  const body = await res.text();
  try { console.log(JSON.stringify(JSON.parse(body), null, 1)); }
  catch { console.log(body.slice(0, 800)); }
}

const argCert = process.argv[2];
if (argCert) {
  await probe(argCert);
} else {
  // Pull real PSA certs from our own listings — the exact certs the indexer
  // will process. One OP + one PKMN if available.
  const db = openDb();
  const certs = db.prepare(
    `SELECT DISTINCT cert FROM gacha_listings
     WHERE cert IS NOT NULL AND grade LIKE 'PSA%' LIMIT 2`
  ).all().map(r => r.cert);
  if (!certs.length) certs.push('122217540'); // live Dark Charizard fallback
  for (const c of certs) await probe(c);
}
