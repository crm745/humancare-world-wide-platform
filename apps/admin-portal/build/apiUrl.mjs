// Validation for VITE_API_BASE_URL, the origin of the centralized backend the Admin Portal
// calls. Used by vite.config.mjs *before* Vite writes anything, so an unsafe value stops the
// build instead of being baked into dist/. Plain Node (no dependencies) so it can be unit
// tested with `node --test`.
//
// Error messages deliberately never repeat the value: it may contain credentials.

const VAR = 'VITE_API_BASE_URL';

export class ApiUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiUrlError';
  }
}

const refuse = (problem) => {
  throw new ApiUrlError(`${VAR} ${problem}`);
};

const isUnset = (raw) => raw === undefined || raw === null || raw === '';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parse(raw, invalidMessage) {
  // Whitespace is silently stripped, and "\" is silently treated as "/", by the URL parser,
  // so both are refused up front rather than letting them change what the value means.
  if (typeof raw !== 'string' || /[\s\\]/.test(raw)) refuse(invalidMessage);
  try {
    return new URL(raw);
  } catch {
    return refuse(invalidMessage);
  }
}

/**
 * Production policy: an approved HTTPS origin. Returns the value unchanged when valid and
 * throws ApiUrlError otherwise.
 *  - present and non-empty, no whitespace
 *  - https:// only
 *  - fully qualified DNS name (contains a dot): no localhost or *.localhost, no IP literal
 *    (v4 or v6, public or private), no single-label host, no trailing dot
 *  - no username/password, query string or fragment
 *  - path empty or "/" (one trailing slash allowed); a port is allowed
 */
export function validateProductionApiUrl(raw) {
  if (isUnset(raw)) {
    refuse('is not set. Production builds require the approved HTTPS API origin (see .env.example).');
  }
  const url = parse(raw, 'is not a valid URL.');
  if (!/^https:\/\//i.test(raw)) {
    refuse(url.protocol === 'https:' ? 'is not a valid URL.' : 'must use https://.');
  }

  // Everything between "https://" and the first "/" is the authority (userinfo@host:port).
  const afterScheme = raw.slice('https://'.length);
  const authority = afterScheme.split('/')[0];
  if (authority.includes('@')) refuse('must not contain a username or password.');
  if (/[?#]/.test(raw)) refuse('must not contain a query string or fragment.');
  const path = afterScheme.slice(authority.length);
  if (path !== '' && path !== '/') refuse('must be an origin only: no path (one trailing slash is allowed).');

  // url.hostname is already normalised by the URL parser, e.g. 0x7f.1 and 2130706433 both
  // become 127.0.0.1, so tricks for writing an IP address do not get past the checks below.
  const host = url.hostname;
  if (host.startsWith('[') || host.includes(':') || IPV4.test(host)) {
    refuse('must be a DNS name, not an IP address.');
  }
  if (host === 'localhost' || host.endsWith('.localhost')) refuse('must not point at localhost.');
  if (host.endsWith('.')) refuse('must not end with a dot.');
  if (!host.includes('.')) refuse('must be a fully qualified domain name (it needs a dot).');
  const labels = host.split('.');
  if (!labels.every((label) => DNS_LABEL.test(label))) refuse('has an invalid hostname.');
  if (/^\d+$/.test(labels[labels.length - 1])) refuse('must be a DNS name, not an IP address.');

  return raw;
}

/**
 * Development policy: unset or empty means "use the localhost default" (the caller applies
 * it). A value that is supplied must be a well-formed http(s) URL, otherwise fail clearly
 * rather than silently ignoring it.
 */
export function validateDevelopmentApiUrl(raw) {
  if (isUnset(raw)) return raw;
  const url = parse(raw, 'is set but is not a valid URL. Fix it, or remove it to use the default.');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse('must be an http:// or https:// URL.');
  if (url.username || url.password) refuse('must not contain a username or password.');
  return raw;
}
