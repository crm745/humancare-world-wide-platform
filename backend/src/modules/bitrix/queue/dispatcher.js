// The ONE Bitrix24 gateway for the whole portal. Every outbound Bitrix24 call of every worker passes through it at the point where the HTTP request
// leaves (bitrix-deal.api.js post() and downloadBitrixFile(), bitrix.service.js callBitrix()), so ONE rate limiter and ONE circuit breaker protect the
// portal for the Deal, document, quotation, inbox, reconciliation, recovery and legacy Lead code alike. No worker can bypass it by forgetting to call it.
//
// Two checks, at two levels:
//   canStart(serviceKey)   cheap, spends nothing: is this queue active and is the portal circuit not open? Called at the top of each worker pass, so a
//                          paused portal means "claim nothing this pass" (no delivery attempt is used up).
//   run(fn, { refuse })    the call itself: takes the breaker's permission and ONE rate token (plus a concurrency slot), runs `fn`, classifies what
//                          happened and tells the breaker. When permission is refused `fn` is NOT run and `refuse(reason)` is thrown: the request
//                          was never sent.
//   report(kind) / snapshot()  the breaker feed, and what an administrator needs to see (never a secret, URL or payload).
//
// A gate is applied to REAL egress. Callers that inject their own fetch (tests, guarded scripts) get no shared gate unless they pass `gateway`.
const { createRateLimiter } = require('./rate-limiter');
const { createCircuitBreaker } = require('./circuit-breaker');
const { SERVICE_QUEUES } = require('./service-registry');
const { bitrixRateLimitSettings } = require('../bitrix-config');

// A Bitrix24 refusal that means "this request was NOT executed; the portal is protecting itself or refusing our credential": retrying LATER is
// safe, retrying faster is harmful. (A refusal about the request's own content, such as a bad field, is 'refused' and is never retried.)
const BLOCKING_BITRIX_CODES = new Set([
  'QUERY_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS', 'OPERATION_TIME_LIMIT', 'EXPIRED_TOKEN', 'INVALID_CREDENTIALS', 'INSUFFICIENT_SCOPE', 'ACCESS_DENIED',
  'INVALID_TOKEN', 'WRONG_AUTH_TYPE',
]);
const TRANSIENT_CODES = new Set(['timeout', 'network_error', 'server_error', 'unreadable_response', 'no_result', 'invalid_deal_id']);
const CONFIG_CODES = new Set(['switch_off', 'webhook_not_configured', 'host_not_allowed']);
const GATE_CODE = 'gate_closed';

// What a failure of a Bitrix call means for the portal.
//   'deferred'  our own gate refused it (circuit open / rate limit): nothing was sent, nothing is learned about the portal
//   'blocking'  the portal refused to run it (rate limit, credential): nothing was executed, retry LATER
//   'unsent'    could not connect: nothing reached the portal
//   'transient' timeout, lost connection, 5xx, unreadable answer, unknown error: the portal's state (and the call's outcome) is unknown
//   'config'    a switch or setting stopped it before any request
//   'refused'   the portal rejected this request's content
function classifyCallError(err) {
  if (!err) return 'transient';
  if (err.name === 'GateRefusedError' || err.code === GATE_CODE) return 'deferred';
  if (err.httpStatus === 429 || err.httpStatus === 401 || err.httpStatus === 403) return 'blocking';
  if (err.bitrixCode && BLOCKING_BITRIX_CODES.has(String(err.bitrixCode).toUpperCase())) return 'blocking';
  if (err.name !== 'BitrixDealCallError') return 'transient'; // an unknown failure during a call
  if (TRANSIENT_CODES.has(err.code)) return 'transient';
  if (err.code === 'not_sent') return 'unsent';
  if (CONFIG_CODES.has(err.code)) return 'config';
  return 'refused';
}

class GateRefusedError extends Error {
  constructor(reason) {
    super(`Bitrix24 gateway refused the call (${reason}); nothing was sent.`);
    this.name = 'GateRefusedError';
    this.code = GATE_CODE;
    this.reason = reason;
  }
}

