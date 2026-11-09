import { http, publicHttp, refreshOnce } from '@/services/http';
import { ApiError } from '@/services/config';

// Sign-in steps and logout opt out of the transparent refresh (a refused sign-in is an answer,
// not an expired session) and of the "session expired" event.
const signIn = { skipUnauthorizedEvent: true, skipRefresh: true };
// The boot-time probe: a 401 is "not signed in" (after one refresh attempt), not "expired".
const quiet = { skipUnauthorizedEvent: true };

// Resolves with the admin, or rejects with an ApiError (401 = no valid session).
export async function fetchSession() {
  const { data } = await http.get('/admin/me', quiet);
  return data.admin;
}

// Step 1 of sign-in: the password. Returns the 120-second ticket and the passkey request options.
// Nothing is signed in yet, and no cookie is set.
export async function loginPassword(email, password) {
  const { data } = await http.post('/admin/login/password', { email, password }, signIn);
  return { loginTicket: data.loginTicket, options: data.options };
}

// Step 2: the passkey assertion. The server sets the session cookies; the body only describes the
// admin. Tokens are never in a body, so there is none to drop here.
export async function loginPasskey(loginTicket, response) {
  const { data } = await http.post('/admin/login/passkey', { loginTicket, response }, signIn);
  return { name: data.admin?.name ?? null, email: data.admin?.email ?? null };
}

export const LOGOUT_FAILED_MESSAGE = "We couldn't confirm that you were logged out, so you are still signed in. Please try again.";

// No body at all: an explicit `null` would be sent as the JSON text "null", which the backend's strict
// JSON parser refuses (400), leaving the session unrevoked and the cookies in place.
const postLogout = () => http.post('/admin/logout', undefined, { ...signIn });

// Resolves only when the server has confirmed the session is over: logout succeeded, or the server
// says (401) that the session is already invalid. Anything else rejects, and the caller keeps the
// signed-in state. A 401 may only mean the 15-minute access cookie lapsed, so it gets exactly one
// refresh and one more logout; no further retries.
export async function logoutRequest() {
  try {
    await postLogout();
    return;
  } catch (err) {
    if (err.status !== 401) throw err;
  }
  const outcome = await refreshOnce();
  if (outcome === 'invalid') return; // the refresh cookie is dead too: the session is already revoked
  if (outcome !== 'renewed') throw new ApiError(LOGOUT_FAILED_MESSAGE, 0);
  try {
    await postLogout();
  } catch (err) {
    if (err.status !== 401) throw err; // still 401 after a renewal: the session is gone
  }
}

// ---- invitation links and first passkey (public: no cookies are sent) --------------------------

export async function inspectInvitation(token) {
  const { data } = await publicHttp.post('/admin/invitations/inspect', { token });
  return data; // { valid, state, adminName?, maskedEmail?, purpose?, expiresAt? }
}

export async function acceptInvitation(token, password) {
  const { data } = await publicHttp.post('/admin/invitations/accept', { token, password });
  return { ticket: data.enrollmentTicket, ticketExpiresInSeconds: data.ticketExpiresInSeconds };
}

export async function redeemEnrollment(token, password) {
  const { data } = await publicHttp.post('/admin/enrollment/redeem', { token, password });
  return { ticket: data.enrollmentTicket, ticketExpiresInSeconds: data.ticketExpiresInSeconds };
}

export async function enrollmentOptions(ticket) {
  const { data } = await publicHttp.post('/admin/passkeys/registration/options', { ticket });
  return data.options;
}

export async function enrollmentVerify(ticket, response, label) {
  const { data } = await publicHttp.post('/admin/passkeys/registration/verify', { ticket, response, ...(label ? { label } : {}) });
  return data; // { status: 'active', nextStep: 'sign_in' }
}
