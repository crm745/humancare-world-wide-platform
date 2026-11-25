// Operational visibility of the PATIENT PUSH DELIVERY worker: one startup line, a rate-limited summary, and [ALERT] lines for the cases that need a person.
//
// What it may say: fixed words and COUNTS. Never a delivery, notification, patient, device or recipient id; never a name, phone number, e-mail, notification
// text or medical detail; never an Expo push token or the Expo access token (only "configured: yes/no"). It writes nothing to the database (the one query,
// store.deliveryMetrics, is a single aggregate SELECT), creates no audit row, has no endpoint, and cannot change what the worker does:
// observe() never throws and is called AFTER a pass has finished.
//
// Rate limiting (the push worker is ONE process: see push-delivery-worker.js, so the state is per process, like the credential state of the worker service):
//   * a summary line at most every MONITOR.SUMMARY_INTERVAL_SECONDS (10 min); the first one is due one interval after the first pass;
//   * an [ALERT] line of one kind at most every MONITOR.ALERT_COOLDOWN_SECONDS (1 h), and only when a summary is produced, never on every 15 s tick.
// While push delivery is off the summary says why (switch off / credentials missing or invalid / test or synthetic run) and the database is NOT read: a
// disabled worker keeps its promise of no database access.
//
// The Expo authentication pause is already reported once, as an error, when it starts (by the worker service); the summary shows it while it lasts.
const { readConfig, suppressionReason, TOKEN_VAR, MONITOR } = require('./push-delivery.config');

const createMonitorState = () => ({ lastSummaryAtMs: 0, lastAlertAtMs: {} });
const defaultMonitorState = createMonitorState();

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const codeOf = (err) => (err && typeof err.code === 'string' && SAFE_CODE.test(err.code) ? err.code : (err && SAFE_CODE.test(err.name || '') ? err.name : 'error'));
function emit(log, level, text) {
  const target = log && typeof log[level] === 'function' ? log[level] : (log && typeof log.log === 'function' ? log.log : null);
  if (target) target.call(log, text);
}

// What the worker's configuration means, WITHOUT building an Expo client or touching the network. `attempting` is true only when a pass would really send.
function describeConfiguration(env = process.env) {
  const config = readConfig(env);
  const token = env[TOKEN_VAR];
  return {
    requested: env.PUSH_DELIVERY_ENABLED === 'true',
    attempting: config.enabled === true,
    tokenConfigured: typeof token === 'string' && token !== '',
    environment: suppressionReason(env) || 'normal', // normal | test_environment | scoped_test_run | integration_test_run | synthetic_run
    reason: config.enabled ? null : config.problem, // a short code: switch_off, suppressed_*, access_token_missing, access_token_invalid
  };
}

// One line when the worker starts. Booleans and fixed codes only.
function startupLine(env = process.env) {
  const d = describeConfiguration(env);
  return `[push-delivery] startup: delivery=${d.requested ? 'enabled' : 'disabled'}, expoAccessTokenConfigured=${d.tokenConfigured ? 'yes' : 'no'}, `
    + `environment=${d.environment}, attemptingDelivery=${d.attempting ? 'yes' : 'no'}${d.reason ? `, reason=${d.reason}` : ''}.`;
}

let startupLogged = false;
// Once per process. A misconfiguration (switched on but cannot run) is a warning; everything else is information.
function logStartup({ env = process.env, log = console } = {}) {
  if (startupLogged) return false;
  startupLogged = true;
  const d = describeConfiguration(env);
  emit(log, d.requested && !d.attempting ? 'warn' : 'info', startupLine(env));
  return true;
}
const resetStartupForTests = () => { startupLogged = false; };

