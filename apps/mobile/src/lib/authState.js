// The authentication state, kept apart from React so every transition can be unit-tested.
//
//   loading      the saved session is being checked (the initial state, and after a retry)
//   authed       the server accepted the session, or the server has just issued new credentials (a login)
//   anon         no session, or the server refused it
//   unreachable  the server could not be asked: nothing is known, so nothing is granted
//   error        the saved session could not be read (secure storage failed): nothing is granted
//
// What can make it `authed`: (1) a check that the server accepted (validate), or (2) signedIn(), which only
// a fresh login or account activation calls, right after the server has verified the person's credentials.
// Saving or renewing tokens by itself never does: a refresh keeps the state exactly as it is.
//
// Every check, sign-in and sign-out moves `generation`, and a check applies its answer only if nothing newer
// has started, so a slow older check can never overwrite a retry, a login or a sign-out.
import { checkSession } from './sessionCheck';
import { setApiAuthStatus } from './authGuard';

export function createAuthStore({ getToken, fetchMe, onChange = () => {}, tokenTimeoutMs, meTimeoutMs }) {
  let generation = 0;
  let status = 'loading';
  let running = null; // the AbortController of the check in progress
  // The API layer is told first, so a request waiting for the state is released (or refused) as soon as it is known.
  const set = (next, me) => { status = next; setApiAuthStatus(next); onChange(next, me); };
  const cancelRunning = () => { running?.abort(); running = null; };

  const store = {
    getStatus: () => status,

    // Asks the server about the saved session. Resolves when finished; a dropped (outdated) answer changes nothing.
    async validate() {
      cancelRunning();
      const mine = ++generation;
      const controller = new AbortController();
      running = controller;
      const result = await checkSession({ getToken, fetchMe, signal: controller.signal, tokenTimeoutMs, meTimeoutMs });
      if (mine !== generation) return;
      running = null;
      set(result.status, result.me);
    },

    // "Try again" on the cover screen.
    retry() {
      set('loading');
      return store.validate();
    },

    // A fresh login / account activation: the server has just issued these credentials.
    signedIn() {
      cancelRunning();
      generation += 1;
      set('authed');
    },

    // Tokens cleared (sign-out or a forced sign-out): cancels any check still running.
    signedOut() {
      cancelRunning();
      generation += 1;
      set('anon');
    },
  };
  return store;
}
