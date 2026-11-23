// Tells the server a patient session has ended, so its refresh token stops working (POST /auth/logout). Pure apart from `fetch`, which is injected.
//
// Best effort and never in the person's way: it never throws, it is not awaited by the sign-out, it gives up after LOGOUT_TIMEOUT_MS, it sends only the refresh token (no body about the person) and it
// never retries by itself. If the phone is offline the call fails and the sign-out still completes locally: the refresh token then stays valid on the server until it expires (30 days) or the
// account's tokens are revoked by another sign-out or a password reset. Any answer from the server counts as delivered (the server always answers 200 for this call, or 400 for a bad request).
export const LOGOUT_TIMEOUT_MS = 8000;
export const LOGOUT_PATH = '/auth/logout';

// -> 'sent' | 'skipped' (nothing to revoke) | 'failed' (no answer)
export async function revokeServerSession({ refreshToken, baseUrl, fetchImpl, timeoutMs = LOGOUT_TIMEOUT_MS }) {
  if (typeof refreshToken !== 'string' || !refreshToken || !baseUrl) return 'skipped';
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return 'failed';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await doFetch(`${baseUrl}${LOGOUT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    return 'sent';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
