// What counts as usable credentials in a server response. Pure, shared by session.js (before anything is
// stored) and the sign-in screens (before anyone is signed in), so a response with a missing or empty token
// can never be stored, never announce a sign-in, and never reach a protected screen.
export const isTokenString = (value) => typeof value === 'string' && value.trim().length > 0;

export const hasValidTokens = (value) => !!value && isTokenString(value.token) && isTokenString(value.refreshToken);

// Where a person lands after signing in, by the kind of session. Patients and corporates both start on Home
// (Home has its own corporate version, and the tab bar sends corporates to their cases); anything else is not
// a session this app knows, so there is no destination and no sign-in.
const AFTER_SIGN_IN = { patient: '/home', corporate: '/home' };
export const postSignInRoute = (sessionType) => (Object.hasOwn(AFTER_SIGN_IN, sessionType) ? AFTER_SIGN_IN[sessionType] : null);