function createDispatcher({ limiter = createRateLimiter(), breaker = createCircuitBreaker(), registry = SERVICE_QUEUES, admitTimeoutMs = 5000 } = {}) {
  const calls = { success: 0, transient: 0, blocking: 0, unsent: 0, refused: 0, deferred: 0 };
  const deferredBy = {};
  const lookup = (key) => (Object.prototype.hasOwnProperty.call(registry, key) ? registry[key] : null);

  // Spends nothing and takes no half-open probe: the call itself asks again.
  function canStart(serviceKey) {
    const service = lookup(serviceKey);
    if (!service) return { ok: false, reason: 'unknown_service' };
    if (!service.active) return { ok: false, reason: 'service_not_active' };
    if (!breaker.isClosedOrProbeDue()) { deferredBy[serviceKey] = (deferredBy[serviceKey] || 0) + 1; return { ok: false, reason: 'circuit_open' }; }
    return { ok: true };
  }

  function report(kind) {
    if (kind === 'success') { calls.success += 1; breaker.recordSuccess(); return; }
    if (kind === 'unsent') { calls.unsent += 1; breaker.recordFailure('transient'); return; } // the portal was unreachable
    if (kind in calls) calls[kind] += 1;
    breaker.recordFailure(kind);
  }

  // The permission for ONE call: the breaker's, then a rate token and a concurrency slot.
  async function acquireCall() {
    if (!breaker.canPass()) return { ok: false, reason: 'circuit_open' };
    const release = await limiter.acquire({ timeoutMs: admitTimeoutMs });
    if (!release) { breaker.releaseProbe(); return { ok: false, reason: 'rate_limited' }; }
    return { ok: true, release };
  }

  async function run(fn, { refuse = (reason) => new GateRefusedError(reason) } = {}) {
    const permission = await acquireCall();
    if (!permission.ok) { calls.deferred += 1; throw refuse(permission.reason); }
    try {
      const result = await fn();
      report('success');
      return result;
    } catch (err) {
      report(classifyCallError(err));
      throw err;
    } finally {
      permission.release();
    }
  }

  const snapshot = () => ({
    breaker: breaker.snapshot(),
    limiter: limiter.snapshot(),
    calls: { ...calls },
    services: Object.fromEntries(Object.keys(registry).map((key) => [key, { active: registry[key].active, deferredPasses: deferredBy[key] || 0 }])),
  });

  return { canStart, run, report, snapshot };
}

// The ONE limiter of the process is sized from BITRIX_RATE_LIMIT_PER_SECOND / BITRIX_RATE_LIMIT_BURST / BITRIX_MAX_CONCURRENT_REQUESTS (bitrix-config.js;
// defaults 2 / 10 / 1). The API and the worker refuse to START on an invalid value (assertBitrixConfiguration); a process that never ran that check
// (a script) is refused here too, rather than running with a silently different limit. Private dispatchers (isolated tests) keep the plain defaults.
function sharedLimiter(env = process.env) {
  const { settings, problems } = bitrixRateLimitSettings(env);
  if (problems.length) throw new Error(`Bitrix24 rate-limit settings are not valid: ${problems.join(' ')}`);
  return createRateLimiter(settings);
}

let shared = null;
const sharedDispatcher = () => shared || (shared = createDispatcher({ limiter: sharedLimiter() }));

// The gate for ONE API call: an explicit gateway wins; otherwise the process-wide shared one for REAL egress. A caller that injects its own fetch
// (a test or a guarded script with a stand-in) makes no real call, so it gets no shared gate unless it passes one.
const gatewayFor = ({ gateway, fetchImpl } = {}) => gateway || (fetchImpl ? null : sharedDispatcher());

// The gateway a worker PASS asks (canStart) before claiming. The real worker (called with no overrides) uses the shared one; a pass with its own
// env or scope (tests, guarded scripts) gets a private one so its state never leaks into the real worker.
const gatewayForPass = (overrides = {}) => overrides.gateway || (overrides.env || overrides.scope ? createDispatcher() : sharedDispatcher());

module.exports = { createDispatcher, sharedDispatcher, sharedLimiter, gatewayFor, gatewayForPass, classifyCallError, GateRefusedError, BLOCKING_BITRIX_CODES, GATE_CODE };
