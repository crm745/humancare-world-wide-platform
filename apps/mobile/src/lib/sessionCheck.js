// Finds out whether the saved session is really valid, by asking the server (a saved token that has
// expired, been revoked or been forged must not count as signed in). Pure: the two functions it needs
// are passed in, so it is unit-tested without a network or a device. It never throws and never hangs.
//
//   no saved token                                        -> { status: 'anon' }
//   the server accepts it (apiGet renewed an expired one) -> { status: 'authed', me }
//   the server refuses it (401), or the session could not be renewed       -> { status: 'anon' }
//   (403 is NOT a refusal of the session: GET /auth/me never answers 403 for an expired or invalid token — see the
//   backend's requireAuth and getMe, where every bad token is a 401 and a restricted first-login session is let
//   through — so a 403 here is something else (a proxy, a role/permission denial) and says nothing about the
//   session. It is treated like any unexpected answer: nothing granted, nothing cleared, retry.)
//   the server could not be reached / answered with an error / took too long -> { status: 'unreachable' }
//   the saved session could not be read (secure storage failed or hung)       -> { status: 'error' }
// 'unreachable' and 'error' grant nothing: the screen stays covered and the person can retry.
//
// A timeout does not stop the underlying work by itself, so the server call gets an AbortSignal that is aborted
// when the time is up or when `signal` (a newer check, a sign-in, a sign-out) says this check no longer matters.
// Whatever the call still does after that cannot change anything: the caller drops an outdated answer
// (authState.js), a late renewal only saves tokens if they are still current (session.js), and a late failure only
// ends the session it was made for (api.js).
export const TOKEN_TIMEOUT_MS = 4000;
export const ME_TIMEOUT_MS = 20000;

function withTimeout(promiseOrValue, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('timed out'); e.timedOut = true; reject(e); }, ms);
  });
  return Promise.race([Promise.resolve(promiseOrValue), timeout]).finally(() => clearTimeout(timer));
}

export async function checkSession({ getToken, fetchMe, signal, tokenTimeoutMs = TOKEN_TIMEOUT_MS, meTimeoutMs = ME_TIMEOUT_MS }) {
  // A check that has already been cancelled starts nothing: no token read, no /auth/me.
  if (signal?.aborted) return { status: 'aborted' };
  let token;
  try {
    token = await withTimeout(getToken(), tokenTimeoutMs);
  } catch {
    return { status: 'error' };
  }
  if (!token) return { status: 'anon' };
  if (signal?.aborted) return { status: 'aborted' }; // cancelled while the token was being read

  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
  try {
    const me = await withTimeout(fetchMe(controller.signal), meTimeoutMs);
    return { status: 'authed', me };
  } catch (err) {
    controller.abort(); // a timeout leaves the request running; stop it
    if (signal?.aborted) return { status: 'aborted' };
    if (err?.status === 401) return { status: 'anon' };
    if (err?.timedOut) return { status: 'unreachable' };
    // apiFetch signs out and rejects without a status when the refresh token is refused; the tokens are
    // gone by then, which is how that case is told apart from a network failure.
    try {
      if (!(await withTimeout(getToken(), tokenTimeoutMs))) return { status: 'anon' };
    } catch {
      return { status: 'error' };
    }
    return { status: 'unreachable' };
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
