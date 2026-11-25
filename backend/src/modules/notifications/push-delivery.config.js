// Configuration and fixed policy of the PATIENT PUSH DELIVERY worker (push-delivery.service.js). Everything is read from the environment at call
// time (never at import) and nothing is trimmed, lower-cased or repaired: a wrong value is reported as a short code, never fixed. The worker is OFF
// by default and the configuration fails CLOSED: any problem means the worker does nothing (no database access, no Expo call).
//
//   PUSH_DELIVERY_ENABLED     exactly "true" turns delivery on. Missing, empty or any other value = off.
//   EXPO_PUSH_ACCESS_TOKEN    the Expo Push Access Token (Expo "enhanced push security"). BACKEND ONLY: it is sent in the Authorization header of
//                             requests to Expo and nowhere else; never logged, never returned, never given to the mobile app. Required whenever
//                             delivery is enabled (no token = the worker stays off).
//
// Delivery is also refused, whatever the switch says, in any test or synthetic run (suppressionReason below), so an automated run can never send a
// real push. Activating delivery in an environment (above all production) is a separate, explicit decision: nothing here turns it on.

const SWITCH = 'PUSH_DELIVERY_ENABLED';
// The visible name prefix of the synthetic E2E identity (same literal as bitrix/deal-outbox.store.js): such a patient is never sent a push, nor is one queued.
const SYNTHETIC_IDENTITY_PREFIX = 'ZZ-SYNTHETIC';
const TOKEN_VAR = 'EXPO_PUSH_ACCESS_TOKEN';

// Printable ASCII without spaces: safe inside a header value (no CR/LF), and long enough to be a real token. The real token's exact format is not
// assumed beyond that.
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7E]{16,512}$/;

const POLICY = Object.freeze({
  MAX_ATTEMPTS: 3, // total attempts, the first one included
  RETRY_DELAYS_SECONDS: Object.freeze([60, 5 * 60]), // after attempt 1: 1 minute; after attempt 2: 5 minutes; none after attempt 3
  MAX_RETRY_AFTER_SECONDS: 60 * 60, // a Retry-After longer than this is capped (the 24 h expiry still ends everything)
  EXPIRY_HOURS: 24, // a delivery still waiting (pending) this long after it was created is closed, never sent
  LEASE_SECONDS: 120, // a worker's claim; far longer than the Expo request timeout
  REQUEST_TIMEOUT_MS: 15 * 1000,
  MIN_LEASE_LEFT_SECONDS: 30, // an attempt starts only if the lease will outlive the request (timeout + margin)
  SEND_BATCH: 20, // deliveries claimed per pass
  RECEIPT_FIRST_CHECK_SECONDS: 15 * 60, // Expo recommends checking receipts 15 minutes after sending
  RECEIPT_RECHECK_SECONDS: 10 * 60, // a receipt that is not there (yet): look again later
  RECEIPT_BATCH: 100, // receipts looked up per pass (Expo allows 1000 ids per request)
  RECEIPT_MAX_AGE_HOURS: 24, // Expo clears receipts after 24 hours: no receipt by then = outcome unknown
  CREDENTIAL_RECHECK_SECONDS: 15 * 60, // after Expo rejected the access token: how long before the SAME token is tested again (see the service)
  // Expo push TTL (seconds). Every message is sent with a `ttl` equal to what is left of the delivery's 24 h window (EXPIRY_HOURS, counted from the
  // delivery row's created_at), so a phone that is off cannot receive it after the delivery would have been closed. A delivery with less than
  // MIN_TTL_SECONDS left is NOT sent: the existing expiry closes it. Never longer than the window, never extended.
  MIN_TTL_SECONDS: 60,
});

// Monitoring (push-delivery.monitor.js): aggregate counts only, a summary line at most every SUMMARY_INTERVAL_SECONDS (per process: the worker is a single
// process), and an [ALERT] line for one kind at most every ALERT_COOLDOWN_SECONDS. WINDOW_HOURS is how far back closed deliveries are counted.
const MONITOR = Object.freeze({
  SUMMARY_INTERVAL_SECONDS: 10 * 60,
  ALERT_COOLDOWN_SECONDS: 60 * 60,
  METRICS_TIMEOUT_MS: 10 * 1000,
  WINDOW_HOURS: 24,
  ALERT_FAILED: 5, // failed deliveries (expired ones are counted separately) within the window
  ALERT_UNCERTAIN: 3, // uncertain deliveries within the window
  ALERT_EXPIRED: 5, // deliveries closed as expired within the window
  ALERT_OLDEST_PENDING_SECONDS: 30 * 60, // a pending delivery this old: the queue is not being worked
});

// Why an automated run must not send. Read from the environment the process was started with.
function suppressionReason(env = process.env) {
  if (env.NODE_ENV === 'test') return 'test_environment';
  if (env.HUMANCARE_SCOPED_RUN === 'true') return 'scoped_test_run';
  if (env.HUMANCARE_INTEGRATION_RUN === 'true') return 'integration_test_run';
  if (env.SYNTHETIC_E2E_AUTO_APPROVE === 'true' || env.ALLOW_SYNTHETIC_APPROVAL === 'true') return 'synthetic_run';
  return null;
}

const isRequested = (env = process.env) => env[SWITCH] === 'true';

/**
 * { enabled: true, accessToken } or { enabled: false, problem } with a short code (never a value).
 * `switch_off` is the normal, quiet state.
 */
function readConfig(env = process.env) {
  if (!isRequested(env)) return { enabled: false, problem: 'switch_off' };
  const suppressed = suppressionReason(env);
  if (suppressed) return { enabled: false, problem: `suppressed_${suppressed}` };
  const token = env[TOKEN_VAR];
  if (token === undefined || token === '') return { enabled: false, problem: 'access_token_missing' };
  if (typeof token !== 'string' || !ACCESS_TOKEN_PATTERN.test(token)) return { enabled: false, problem: 'access_token_invalid' };
  return { enabled: true, accessToken: token };
}

module.exports = { SWITCH, TOKEN_VAR, POLICY, MONITOR, SYNTHETIC_IDENTITY_PREFIX, suppressionReason, isRequested, readConfig };
