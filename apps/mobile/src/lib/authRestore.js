// When the connection comes back, a session the server could not validate is checked again, ONCE. Pure (no React, no native modules): the app feeds it the
// authentication status and the network state, and it decides when to call `retry` (the auth store's retry, which asks the server again).
//
// What it can and cannot do:
//   - it only ever asks the server again (retry -> GET /auth/me through the normal path). It trusts no token, grants nothing and clears nothing: whether the
//     session is valid is still the server's answer, and a refused session is handled by the existing sign-out (api.js), not here
//   - it acts only while the authentication status is 'unreachable' (a storage error 'error', a refusal 'anon' and a running check 'loading' are left alone)
//   - one retry per restoration: the retry moves the status to 'loading', and its own failure cannot start another (it needs a NEW restoration)
//   - debounced: a connection that flaps (back, gone, back) is one retry, made after it has stayed back for `debounceMs`; going offline or down again cancels it
//   - never overlapping: a retry that is already waiting is replaced, not added to, and nothing is started while a check is running
export const AUTH_RETRY_DEBOUNCE_MS = 1500;

const OUTAGE = new Set(['offline', 'serverDown']);

export function createRestoreRetrier({ retry, debounceMs = AUTH_RETRY_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let authStatus = 'loading';
  let netStatus = 'unknown';
  let lastCount = null; // the restoration count already dealt with (null: nothing observed yet)
  let countAtCheck = 0; // the restoration count when the running check started
  let timer = null;

  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };

  function schedule() {
    cancel();
    timer = setTimer(() => {
      timer = null;
      // Everything is re-checked at the moment of the retry: still unreachable, and the network is not known to be down again.
      if (authStatus === 'unreachable' && !OUTAGE.has(netStatus)) retry();
    }, debounceMs);
  }

  return {
    // The authentication status changed (or is announced again).
    observeAuth(status) {
      authStatus = status;
      if (status === 'loading') {
        countAtCheck = lastCount === null ? 0 : lastCount; // a check has started: restorations from before it are not "after" it
        cancel(); // nothing may be started while a check runs (or has just been started by hand)
      } else if (status !== 'unreachable') {
        cancel();
      } else if (lastCount !== null && lastCount > countAtCheck && !OUTAGE.has(netStatus)) {
        // The check failed AFTER the connection had already come back (it was running while it returned): that restoration has not been acted on yet.
        countAtCheck = lastCount;
        schedule();
      }
    },
    // The network state changed (or is announced again): `status` and the restoration counter of lib/network.js.
    observeNetwork({ status, restoredCount = 0 }) {
      netStatus = status;
      if (lastCount === null) { lastCount = restoredCount; return; } // the first reading is a starting point
      if (OUTAGE.has(status)) cancel(); // down again before the debounce ended: no retry now
      if (restoredCount > lastCount) {
        lastCount = restoredCount;
        if (authStatus === 'unreachable' && !OUTAGE.has(status)) { countAtCheck = restoredCount; schedule(); }
      }
    },
    dispose: cancel,
    isPending: () => timer !== null,
  };
}
