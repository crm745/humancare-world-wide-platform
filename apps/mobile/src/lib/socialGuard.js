// The offline rules of "Continue with Google" / "Sign in with Apple". Pure (no React, no native modules), so every outcome can be unit-tested; lib/useSocialAuth.js applies them.
//
//   - Offline (the app's one network state, lib/network.js: only a KNOWN offline state counts; unknown or slow is online) nothing is started: no picker, no browser, no popup, no request.
//     This is checked again at the moment of the tap, not only when the screen last drew.
//   - If the connection drops DURING the flow (the picker or popup is open), or the provider never answers, the flow ends with a clear error instead of waiting for ever.
//     The caller shows the message and the person is back on the login screen, not signed in (nothing is saved before the backend has said yes: lib/googleLogin.js).
export const SOCIAL_STEP_TIMEOUT_MS = 190000; // longer than the web popup's own 3 minutes (googleWebFlow WAIT_MAX_MS), which ends quietly first
export const OFFLINE_CODE = 'social_offline';
export const TIMEOUT_CODE = 'social_timeout';

export const offlineError = (message) => Object.assign(new Error(message), { code: OFFLINE_CODE });
export const isOfflineError = (err) => !!err && err.code === OFFLINE_CODE;

// Starts a sign-in only when the phone is not known to be offline. Resolves 'offline' (and has called nothing) or whatever `run` resolves.
export async function startSocialSignIn({ isOffline, run }) {
  if (isOffline) return 'offline';
  return run();
}

// Watches ONE flow. run(promise) resolves or rejects like `promise`, unless abort() is called first (the connection dropped: rejects with the offline error) or `timeoutMs` passes (rejects with the
// timeout error). Whatever happens, the timer is cleared and the watch can be used again for the next attempt.
export function createFlowWatch({ offlineMessage, timeoutMessage, timeoutMs = SOCIAL_STEP_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let abortNow = null;
  return {
    isRunning: () => abortNow !== null,
    abort() { if (abortNow) abortNow(offlineError(offlineMessage)); },
    run(promise) {
      let timer = null;
      const guard = new Promise((_, reject) => {
        abortNow = reject;
        timer = setTimer(() => reject(Object.assign(new Error(timeoutMessage), { code: TIMEOUT_CODE })), timeoutMs);
      });
      const done = () => { clearTimer(timer); abortNow = null; };
      return Promise.race([promise, guard]).then((value) => { done(); return value; }, (err) => { done(); throw err; });
    },
  };
}
