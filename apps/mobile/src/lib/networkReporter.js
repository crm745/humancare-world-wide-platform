// The one-way channel from the API client to the network service. The API client (api.js) reports what each call came to; the network service
// (network.js) registers itself here. It is a separate tiny module so api.js never imports the service (and the service never imports api.js):
// no import cycle, and api.js works unchanged (a no-op) when no service is registered, as in the unit tests.
//
//   'ok'       an HTTP answer below 500 arrived: the server is reachable
//   'server'   an HTTP 5xx arrived
//   'network'  no answer (no connection)
//   'timeout'  no answer in time
let listener = null;

export const setApiOutcomeListener = (fn) => { listener = typeof fn === 'function' ? fn : null; };

export function reportApiOutcome(outcome) {
  if (!listener) return;
  try { listener(outcome); } catch { /* a faulty listener must never fail an API call */ }
}
