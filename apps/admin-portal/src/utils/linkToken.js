// Invitation links carry their one-time token in the URL FRAGMENT (`/path#token=...`), which the
// browser never sends to a server and which does not appear in access logs or Referer headers.
//
// The token is read once into component memory and the fragment is removed from the address bar
// and the history entry straight away, so it is not left in the URL, a screenshot or a shared
// link. It is never written to web storage, a cookie or the console.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url - the shape the backend accepts

/** The token from `#token=...`, or null if it is missing or malformed. Has no side effects. */
export function readFragmentToken() {
  const match = /(?:^#|&)token=([^&]*)/.exec(window.location.hash);
  if (!match) return null;
  let value;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return TOKEN_PATTERN.test(value) ? value : null;
}

/** Drops the fragment from the current URL without adding a history entry or reloading. */
export function clearFragment() {
  if (!window.location.hash) return;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}
