// A circuit breaker for the one Bitrix24 portal every service queue talks to. closed -> open after repeated failures; open -> half_open after
// `openMs` (ONE probe call is let through); a successful probe closes it, a failed one re-opens it.
//   transient failures (timeouts, lost connections, 5xx)             open it after `transientThreshold` in a row (default 5)
//   blocking failures (rate limit, expired token, no permission)     open it after `blockingThreshold` in a row (default 2): retrying faster only
//                                                                    makes a rate limit or a revoked credential worse
// A refusal about one request (a bad field) never counts: it says nothing about the portal's health.
function createCircuitBreaker({ transientThreshold = 5, blockingThreshold = 2, openMs = 5 * 60 * 1000, now = Date.now } = {}) {
  let state = 'closed';
  let transient = 0;
  let blocking = 0;
  let openedAt = 0;
  let lastKind = null;
  let probing = false;

  const open = (kind) => { state = 'open'; openedAt = now(); lastKind = kind; probing = false; };

  function canPass() {
    if (state === 'closed') return true;
    if (state === 'open') {
      if (now() - openedAt < openMs) return false;
      state = 'half_open';
    }
    if (probing) return false; // half_open: one probe at a time
    probing = true;
    return true;
  }

  // Read-only: true while closed, or once the open period has passed (a probe is due). Takes no probe.
  const isClosedOrProbeDue = () => state === 'closed' || (state === 'open' && now() - openedAt >= openMs) || (state === 'half_open' && !probing);

  // A probe that was taken but never made (the rate limiter refused after the breaker said yes) is given back.
  const releaseProbe = () => { probing = false; };

  function recordSuccess() { state = 'closed'; transient = 0; blocking = 0; probing = false; lastKind = null; }

  function recordFailure(kind) {
    if (kind !== 'transient' && kind !== 'blocking') { probing = false; return; }
    if (state === 'half_open') { open(kind); return; }
    if (kind === 'transient') {
      transient += 1; blocking = 0;
      if (transient >= transientThreshold) open(kind);
    } else {
      blocking += 1; transient = 0;
      if (blocking >= blockingThreshold) open(kind);
    }
  }

  const snapshot = () => ({
    state: state === 'open' && now() - openedAt >= openMs ? 'half_open' : state,
    transientFailures: transient,
    blockingFailures: blocking,
    lastFailureKind: lastKind,
    ...(state === 'open' && { retryInSeconds: Math.max(0, Math.ceil((openMs - (now() - openedAt)) / 1000)) }),
  });

  return { canPass, isClosedOrProbeDue, releaseProbe, recordSuccess, recordFailure, snapshot };
}

module.exports = { createCircuitBreaker };
