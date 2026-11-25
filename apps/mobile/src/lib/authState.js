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

// `savedSession` (kept beside the status, never instead of it) says whether credentials are SAVED on this device: null = not known (yet, or they could not be
// read), true = there are, false = there are none. It exists only so the app can tell a returning person whose session could not be validated (a saved
// session, the server unreachable) from a new or logged-out person. It grants NOTHING: only `authed` does, and that still needs the server's yes.
// `onSavedSession(value)` is told whenever it changes (it is known as soon as the credentials have been read, before the server has answered).
export function createAuthStore({ getToken, fetchMe, onChange = () => {}, onSavedSession = () => {}, tokenTimeoutMs, meTimeoutMs }) {
  let generation = 0;
  let status = 'loading';
  let savedSession = null;
  let running = null; // the AbortController of the check in progress
  const setSaved = (value) => { if (savedSession !== value) { savedSession = value; onSavedSession(value); } };
  // The API layer is told first, so a request waiting for the state is released (or refused) as soon as it is known.
  const set = (next, me) => {
    // What each answer means for the saved credentials (unreachable says nothing new: they are kept as they were).
    if (next === 'authed') setSaved(true);
    else if (next === 'anon') setSaved(false);
    else if (next === 'error') setSaved(null);
    status = next;
    setApiAuthStatus(next);
    onChange(next, me);
  };
  const cancelRunning = () => { running?.abort(); running = null; };

  const store = {
    getStatus: () => status,
    getSavedSession: () => savedSession,

    // Asks the server about the saved session. Resolves when finished; a dropped (outdated) answer changes nothing.
    async validate() {
      cancelRunning();
      const mine = ++generation;
      const controller = new AbortController();
      running = controller;
      // An outdated check (a newer one, a sign-in or a sign-out has started) must not report anything about the credentials.
      const onToken = (has) => { if (mine === generation) setSaved(has); };
      const result = await checkSession({ getToken, fetchMe, signal: controller.signal, tokenTimeoutMs, meTimeoutMs, onToken });
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
