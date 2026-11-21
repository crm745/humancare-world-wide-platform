// Firebase phone sign-in on iOS/Android (@react-native-firebase). Firebase sends the SMS
// and checks the code; we only keep the ID token it returns, which the backend verifies.
// Firebase's own sign-in session is dropped straight away — the app uses our session.
//
// The native module is required lazily: Expo Go doesn't include it, and this way the
// app still runs there as long as the backend isn't in Firebase mode.
import { phoneAuthError } from './phoneAuthErrors';
import { withConfirmTimeout, withSendTimeout } from './phoneAuthTimeout';

function firebaseAuth() {
  return require('@react-native-firebase/auth');
}

// Returns a handle to pass to confirmPhoneCode.
// The SMS request has a time limit (lib/phoneAuthTimeout.js); a handle that arrives after it is dropped.
export async function sendPhoneCode(phoneNumber) {
  const { getAuth, signInWithPhoneNumber } = firebaseAuth();
  const step = (async () => {
    try {
      return await signInWithPhoneNumber(getAuth(), phoneNumber);
    } catch (err) {
      throw phoneAuthError(err, "We couldn't send the code. Please try again.");
    }
  })();
  return withSendTimeout(step);
}

// Returns Firebase's ID token (the proof our backend checks).
// The step has a time limit; if it finishes later, its own clean-up (dropping Firebase's session) still runs and the token is simply not used.
export async function confirmPhoneCode(confirmation, code) {
  const { getAuth, getIdToken, signOut } = firebaseAuth();
  const step = (async () => {
    try {
      const credential = await confirmation.confirm(code);
      // Android can verify the SMS by itself and sign in before the code is typed; then
      // confirm() has nothing left to return and the signed-in user is the one we want.
      const user = credential?.user || getAuth().currentUser;
      if (!user) throw Object.assign(new Error('No user after confirm'), { code: 'auth/invalid-verification-code' });
      const token = await getIdToken(user);
      await signOut(getAuth());
      return token;
    } catch (err) {
      throw phoneAuthError(err);
    }
  })();
  return withConfirmTimeout(step);
}
