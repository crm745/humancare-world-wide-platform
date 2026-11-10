// No `/api` prefix — the backend mounts its routers directly (/admin/login, ...).
//
// The API origin comes from VITE_API_BASE_URL. Development falls back to the local
// backend; a production bundle never does. `import.meta.env.DEV` is a compile-time constant,
// so the localhost default below is removed from production builds entirely. The build
// itself also refuses to run without a valid HTTPS value (see build/apiUrl.mjs and
// vite.config.mjs), so the throw at the bottom is only a last line of defence.
function resolveApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL;

  if (import.meta.env.DEV) {
    if (configured === undefined || configured === '') return 'http://localhost:4000';
    let url = null;
    try {
      url = new URL(configured);
    } catch {
      /* handled below */
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error('VITE_API_BASE_URL is set but is not a valid http(s) URL. Fix it, or remove it to use the default.');
    }
    return configured;
  }

  if (!configured) throw new Error('VITE_API_BASE_URL was not set when this app was built.');
  return configured;
}

export const API_BASE_URL = resolveApiBaseUrl();

export class ApiError extends Error {
  // `body` is the parsed error response (or undefined), so callers can read fields beyond
  // `error` and `code`, e.g. the approval `blockers` on a 409.
  constructor(message, status = 0, code = undefined, body = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export const UNAUTHORIZED_EVENT = 'hcw-admin:unauthorized';
