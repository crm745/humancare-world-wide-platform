// Where each kind of route sends the current session. Kept free of React so the rules
// (and the absence of redirect loops) can be tested on their own; guards.jsx applies them.
//
// A restricted session (first login with a temporary password) may reach only the
// first-login password screen. Every target below is accepted by its own guard, so no
// combination of session state can bounce between two routes.
export const LOGIN_PATH = '/login';
export const DASHBOARD_PATH = '/dashboard';
export const FIRST_LOGIN_PATH = '/change-password-required';

/** Dashboard pages: signed in and not restricted. Returns null to render the page. */
export function protectedRedirect({ isAuthenticated, passwordChangeRequired }, from) {
  if (!isAuthenticated) return { to: LOGIN_PATH, state: { from } };
  if (passwordChangeRequired) return { to: FIRST_LOGIN_PATH };
  return null;
}

/** Login / registration: a signed-in user is sent where they belong. */
export function publicOnlyRedirect({ isAuthenticated, passwordChangeRequired }) {
  if (!isAuthenticated) return null;
  return { to: passwordChangeRequired ? FIRST_LOGIN_PATH : DASHBOARD_PATH };
}

/** The first-login password screen: only for a signed-in, restricted session. */
export function passwordChangeRedirect({ isAuthenticated, passwordChangeRequired }) {
  if (!isAuthenticated) return { to: LOGIN_PATH };
  if (!passwordChangeRequired) return { to: DASHBOARD_PATH };
  return null;
}
