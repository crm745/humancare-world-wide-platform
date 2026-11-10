import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getAccessToken, getRefreshToken, compareAndSaveTokens, compareAndClearTokens } from './session';
import { hasValidTokens } from './tokens';
import { navReplace } from './nav';
import { ensureAuthenticated, getCurrentPath, isPublicApiPath, loginRouteFor } from './authGuard';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

// ---- how a failed renewal is told apart ---------------------------------------------------------------------
// Only a refusal the server has confirmed ends the session. A network failure, a timeout, a 5xx or any other
// unexpected answer says nothing about the credentials, so they are kept and the person can try again.
//   invalid      the refresh token is invalid, expired or revoked (HTTP 401): sign out
//   unavailable  network error, timeout, 5xx, other status, or an unreadable answer: keep the credentials
//   signedOut    the person signed out (or in again) while the renewal ran: nothing to do
export const REFRESH_TIMEOUT_MS = 15000;
let refreshTimeoutMs = REFRESH_TIMEOUT_MS;
export const setRefreshTimeoutForTests = (ms) => { refreshTimeoutMs = ms; };

const kinded = (kind, message, extra = {}) => Object.assign(new Error(message), { kind, ...extra });
const sessionExpired = () => Object.assign(new Error('Your session expired. Please log in again.'), { status: 401, code: 'session_expired' });
const unavailable = () => Object.assign(new Error('Could not reach the server. Please try again.'), { code: 'network' });

// De-dupes concurrent refresh attempts: if three requests all hit an expired access
// token at once, only one actual /auth/refresh call goes out; the other two just wait
// on the same promise instead of racing each other.
let refreshPromise = null;

