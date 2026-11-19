// What the splash screen (app/index.js) does, kept apart from React so every case can be unit-tested.
//
// The splash stays for at least MIN_SPLASH_MS on every launch, then goes ONE place, decided by the app's authentication state (lib/authState.js), never by a tap and never by
// the mere presence of a saved token: 'authed' means the server accepted the saved session, which is the only thing that sends a person Home. Everything else (no
// session, a refused session, a server that could not be asked, a session that could not be read, or a check that has not finished by SESSION_TIMEOUT_MS) goes to
// Getting Started. A new person and a logged-out person both have no valid session, so both go to Getting Started.
export const MIN_SPLASH_MS = 3000; // the shortest the splash is shown
// The longest the splash waits for the session check. Longer than the minimum, so a slow check can hold the splash for at most this long, never for ever.
export const SESSION_TIMEOUT_MS = 4000;

export const HOME_ROUTE = '/home';
export const START_ROUTE = '/welcome'; // Getting Started

// Where a resolved authentication state goes.
export const destinationFor = (status) => (status === 'authed' ? HOME_ROUTE : START_ROUTE);

// What the splash should do now.
//   status        the authentication state: 'loading' (still checking), 'authed', 'anon', 'unreachable' or 'error'
//   minElapsed    MIN_SPLASH_MS has passed
//   timedOut      SESSION_TIMEOUT_MS has passed
//   navigated     the splash has already gone somewhere (it never goes twice)
// Returns null (keep waiting) or the route to go to.
export function splashDecision({ status, minElapsed = false, timedOut = false, navigated = false } = {}) {
  if (navigated) return null;
  if (!minElapsed) return null; // never earlier than the minimum
  if (status === 'loading' || status === undefined || status === null) return timedOut ? START_ROUTE : null; // still checking: wait, but not for ever
  return destinationFor(status); // known: go at once (the splash is not stretched when the check was quick or the minimum was the slow part)
}
