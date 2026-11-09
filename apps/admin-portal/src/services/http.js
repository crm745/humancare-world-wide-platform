// Axios client for the centralized backend. Authentication is the HTTP-only
// `hc_admin_token` cookie the server sets on login: `withCredentials` makes the browser
// send it, and nothing here (or anywhere) reads or stores a token.
import axios from 'axios';
import { API_BASE_URL, ApiError, UNAUTHORIZED_EVENT } from './config';
import { errorMessage, readErrorBody } from './errorBody.mjs';

export const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.response.use(
  (res) => res,
  async (err) => {
    // A cancelled request is not a failure.
    if (axios.isCancel(err)) return Promise.reject(err);

    const status = err.response?.status ?? 0;

    // The 15-minute session cookie has lapsed (or was never there): tell the app so it
    // can drop in-memory state. Calls that expect this (login, the boot-time /admin/me
    // probe) opt out with `skipUnauthorizedEvent`.
    if (status === 401 && !err.config?.skipUnauthorizedEvent) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }

    // Also reads a JSON error that arrived as a Blob (a failed `responseType: 'blob'` download).
    const body = await readErrorBody(err.response?.data);
    return Promise.reject(new ApiError(errorMessage(body, status), status, body?.code, body));
  },
);
