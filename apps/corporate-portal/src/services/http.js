// Axios client for the Node.js/Express backend. Attaches the JWT and turns errors into ApiError.
// Only used when VITE_USE_MOCK_API=false.
import axios from 'axios';
import { API_BASE_URL, ApiError } from './config';
import { clearSession, getRefreshToken, getToken, markPasswordChangeRequired, updateSessionTokens } from './session';

export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// The backend's access token only lives 15 minutes (by design) — that's routine, not
// a real logout, so a 401 triggers one silent refresh-and-retry before giving up.
// De-duped so several requests failing at once only trigger a single /auth/refresh
// call. Uses a bare axios call (not `http`) so this can never recurse into itself.
let refreshPromise = null;
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) throw new Error('Not logged in');
      const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken });
      updateSessionTokens(data.token, data.refreshToken);
      return data.token;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

http.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status = err.response?.status ?? 0;
    const original = err.config;

    // Only attempt a refresh for an authenticated call (a token was actually sent)
    // that hasn't already been retried once, to avoid an infinite loop.
    if (status === 401 && getToken() && original && !original._retriedAfterRefresh) {
      original._retriedAfterRefresh = true;
      try {
        const token = await refreshAccessToken();
        original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
        return http(original);
      } catch {
        clearSession();
        window.dispatchEvent(new Event('hcw:unauthorized'));
        return Promise.reject(new ApiError('Your session expired. Please sign in again.', 401));
      }
    }

    if (status === 401) {
      clearSession();
      window.dispatchEvent(new Event('hcw:unauthorized'));
    }
    // The backend is the authority on the first-login restriction: if it refuses a call
    // for that reason, restrict the stored session too, so the portal shows the password
    // change screen even if its own copy of the flag was missing.
    if (status === 403 && err.response?.data?.code === 'password_change_required' && getToken()) {
      markPasswordChangeRequired();
      window.dispatchEvent(new Event('hcw:password-change-required'));
    }
    const message =
      err.response?.data?.error ??
      err.response?.data?.message ??
      (status === 0 ? 'Unable to reach the server. Check your connection and try again.' : 'Something went wrong. Please try again.');
    return Promise.reject(new ApiError(message, status));
  },
);
