// What a file upload that did not end in a clean answer is called, and the watch that ends an upload which has stopped moving. Pure (no React, no native modules).
//
// An upload is a WRITE: when the connection drops, the deadline passes or the person cancels AFTER the bytes may have started to reach the server, the file may already be saved with
// only the answer lost. Those errors say `outcomeUnknown: true` and are never to be shown as "failed" or sent again blindly. A cancel BEFORE anything was sent (while waiting for the
// session, or before the transfer began) certifies that nothing reached the server: `notProcessed: true`. The same two flags the Phase 4 classification reads (lib/requestSubmission.js).
export const UPLOAD_STALL_MS = 60000; // an upload that makes no progress for this long has stalled (a total duration is never assumed: a big file on a slow link can take minutes)
export const UPLOAD_RESPONSE_WAIT_MS = 120000; // once every byte is sent, the server may still scan the file before it answers: it is given longer

export const UPLOAD_NETWORK_MESSAGE = "We couldn't confirm that this file went through because the connection was lost. Check its status before trying again.";
export const UPLOAD_TIMEOUT_MESSAGE = "We didn't get an answer in time, so we couldn't confirm that this file went through. Check its status before trying again.";
export const UPLOAD_CANCELLED_UNKNOWN_MESSAGE = 'The upload was stopped while it may already have been arriving, so we cannot tell whether the file was received. Check its status before trying again.';
export const UPLOAD_CANCELLED_MESSAGE = 'The upload was cancelled before anything was sent.';
export const UPLOAD_REFUSED_MESSAGE = 'Upload failed. Please try again.';

// No answer arrived. `transmitted`: the transfer had been started, so the server may have received the file.
export function uploadNoAnswer({ timedOut = false, transmitted = true } = {}) {
  const failure = timedOut ? 'timeout' : 'network';
  const message = timedOut ? UPLOAD_TIMEOUT_MESSAGE : UPLOAD_NETWORK_MESSAGE;
  return Object.assign(new Error(message), { code: failure, failure, outcomeUnknown: transmitted, ...(transmitted ? {} : { notProcessed: true }) });
}

// The person (or the screen) cancelled. Before the transfer began nothing was sent; after it began the outcome is unknown.
export function uploadCancelled({ transmitted = false } = {}) {
  return Object.assign(new Error(transmitted ? UPLOAD_CANCELLED_UNKNOWN_MESSAGE : UPLOAD_CANCELLED_MESSAGE), {
    code: 'cancelled', failure: 'cancelled', cancelled: true, outcomeUnknown: transmitted, ...(transmitted ? {} : { notProcessed: true }),
  });
}

// The server answered with a refusal or an error: an ANSWER, with the status and body kept as the other API errors do.
export function uploadAnswered(status, data) {
  const body = data && typeof data === 'object' ? data : {};
  const err = Object.assign(new Error(body.error || UPLOAD_REFUSED_MESSAGE), { status, data: body });
  if (body.code) err.code = body.code;
  if (status >= 500) err.failure = 'server';
  return err;
}

// Ends an upload that stopped moving. `touch(done)` after every progress report restarts the wait (a different, longer one once every byte has been sent); `stop()` ends the watch.
// The timer functions are injected so a test can drive it without waiting.
export function createStallWatch({ stallMs = UPLOAD_STALL_MS, responseMs = UPLOAD_RESPONSE_WAIT_MS, onStall, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let stopped = false;
  const arm = (ms) => {
    if (timer !== null) clearTimer(timer);
    if (stopped || !(ms > 0)) { timer = null; return; }
    timer = setTimer(() => { timer = null; if (!stopped) onStall(); }, ms);
  };
  return {
    start: () => arm(stallMs),
    touch: (sentEverything = false) => arm(sentEverything ? Math.max(stallMs, responseMs) : stallMs),
    stop: () => { stopped = true; if (timer !== null) { clearTimer(timer); timer = null; } },
  };
}