async function runRefresh() {
  let refreshToken;
  try {
    refreshToken = await getRefreshToken();
  } catch {
    throw kinded('unavailable', 'Secure storage could not be read', { code: 'storage' });
  }
  if (!refreshToken) throw kinded('invalid', 'Not logged in');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
  let res;
  try {
    res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
  } catch {
    throw kinded('unavailable', 'The refresh request did not complete', { code: controller.signal.aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw kinded('invalid', 'Invalid or expired refresh token');
  if (!res.ok) throw kinded('unavailable', `Refresh answered ${res.status}`, { code: res.status >= 500 ? 'server' : 'unexpected' });
  const data = await res.json().catch(() => null);
  if (!hasValidTokens(data)) throw kinded('unavailable', 'Refresh answered without credentials', { code: 'unexpected' });

  // Saved only if the refresh token used is still the saved one (see session.js): a sign-out, or a new login, that
  // happened while this was in flight is not undone. Saving is not a sign-in (no { signIn }); a refresh grants nothing.
  let saved;
  try {
    saved = await compareAndSaveTokens({ expectedRefreshToken: refreshToken, token: data.token, refreshToken: data.refreshToken });
  } catch {
    throw kinded('unavailable', 'The renewed credentials could not be stored', { code: 'storage' });
  }
  if (!saved) throw kinded('signedOut', 'Signed out');
  return data.token;
}

function refreshAccessToken() {
  if (!refreshPromise) refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// Ends the session and goes to Login, but only if the saved token is still `usedToken`, the one the failing call
// was made with. The comparison and the deletion are one step inside session.js's queue (compareAndClearTokens),
// so a failure that belongs to an older session (the person signed out, or signed in again, since) deletes nothing
// and redirects nobody, and cannot end their new one. The redirect happens only when the pair was really deleted.
async function endSession(usedToken) {
  let outcome;
  try {
    outcome = await compareAndClearTokens(usedToken);
  } catch {
    return; // the saved token cannot be read: leave things as they are
  }
  if (outcome === 'cleared') navReplace(loginRouteFor(getCurrentPath()));
}

// After a 401: renew the session. Returns when new tokens are saved; otherwise throws what the caller should show.
async function renewSession(usedToken) {
  try {
    await refreshAccessToken();
  } catch (err) {
    if (err.kind === 'invalid') {
      // The session can't be renewed (expired, revoked, or signed out by a password reset). They already
      // have an account, so send them to Login rather than Get Started.
      await endSession(usedToken);
      throw sessionExpired();
    }
    if (err.kind === 'signedOut') throw sessionExpired();
    throw unavailable(); // credentials are kept
  }
}

// The retried call also answered 401. That may be this endpoint's own answer (a wrong code on a signed-in
// screen is a 401 too), so ask the server whether the session is still good before ending it. Returns
// normally unless the server confirms the session is invalid; a network failure ends nothing.
async function endSessionIfInvalid(token) {
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
    try {
      res = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  }
  if (res.status === 401) {
    await endSession(token);
    throw sessionExpired();
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError', code: 'aborted' });
};

const notSignedIn = () => Object.assign(new Error('Please log in to continue.'), { status: 401, code: 'not_signed_in' });

async function apiFetch(path, options = {}, isRetry = false) {
  const { validation, ...fetchOptions } = options;
  throwIfAborted(fetchOptions.signal);
  const needsSession = !isPublicApiPath(path);
  // A call that needs a signed-in person waits until the session has been checked and is sent only if it is
  // valid (the check itself is the one exception). Public calls, like logging in, go on.
  if (needsSession && !validation && !isRetry) await ensureAuthenticated();

  const token = await getAccessToken();
  if (!token && needsSession) {
    navReplace(loginRouteFor(getCurrentPath()));
    throw notSignedIn();
  }
  throwIfAborted(fetchOptions.signal); // the waits above can outlast the caller's interest
  const res = await fetch(`${API_URL}${path}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  });

  // Only an expired *access* token should trigger a silent refresh — `token` being
  // set means this was actually an authenticated call, not a login attempt that
  // failed for its own reason (wrong password/OTP), which also returns 401.
  if (res.status === 401 && token && !isRetry) {
    await renewSession(token);
    return apiFetch(path, options, true);
  }
  if (res.status === 401 && token && isRetry) await endSessionIfInvalid(token);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `code` / `secondsLeft` let auth screens show the specific inline
    // message (wrong vs expired OTP, account locked) instead of a generic toast.
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.code = data.code;
    err.secondsLeft = data.secondsLeft;
    err.data = data;
    throw err;
  }
  return data;
}

// `options` is for the session check (`{ signal, validation: true }`), which is allowed through while loading.
export function apiGet(path, options) {
  return apiFetch(path, options);
}

export function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

export function apiPatch(path, body) {
  return apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
}

// File uploads go through FormData, which needs its own multipart boundary in the
// Content-Type header — fetch sets that automatically, but only if we don't also set
// 'Content-Type': 'application/json' like apiFetch does for everything else.
//
// `onProgress(fraction)` is called with a 0–1 value as the upload advances, so the
// caller can show a real percentage instead of a silent 10-15s wait on a big medical
// PDF over a slow connection. Plain fetch has no upload-progress event on any
// platform, so this branches: native uses expo-file-system's upload task (which
// reports progress natively), web uses XMLHttpRequest (whose `upload.onprogress` is
// the one place that web API still beats fetch).
//
// `fields` (optional) are extra text fields sent next to the file in the same multipart body, e.g.
// { replacesDocumentId: 12 } to mark an earlier document as replaced. The file is always sent in the
// `file` field of the same request; a missing/empty `fields` leaves the upload exactly as it was.
// Values are sent as text, and null, undefined and '' are left out. A `file` key is ignored.
//
// Callers pass (path, file, false, onProgress[, fields]); `isRetry` is only used by the retry below.
function formFields(fields) {
  return Object.entries(fields || {})
    .filter(([key, value]) => key !== 'file' && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)]);
}

export async function apiUpload(path, file, isRetry = false, onProgress, fields) {
  // Uploads always belong to a signed-in person: held until the session is known, and sent only if it is valid.
  if (!isRetry) await ensureAuthenticated();
  const token = await getAccessToken();
  if (!token) {
    navReplace(loginRouteFor(getCurrentPath()));
    throw notSignedIn();
  }
  const url = `${API_URL}${path}`;
  const extra = formFields(fields);

  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = async () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* no/invalid body */ }

        if (xhr.status === 401 && !isRetry) {
          try {
            await renewSession(token);
          } catch (err) {
            reject(err);
            return;
          }
          apiUpload(path, file, true, onProgress, fields).then(resolve, reject);
          return;
        }
        if (xhr.status === 401 && isRetry) {
          try {
            await endSessionIfInvalid(token);
          } catch (err) {
            reject(err);
            return;
          }
        }

        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload failed. Please try again.'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Please try again.'));
      // A browser needs the file itself in the form: the { uri, name, type } object that React
      // Native accepts there turns into the text "[object Object]" and the server sees no file.
      // The picked file's uri is a blob: URL, so fetch it back into a Blob.
      fetch(file.uri)
        .then((res) => res.blob())
        .then((blob) => {
          const form = new FormData();
          for (const [key, value] of extra) form.append(key, value);
          const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType || 'application/octet-stream');
          form.append('file', typed, file.name);
          xhr.send(form);
        })
        .catch(() => reject(new Error('Upload failed. Please try again.')));
    });
  }

  const task = FileSystem.createUploadTask(
    url,
    file.uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: file.mimeType || 'application/octet-stream',
      headers: { Authorization: `Bearer ${token}` },
      ...(extra.length ? { parameters: Object.fromEntries(extra) } : {}),
    },
    (progress) => {
      if (onProgress && progress.totalBytesExpectedToSend > 0) {
        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
      }
    },
  );

  const result = await task.uploadAsync();
  let data = {};
  try { data = JSON.parse(result.body); } catch { /* no/invalid body */ }

  if (result.status === 401 && !isRetry) {
    await renewSession(token);
    return apiUpload(path, file, true, onProgress, fields);
  }
  if (result.status === 401 && isRetry) await endSessionIfInvalid(token);

  if (result.status < 200 || result.status >= 300) throw new Error(data.error || 'Upload failed. Please try again.');
  return data;
}
