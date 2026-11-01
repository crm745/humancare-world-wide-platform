import { readJSON, removeKey, writeJSON } from '@/utils/storage';

const KEY = 'hcw_corporate_session';
export const SESSION_HOURS = 8;
export const REMEMBER_DAYS = 30;

export function getSession() {
  const s = readJSON(KEY, null, 'local') ?? readJSON(KEY, null, 'session');
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    clearSession();
    return null;
  }
  return s;
}

export function saveSession(session, remember) {
  clearSession();
  writeJSON(KEY, session, remember ? 'local' : 'session');
}

export function updateSessionUser(user) {
  const inLocal = readJSON(KEY, null, 'local');
  const area = inLocal ? 'local' : 'session';
  const s = inLocal ?? readJSON(KEY, null, 'session');
  if (s) writeJSON(KEY, { ...s, user }, area);
}

// Swaps in a freshly-refreshed access/refresh token pair without disturbing which
// storage area (local vs session — i.e. "remember me") the session already lives in.
// Used by http.js when the 15-minute access token expires mid-session.
export function updateSessionTokens(token, refreshToken) {
  const inLocal = readJSON(KEY, null, 'local');
  const area = inLocal ? 'local' : 'session';
  const s = inLocal ?? readJSON(KEY, null, 'session');
  if (s) writeJSON(KEY, { ...s, token, refreshToken }, area);
}

// ---- first-login restriction ----------------------------------------------------------
// A login whose password someone else chose (a provisioned Owner's temporary password)
// gets a restricted session from the backend. `passwordChangeRequired` mirrors that in the
// stored session so the restriction survives a refresh; it is only a UI hint — the backend
// decides, and answers every other call with 403 password_change_required while it is set.
export const isPasswordChangeRequired = (session = getSession()) => !!session && session.passwordChangeRequired === true;

// Rewrites the stored session in the storage area it already lives in. Returns the new
// session, or null if there is none or the browser would not keep the write.
function rewriteSession(change) {
  const inLocal = readJSON(KEY, null, 'local');
  const area = inLocal ? 'local' : 'session';
  const s = inLocal ?? readJSON(KEY, null, 'session');
  if (!s) return null;
  const next = change({ ...s });
  writeJSON(KEY, next, area);
  const saved = readJSON(KEY, null, area);
  return saved && JSON.stringify(saved) === JSON.stringify(next) ? saved : null;
}

// The backend said this account must change its password: restrict the stored session.
export function markPasswordChangeRequired() {
  return rewriteSession((s) => ({ ...s, passwordChangeRequired: true }));
}

// Swaps in the unrestricted token pair returned by a successful password change and clears
// the restriction. Null means the new tokens were not stored — the caller must not treat
// the session as upgraded.
export function completePasswordChange(token, refreshToken) {
  return rewriteSession((s) => {
    delete s.passwordChangeRequired;
    return { ...s, token, refreshToken };
  });
}

export function clearSession() {
  removeKey(KEY, 'local');
  removeKey(KEY, 'session');
}

export const getToken = () => getSession()?.token ?? null;
export const getRefreshToken = () => getSession()?.refreshToken ?? null;
