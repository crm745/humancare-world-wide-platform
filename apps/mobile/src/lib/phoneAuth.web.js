// Firebase phone sign-in for the web build (Firebase JS SDK). Same functions as
// phoneAuth.native.js. Firebase requires an (invisible) reCAPTCHA check on web before it
// sends an SMS; it's created here on demand. Config comes from EXPO_PUBLIC_FIREBASE_*
// in mobile/.env (Firebase console > Project settings > Your apps > Web app). These
// values identify the project; they are not secrets.
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, getIdToken, RecaptchaVerifier, signInWithPhoneNumber, signOut } from 'firebase/auth';
import { phoneAuthError } from './phoneAuthErrors';
import { withConfirmTimeout, withSendTimeout } from './phoneAuthTimeout';

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

function firebaseAuth() {
  if (!config.apiKey || !config.appId) {
    throw Object.assign(new Error("Phone verification isn't set up for the web app yet."), { code: 'phone_auth_not_configured' });
  }
  return getAuth(getApps()[0] || initializeApp(config));
}

// One invisible reCAPTCHA for the whole page, reset before each further send (Firebase's
// recommended way to resend). Removing and re-creating it instead breaks Google's script
// if a challenge from the previous send is still running ("reading 'style' of null").
let verifier = null;
let widgetId = null;
async function readyVerifier(auth) {
  if (!verifier) {
    const el = document.createElement('div');
    el.id = 'firebase-recaptcha';
    document.body.appendChild(el);
    verifier = new RecaptchaVerifier(auth, el, { size: 'invisible' });
    widgetId = await verifier.render();
  } else if (window.grecaptcha && widgetId !== null) {
    window.grecaptcha.reset(widgetId);
  }
  return verifier;
}

// Returns a handle to pass to confirmPhoneCode. The whole step (reCAPTCHA and the SMS request) has a time limit (lib/phoneAuthTimeout.js); a handle that arrives after it is dropped.
export async function sendPhoneCode(phoneNumber) {
  const step = (async () => {
    try {
      const auth = firebaseAuth();
      return await signInWithPhoneNumber(auth, phoneNumber, await readyVerifier(auth));
    } catch (err) {
      if (err.code === 'phone_auth_not_configured') throw err;
      throw phoneAuthError(err, "We couldn't send the code. Please try again.");
    }
  })();
  return withSendTimeout(step);
}

// Returns Firebase's ID token (the proof our backend checks).
// The step has a time limit; if it finishes later, its own clean-up (dropping Firebase's session) still runs and the token is simply not used.
export async function confirmPhoneCode(confirmation, code) {
  const step = (async () => {
    try {
      const auth = firebaseAuth();
      const { user } = await confirmation.confirm(code);
      const token = await getIdToken(user);
      await signOut(auth);
      return token;
    } catch (err) {
      throw phoneAuthError(err);
    }
  })();
  return withConfirmTimeout(step);
}
