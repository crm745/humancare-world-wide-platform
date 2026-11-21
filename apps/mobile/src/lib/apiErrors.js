// How a failed API call is told apart and worded. Pure (no React, no native modules), so it is unit-tested without a device.
//
// A request that could not be completed ends in one of these, never in a raw "TypeError: Network request failed":
//   network   nothing came back (no connection, DNS, a dropped link, a server that is down)
//   timeout   nothing came back in time
// Both carry `code` ('network' | 'timeout', the codes the app already used), `failure` (the same word) and `outcomeUnknown`:
//   outcomeUnknown === true   the call was a WRITE (anything but GET). It may have reached the server and been processed with only the
//                             answer lost, so the caller must NOT assume it failed and must not resend it blindly (a second request could
//                             be saved twice). Nothing in this file retries; it only says what is known.
//   outcomeUnknown === false  a read: running it again is always safe.
// They never carry `status` (no HTTP answer exists): code that tells "no answer" from "an answer" by the missing status keeps working.
//
// A refused answer (4xx), a server error (5xx) and the session errors keep the shape they always had; classifyApiError only names them.

export const NETWORK_READ_MESSAGE = 'Could not reach the server. Please check your connection and try again.';
export const TIMEOUT_READ_MESSAGE = 'The server took too long to answer. Please try again.';
export const NETWORK_WRITE_MESSAGE = "We couldn't confirm that this went through because the connection was lost. Please check before trying again.";
export const TIMEOUT_WRITE_MESSAGE = "We didn't get an answer in time, so we couldn't confirm that this went through. Please check before trying again.";

// The longest a JSON write (POST/PATCH) waits for its answer once it has been sent. Reads have their own (GET_TIMEOUT_MS in api.js); uploads
// and downloads are not cut off here (they can be large). A timeout means "unknown", never "failed".
export const WRITE_TIMEOUT_MS = 30000;

const isWrite = (method) => String(method || 'GET').toUpperCase() !== 'GET';

// The error for a call that got no answer. `timedOut` says the deadline (not the network) ended it.
export function noAnswerError({ method, timedOut = false } = {}) {
  const write = isWrite(method);
  const failure = timedOut ? 'timeout' : 'network';
  const message = timedOut
    ? (write ? TIMEOUT_WRITE_MESSAGE : TIMEOUT_READ_MESSAGE)
    : (write ? NETWORK_WRITE_MESSAGE : NETWORK_READ_MESSAGE);
  return Object.assign(new Error(message), { code: failure, failure, outcomeUnknown: write });
}

export const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 'aborted');

// A deadline for one network attempt. `signal` aborts when the caller's signal aborts or when `ms` has passed (ms <= 0: no deadline).
// Start it when the request is actually sent, so time spent waiting for the session check does not count against the request.
export function startDeadline(callerSignal, ms) {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) abort();
    else callerSignal.addEventListener('abort', abort, { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => { expired = true; controller.abort(); }, ms) : null;
  return {
    signal: controller.signal,
    expired: () => expired,
    clear() {
      if (timer) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', abort);
    },
  };
}

// What a failed attempt becomes: a caller's own cancel stays a cancel (the session check relies on it), the deadline is a timeout, and
// anything else thrown by fetch (a TypeError on a phone) is "no connection".
export function failureOf(err, { method, deadline } = {}) {
  if (deadline && deadline.expired()) return noAnswerError({ method, timedOut: true });
  if (isAbort(err)) return err;
  return noAnswerError({ method });
}

// A word for any error an API call can end with, for the screens and the network service. Never throws.
//   cancelled  the caller stopped it   network / timeout  no answer   auth  the session is not valid / not allowed
//   server  an HTTP 5xx   rate_limited  429   validation  any other refusal (4xx)   unknown  anything else
export function classifyApiError(err) {
  if (!err) return 'unknown';
  if (err.name === 'AbortError' && !err.failure) return 'cancelled';
  if (err.failure === 'network' || err.code === 'network') return 'network';
  if (err.failure === 'timeout' || err.code === 'timeout') return 'timeout';
  if (['session_expired', 'not_signed_in', 'session_unverified'].includes(err.code)) return 'auth';
  const status = Number(err.status);
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'unknown';
}

// True when the call may have been processed although no answer arrived (see above).
export const isOutcomeUnknown = (err) => !!err && err.outcomeUnknown === true;
