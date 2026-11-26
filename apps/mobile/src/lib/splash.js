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
// A returning person whose saved session the server could not validate (no connection, the server down, or no answer in time) waits here, NOT on Getting Started: their
// session is still saved and is checked again by itself when the connection returns. A public, static screen: it shows no account data (app/cant-connect.js).
export const CANT_CONNECT_ROUTE = '/cant-connect';

// Where a resolved authentication state goes.
export const destinationFor = (status) => (status === 'authed' ? HOME_ROUTE : START_ROUTE);

// Where the splash goes once the state is known, given whether credentials are SAVED on this device (lib/authState.js savedSession).
// Only `authed` goes Home. A saved session that could not be validated goes to the Can't Connect screen; a new or logged-out person (nothing saved), a refused
// session and a storage error (kept apart: it is not a network problem) go where they always went.
export function startupDestination({ status, savedSession } = {}) {
  if (status === 'unreachable' && savedSession === true) return CANT_CONNECT_ROUTE;
  return destinationFor(status);
}

// What the splash should do now.
//   status        the authentication state: 'loading' (still checking), 'authed', 'anon', 'unreachable' or 'error'
//   savedSession  true when credentials are saved on this device, false when there are none, null/undefined when not known (see authState.js)
//   minElapsed    MIN_SPLASH_MS has passed
//   timedOut      SESSION_TIMEOUT_MS has passed
//   navigated     the splash has already gone somewhere (it never goes twice)
// Returns null (keep waiting) or the route to go to.
export function splashDecision({ status, savedSession, minElapsed = false, timedOut = false, navigated = false } = {}) {
  if (navigated) return null;
  if (!minElapsed) return null; // never earlier than the minimum
  if (status === 'loading' || status === undefined || status === null) {
    // A saved session is still being checked: the splash STAYS (there is no separate "Connecting…" screen). The check has its own time limit (lib/api.js), so it ends with an answer: Home when the
    // server says yes, Login when it refuses, and Can't Connect only when the check failed (startupDestination below).
    if (savedSession === true) return null;
    if (!timedOut) return null; // still checking: wait, but not for ever
    return START_ROUTE; // nothing saved (or not known) goes to Getting Started
  }
  return startupDestination({ status, savedSession }); // known: go at once (the splash is not stretched when the check was quick or the minimum was the slow part)
}

// The brand name in the tagline never splits across lines: the spaces inside "Humancare World Wide" become non-breaking spaces (U+00A0), in every language's text (the name is written in Latin in all of them).
export const keepBrandTogether = (text) => String(text == null ? '' : text).replace(/Humancare World Wide/g, 'Humancare\u00A0World\u00A0Wide');
