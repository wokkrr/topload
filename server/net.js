/**
 * timedFetch — fetch with a hard timeout. Node's fetch has NO default timeout,
 * so one dead TCP connection can hang an indexer forever. Live incident
 * (2026-07-20): the 18:00 UTC ingest froze ~70 minutes inside the MNSTR sales
 * step (0 CPU, WAL static) on a hung network call, blocking the oracle refresh
 * behind it. Every network-facing module now defaults its fetchImpl to this.
 *
 * A caller-supplied AbortSignal still wins (signals compose via .any).
 */
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 30_000);

export function timedFetch(url, opts = {}) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  return fetch(url, { ...opts, signal });
}