// The one word the summary uses to tell the situations apart.
function stateOf(config, paused) {
  if (config.enabled) return paused ? 'paused_credentials_rejected' : 'running';
  if (config.problem === 'switch_off') return 'disabled';
  if (typeof config.problem === 'string' && config.problem.startsWith('suppressed_')) return 'suppressed_test_or_synthetic';
  if (config.problem === 'access_token_missing') return 'credentials_missing';
  if (config.problem === 'access_token_invalid') return 'credentials_invalid';
  return 'disabled';
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'metrics_timeout' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// An [ALERT] of one kind at most once per cooldown.
function alert(ctx, kind, text) {
  const state = ctx.monitor;
  const now = ctx.nowMs();
  const last = state.lastAlertAtMs[kind];
  if (last !== undefined && now - last < MONITOR.ALERT_COOLDOWN_SECONDS * 1000) return false;
  state.lastAlertAtMs[kind] = now;
  emit(ctx.log, 'error', `[ALERT] [push-delivery] ${text}`);
  return true;
}

/**
 * Called by the worker after every pass. ctx: { monitor, nowMs, log, store, prisma, credentials }. config: readConfig(env). Never throws.
 */
async function observe(ctx, config) {
  try {
    const state = ctx.monitor;
    const now = ctx.nowMs();
    if (!state.lastSummaryAtMs) { state.lastSummaryAtMs = now; return; } // the first pass starts the interval
    if (now - state.lastSummaryAtMs < MONITOR.SUMMARY_INTERVAL_SECONDS * 1000) return;
    state.lastSummaryAtMs = now;

    const paused = !!ctx.credentials && ctx.credentials.status === 'rejected';
    const label = stateOf(config, paused);

    if (!config.enabled) {
      const misconfigured = label === 'credentials_missing' || label === 'credentials_invalid';
      emit(ctx.log, misconfigured ? 'warn' : 'info', `[push-delivery] summary: state=${label}, nothing is sent${config.problem ? ` (reason=${config.problem})` : ''}.`);
      if (misconfigured) alert(ctx, label, `push delivery is switched on but cannot run: the Expo access token is ${label === 'credentials_missing' ? 'missing' : 'invalid'} (state=${label}). Deliveries are not sent and expire after 24 h.`);
      return;
    }

    let m;
    try {
      m = await withTimeout(Promise.resolve(ctx.store.deliveryMetrics(ctx.prisma, { windowHours: MONITOR.WINDOW_HOURS })), MONITOR.METRICS_TIMEOUT_MS);
    } catch (err) {
      emit(ctx.log, 'warn', `[push-delivery] monitoring: the delivery counts are unavailable (${codeOf(err)}); delivery itself is not affected.`);
      return;
    }
    const age = m.oldestPendingSeconds === null || m.oldestPendingSeconds === undefined ? 'none' : String(m.oldestPendingSeconds);
    emit(ctx.log, paused ? 'warn' : 'info',
      `[push-delivery] summary: state=${label}, pending=${m.pending}, sending=${m.sending}, accepted=${m.accepted}, failed${MONITOR.WINDOW_HOURS}h=${m.failed}, `
      + `uncertain${MONITOR.WINDOW_HOURS}h=${m.uncertain}, expired${MONITOR.WINDOW_HOURS}h=${m.expired}, oldestPendingSeconds=${age}.`);

    if (m.failed >= MONITOR.ALERT_FAILED) alert(ctx, 'failed', `${m.failed} push deliveries failed in the last ${MONITOR.WINDOW_HOURS} h (threshold ${MONITOR.ALERT_FAILED}). Inspect notification_deliveries (status failed, last_error_code).`);
    if (m.uncertain >= MONITOR.ALERT_UNCERTAIN) alert(ctx, 'uncertain', `${m.uncertain} push deliveries are uncertain (a request may have reached Expo) in the last ${MONITOR.WINDOW_HOURS} h (threshold ${MONITOR.ALERT_UNCERTAIN}). They are never re-sent automatically.`);
    if (m.expired >= MONITOR.ALERT_EXPIRED) alert(ctx, 'expired', `${m.expired} push deliveries expired unsent in the last ${MONITOR.WINDOW_HOURS} h (threshold ${MONITOR.ALERT_EXPIRED}). Check that the worker runs and push delivery is enabled.`);
    // A paused worker explains its own backlog (reported when the pause started); a backlog while NOT paused means the queue is not being worked.
    if (!paused && typeof m.oldestPendingSeconds === 'number' && m.oldestPendingSeconds >= MONITOR.ALERT_OLDEST_PENDING_SECONDS) {
      alert(ctx, 'stuck', `the oldest pending push delivery has waited ${m.oldestPendingSeconds} s (threshold ${MONITOR.ALERT_OLDEST_PENDING_SECONDS} s). The queue is not being worked.`);
    }
  } catch (err) {
    try { emit(ctx.log, 'warn', `[push-delivery] monitoring failed (${codeOf(err)}); delivery itself is not affected.`); } catch { /* monitoring must never throw */ }
  }
}

module.exports = { createMonitorState, defaultMonitorState, describeConfiguration, startupLine, logStartup, resetStartupForTests, stateOf, observe };
