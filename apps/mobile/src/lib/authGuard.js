// Which screens need a signed-in person, and what to do when there is none. Pure logic (no React, no
// native modules) so it can be unit-tested; components/AuthGate.js applies it.
//
// Default deny: a route is protected unless it is listed as public below, so a screen added later is
// protected until someone decides otherwise. The listed screens are the ones a signed-out person must
// be able to reach (Getting Started, Login, Create Account, password reset, the corporate login and
// the plain legal / help pages).
export const PUBLIC_ROUTES = new Set([
  '/', // the splash, which decides where to go next
  '/welcome',
  '/login',
  '/login-otp',
  '/choose-login',
  '/register',
  '/register-otp',
  '/complete-profile', // sign-up with Google/Apple; the account is created at the end, by the mobile code
  '/forgot-password',
  '/forgot-password-otp',
  '/reset-password',
  '/set-password',
  '/corporate-login',
  '/corporate-otp',
  '/terms',
  '/privacy',
  '/help-support',
]);

export const PATIENT_LOGIN = '/login';
export const CORPORATE_LOGIN = '/corporate-login';

const normalise = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

export const isPublicRoute = (pathname) => PUBLIC_ROUTES.has(normalise(pathname));

// Corporate screens send people to the corporate login, everything else to the normal Login. Both are
// public, so a redirect can never be redirected again.
export const loginRouteFor = (pathname) => (normalise(pathname).startsWith('/corporate') ? CORPORATE_LOGIN : PATIENT_LOGIN);

// status: 'loading' (still finding out), 'authed', 'anon' (no valid session), 'unreachable' (the server
// could not be asked) or 'error' (the saved session could not be read). In the last two nothing is known, so
// access is not granted on a guess.
//   { action: 'allow' }                       render the screen
//   { action: 'wait' }                        cover the screen with the loading view
//   { action: 'retry', reason }               cover it with a Try again (reason: 'network' or 'storage')
//   { action: 'redirect', redirect: '/login' } cover it and go to Login
export function guardDecision({ pathname, status }) {
  if (isPublicRoute(pathname)) return { action: 'allow' };
  if (status === 'authed') return { action: 'allow' };
  if (status === 'anon') return { action: 'redirect', redirect: loginRouteFor(pathname) };
  if (status === 'unreachable') return { action: 'retry', reason: 'network' };
  if (status === 'error') return { action: 'retry', reason: 'storage' };
  return { action: 'wait' };
}

// The API calls a signed-out person legitimately makes (log in, sign up, reset a password, refresh the
// session, the public service and city lists). Every other call needs a token and is not sent without one.
const PUBLIC_API_PREFIXES = [
  '/auth/login', '/auth/register', '/auth/otp', '/auth/password', '/auth/google', '/auth/apple', '/auth/social',
  '/auth/corporate/login', '/auth/corporate/otp', '/auth/corporate/forgot-password', '/auth/corporate/reset-password',
  '/auth/forgot-password', '/auth/reset-password', '/auth/refresh',
  '/services', '/geo', '/corporates',
];

export const isPublicApiPath = (path) => {
  const bare = String(path || '').split('?')[0];
  return PUBLIC_API_PREFIXES.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`));
};

// The screen the person is on, kept here so code outside React (api.js) can send them to the right login.
let currentPath = '/';
export const setCurrentPath = (pathname) => { currentPath = normalise(pathname); };
export const getCurrentPath = () => currentPath;

// ---- the API's view of the authentication state ------------------------------------------------------------
// apiFetch and apiUpload hold every call that needs a signed-in person until the state is known, and send it only
// when the state is 'authed'. So a screen that is mounted behind the cover cannot start a protected request while
// the session is still being checked (it waits), nor when there is no valid session or the check could not finish
// (it is refused without a request). authState.js keeps this in step with the state; the one call that is allowed
// through while loading is the session check itself (`validation: true`). The default is 'loading': nothing
// protected is sent before the state has been set.
let apiAuthStatus = 'loading';
const apiAuthWaiters = new Set();

export const getApiAuthStatus = () => apiAuthStatus;
export function setApiAuthStatus(status) {
  apiAuthStatus = status;
  if (status !== 'loading') {
    const release = [...apiAuthWaiters];
    apiAuthWaiters.clear();
    release.forEach((resolve) => resolve());
  }
}

export async function ensureAuthenticated() {
  while (apiAuthStatus === 'loading') await new Promise((resolve) => apiAuthWaiters.add(resolve));
  if (apiAuthStatus === 'authed') return;
  const err = new Error(apiAuthStatus === 'anon' ? 'Please log in to continue.' : 'We could not check your session. Please try again.');
  if (apiAuthStatus === 'anon') err.status = 401;
  err.code = apiAuthStatus === 'anon' ? 'not_signed_in' : 'session_unverified';
  throw err;
}
