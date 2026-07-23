import { describe, it, expect } from 'vitest';
import { fetchPcCsv } from '../import-pc-retry.js';

const CSV = 'id,product-name,console-name,loose-price\n1,Pikachu #25,Pokemon Base Set,100\n';
const ok = (body) => Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
const http = (status) => Promise.resolve({ ok: false, status });

describe('fetchPcCsv — the 2026-07-23 half-failed-mint hardening', () => {
  it('retries through 503s and timeouts, then succeeds', async () => {
    let calls = 0;
    const naps = [];
    const text = await fetchPcCsv('u', {
      attempts: 4, backoffMs: 1000, sleepImpl: (ms) => { naps.push(ms); return Promise.resolve(); }, log: () => {},
      fetchImpl: () => { calls++; return calls === 1 ? http(503) : calls === 2 ? Promise.reject(new Error('aborted')) : ok(CSV); },
    });
    expect(text).toBe(CSV);
    expect(calls).toBe(3);
    expect(naps).toEqual([1000, 2000]);   // linear backoff
  });
  it('gives up after N attempts with the last error', async () => {
    let calls = 0;
    await expect(fetchPcCsv('u', {
      attempts: 3, backoffMs: 1, sleepImpl: () => Promise.resolve(), log: () => {},
      fetchImpl: () => { calls++; return http(429); },
    })).rejects.toThrow('HTTP 429');
    expect(calls).toBe(3);
  });
  it('rejects payloads that are not a price-guide CSV (login page, error HTML)', async () => {
    await expect(fetchPcCsv('u', {
      attempts: 1, log: () => {},
      fetchImpl: () => ok('<html>please sign in</html>'),
    })).rejects.toThrow('not a price-guide CSV');
  });
});
