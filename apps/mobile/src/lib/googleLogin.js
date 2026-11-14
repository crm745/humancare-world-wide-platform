// One Google sign-in attempt, from the tap to the signed-in screen. Pure (every step is passed in), so each outcome can be unit-tested.
//
//   begin()                  numbers the attempt (session.js beginSignIn), so an answer that arrives after a newer sign-in or a sign-out is refused
//   getIdToken()             opens Google's account picker; the person's ID token, or null if they did not finish
//   postToken(idToken)       the backend verifies the token and creates the session: { token, refreshToken, user }
//   afterLogin(data, attempt) saves the session and goes to the screen that follows. It runs ONLY after the backend said yes.
//   reopenPicker()           (optional, web) brings the picker window back
//
// `guard` is { busy: false } kept by the caller: a second tap while an attempt is running does nothing: no second request. While the picker
// is still open, though, a second tap puts the picker window back in front (the person may have lost it), without starting a new attempt.
// Returns 'busy' | 'cancelled' | 'done'. Anything that goes wrong is thrown to the caller, which shows it.
export async function runGoogleLogin({ begin, getIdToken, postToken, afterLogin, reopenPicker }, guard) {
  if (guard.busy) {
    if (guard.phase === 'picker' && reopenPicker) reopenPicker();
    return 'busy';
  }
  guard.busy = true;
  guard.phase = 'picker';
  try {
    const attempt = begin();
    const idToken = await getIdToken();
    if (!idToken) return 'cancelled';
    guard.phase = 'backend';
    await afterLogin(await postToken(idToken), attempt);
    return 'done';
  } finally {
    guard.busy = false;
    guard.phase = null;
  }
}
