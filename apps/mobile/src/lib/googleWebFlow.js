// The rules of the Google sign-in POPUP on the web. Pure (no React, no browser), so they can be unit-tested; googleAuth.web.js and
// googleCallback.web.js apply them.
//
// Why the app has its own popup flow instead of expo-auth-session's: that one finds out that the popup has finished through window.opener
// (the popup posts to it) and through popup.closed (the parent polls it). Google's sign-in pages are served with
// "Cross-Origin-Opener-Policy: same-origin", which cuts that link: the popup's opener becomes null and the parent sees popup.closed === true
// at once, while the popup is still open. The library then takes the sign-in for cancelled, and the popup, back on the app, just keeps running
// the app (splash, then Getting Started). Here the popup hands its answer over through same-origin storage and a BroadcastChannel, which work
// whatever the opener is, and it is checked against the sign-in this window started (state, and the nonce inside the token).

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
// The same permissions, response type and account chooser as before (what expo-auth-session sent).
export const GOOGLE_SCOPE = 'openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
export const PENDING_KEY = 'hc_google_pending'; // what this window is waiting for: { state, nonce, at }
export const RESULT_KEY = 'hc_google_result'; // what the popup found: { state, idToken | error, at }
export const CHANNEL_NAME = 'hc-google-auth';
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000; // a sign-in that has been open longer than this is stale
export const WAIT_MAX_MS = 3 * 60 * 1000; // the person never finished: the attempt ends quietly

// A random string (hex) from the browser's crypto.
export function randomToken(bytes = 16, cryptoObject = (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined)) {
  if (!cryptoObject || !cryptoObject.getRandomValues) throw new Error('This browser cannot start a secure sign-in.');
  const values = new Uint8Array(bytes);
  cryptoObject.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, '0')).join('');
}

// The Google sign-in address. `redirectUri` is the app's own origin, exactly what was registered with Google before.
export function buildGoogleAuthUrl({ clientId, redirectUri, state, nonce }) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'id_token', scope: GOOGLE_SCOPE, state, nonce, prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// What the address fragment says when Google sends the popup back: { state, idToken, error }, or null when it is not an answer.
export function parseCallbackHash(hash) {
  const text = String(hash || '').replace(/^#/, '');
  if (!text) return null;
  const params = new URLSearchParams(text);
  const state = params.get('state');
  const idToken = params.get('id_token');
  const error = params.get('error');
  if (!state || (!idToken && !error)) return null;
  return { state, idToken: idToken || null, error: error || null };
}

// Whether this answer is for the sign-in that was started (same state, and not stale): anything else is ignored.
export function isOurCallback(callback, pending, now = Date.now()) {
  return !!(callback && pending && typeof pending.state === 'string' && callback.state === pending.state
    && Number.isFinite(pending.at) && now - pending.at >= 0 && now - pending.at <= PENDING_MAX_AGE_MS);
}

// The nonce a Google ID token carries (only that: nothing else in the token is read here; the backend verifies the token and decides who it is).
export function nonceOf(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return null;
    const text = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const json = decodeURIComponent(Array.from(text, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
    const claims = JSON.parse(json);
    return typeof claims.nonce === 'string' ? claims.nonce : null;
  } catch {
    return null;
  }
}

// The popup's answer for the sign-in that was started:
//   { ignore: true }      not for this sign-in (another state): nothing happens
//   { idToken }           the ID token, whose nonce is ours (the backend then verifies it), or null when the person pressed Cancel at Google
//   { error }             something is wrong: a readable Error
export function outcomeOf(message, pending) {
  if (!message || !pending || message.state !== pending.state) return { ignore: true };
  if (message.error) return message.error === 'access_denied' ? { idToken: null } : { error: new Error('Google sign-in failed. Please try again.') };
  if (!message.idToken) return { error: new Error('Google did not send a sign-in token. Please try again.') };
  if (nonceOf(message.idToken) !== pending.nonce) return { error: new Error('Google sign-in could not be verified. Please try again.') };
  return { idToken: message.idToken };
}
