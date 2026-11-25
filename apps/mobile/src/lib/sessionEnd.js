// Ends the signed-in session: the one sequence behind "Log out" (Profile) and the idle timeout. Pure (everything it uses is passed in), so the order can be unit-tested; lib/signOut.js wires the real parts.
//
//   1. the refresh token is read (a patient only: corporate and admin sessions have nothing to revoke on the server);
//   2. `beforeClear` runs while the account can still be read from the tokens (Log out uses it to remove the saved draft; the idle timeout does not: a draft is encrypted and is not thrown away);
//   3. the server is told in the background (never awaited: signing out does not wait for the network);
//   4. the tokens are cleared. The app state moves to signed out and the sign-in screen opens.
// A failure in 1 to 3 never stops 4: the person is always signed out on the phone.
export async function endSession({ isCorporate = false, readRefreshToken, revoke, clear, beforeClear = null }) {
  let refreshToken = null;
  if (!isCorporate && readRefreshToken) {
    try { refreshToken = await readRefreshToken(); } catch { refreshToken = null; }
  }
  if (beforeClear) {
    try { await beforeClear(); } catch { /* nothing to clean up is the same as cleaned up */ }
  }
  if (refreshToken && revoke) {
    try { Promise.resolve(revoke(refreshToken)).catch(() => undefined); } catch { /* best effort */ }
  }
  await clear();
}
