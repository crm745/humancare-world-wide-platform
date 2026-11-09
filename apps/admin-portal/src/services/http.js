// Axios clients for the centralized backend.
//
//  http        - the signed-in session. Authentication is the HTTP-only access/refresh cookies the
//                server sets at sign-in: `withCredentials` makes the browser send them, and nothing
//                here (or anywhere) reads or stores a token. State-changing requests carry the
//                custom `X-HC-Admin: 1` header the backend requires (a cross-site page cannot send
//                it without a CORS preflight, which the server refuses); the browser adds the
//                Origin header itself. An expired access cookie is renewed once, transparently,
//                through POST /admin/refresh before the original request is repeated.
//  publicHttp  - the endpoints that need no session (invitation links, the recovery steps).
//                It never sends cookies, so an ordinary Admin session is not attached to them.
import axios from 'axios';
import { API_BASE_URL, ApiError, UNAUTHORIZED_EVENT } from './config';
import { errorMessage, readErrorBody } from './errorBody.mjs';

export const CSRF_HEADER = 'X-HC-Admin';
const STATE_CHANGING = new Set(['post', 'put', 'patch', 'delete']);
const REFRESH_RETRY_WAIT_MS = 1000;

const base = { baseURL: API_BASE_URL, timeout: 20000, headers: { 'Content-Type': 'application/json' } };

export const http = axios.create({ ...base, withCredentials: true });
export const publicHttp = axios.create({ ...base, withCredentials: false });

// The server's own message, code and body when it sent them; otherwise a fixed text. A JSON error that
// arrived as a Blob (a failed `responseType: 'blob'` download) is read too. Axios's message (which can
// quote URLs or bodies) is never shown. `body` lets callers read fields beyond `error` and `code`, e.g.
// the approval `blockers` on a 409.
async function toApiError(err) {
  const status = err.response?.status ?? 0;
  const body = await readErrorBody(err.response?.data);
  return new ApiError(errorMessage(body, status), status, body?.code, body);
}

http.interceptors.request.use((config) => {
  if (STATE_CHANGING.has(String(config.method).toLowerCase())) config.headers.set(CSRF_HEADER, '1');
  return config;
});

// One refresh at a time: simultaneous 401s share it.
let refreshing = null;

// Resolves to 'renewed', 'invalid' (the server answered 401: the session is gone) or 'failed'
// (network error, 5xx, 403, 429...: nothing is known about the session).
async function renewSession() {
  try {
    await axios.post(`${API_BASE_URL}/admin/refresh`, null, {
      withCredentials: true,
      timeout: base.timeout,
      headers: { [CSRF_HEADER]: '1' },
    });
    return 'renewed';
  } catch (err) {
    // 409: another tab rotated the token a moment ago and its cookies are already in the jar.
    if (err.response?.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_WAIT_MS));
      return 'renewed';
    }
    return err.response?.status === 401 ? 'invalid' : 'failed';
  }
}

export function refreshOnce() {
  if (!refreshing) {
    refreshing = renewSession().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

http.interceptors.response.use(
  (res) => res,
  async (err) => {
    // A cancelled request is not a failure.
    if (axios.isCancel(err)) return Promise.reject(err);
    if (err instanceof ApiError) return Promise.reject(err);

    const status = err.response?.status ?? 0;
    const config = err.config;

    // The 15-minute access cookie has lapsed: renew it once and repeat the request. Calls that
    // must not do this (sign-in steps, refresh, logout) opt out with `skipRefresh`.
    if (status === 401 && config && !config.skipRefresh && !config.alreadyRetried) {
      config.alreadyRetried = true;
      if ((await refreshOnce()) === 'renewed') return http.request(config);
    }

    // Still unauthorised: tell the app so it can drop in-memory state. Calls that expect this (the
    // sign-in steps, the boot-time /admin/me probe) opt out with `skipUnauthorizedEvent`.
    if (status === 401 && !config?.skipUnauthorizedEvent) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    return Promise.reject(await toApiError(err));
  },
);

publicHttp.interceptors.response.use(
  (res) => res,
  async (err) => (axios.isCancel(err) ? Promise.reject(err) : Promise.reject(await toApiError(err))),
);
