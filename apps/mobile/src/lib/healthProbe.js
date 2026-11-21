// One request to the backend's unauthenticated GET /health, to find out whether the server answers. Pure apart from `fetch`, which is injected.
//
// What a good answer proves: the server process is up and the path to it works. It does NOT prove the database or any other dependency is
// healthy (/health only reports that the process runs), so the network service calls this "reachable", never "healthy", and a real API call
// that fails with a 5xx is still shown as that call's own failure.
//
// It sends no token and no body, goes straight to fetch (never through api.js: no session wait, no recursion), and never throws.
//   { ok: true,  status: 200, ms }                      answered with 2xx
//   { ok: false, status: 502, ms }                      answered, but not OK
//   { ok: false, timedOut: false, ms }                  no answer (network)
//   { ok: false, timedOut: true,  ms }                  no answer within the time limit
export const PROBE_TIMEOUT_MS = 6000;

// probe({ timeoutMs }) overrides the limit for ONE call (the recovery probes after a link-up use a short one); probe() keeps the default.
export function createHealthProbe({ baseUrl, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, now = () => Date.now() }) {
  return async function probe(options) {
    const limit = options && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : timeoutMs;
    const started = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
    try {
      const doFetch = fetchImpl || globalThis.fetch;
      const res = await doFetch(`${baseUrl}/health`, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
      return { ok: !!res.ok, status: res.status, ms: now() - started };
    } catch {
      return { ok: false, timedOut, ms: now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
}
