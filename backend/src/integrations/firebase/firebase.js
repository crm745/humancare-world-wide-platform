// Firebase phone verification. With PHONE_OTP_PROVIDER=firebase the app asks Firebase
// to send and check the SMS code; Firebase then gives the app a signed ID token, which
// the app passes to us instead of the code. This file checks that token.
//
// FIREBASE_SERVICE_ACCOUNT_PATH = path to the service-account JSON key (Firebase console
// > Project settings > Service accounts). Keep the file outside the repo; never commit it.
const fs = require('fs');

// firebase-admin is only loaded once Firebase is actually used, so the server (and the
// test suite, whose runner can't load one of its ESM dependencies) never pays for it
// while PHONE_OTP_PROVIDER isn't "firebase".
const admin = {
  get app() { return require('firebase-admin/app'); },
  get auth() { return require('firebase-admin/auth'); },
};

// The SMS code must have been entered recently: an ID token stays valid for an hour, but
// the proof it carries ("this person just received the SMS") should not be reusable later.
const MAX_PROOF_AGE_SECONDS = 10 * 60;

class PhoneProofError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isFirebasePhoneEnabled() {
  return process.env.PHONE_OTP_PROVIDER === 'firebase';
}

function firebaseApp() {
  const { initializeApp, cert, getApps } = admin.app;
  const existing = getApps();
  if (existing.length) return existing[0];
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH is not set');
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  return initializeApp({ credential: cert(serviceAccount) });
}

// Returns the E.164 phone number Firebase verified, or throws PhoneProofError.
async function verifyPhoneProof(idToken) {
  if (!idToken) throw new PhoneProofError('otp_invalid', 'Enter the code we sent you.');
  let decoded;
  try {
    decoded = await admin.auth.getAuth(firebaseApp()).verifyIdToken(String(idToken));
  } catch (err) {
    if (err.code === 'auth/id-token-expired') throw new PhoneProofError('otp_expired', 'Code expired.');
    if (String(err.code || '').startsWith('auth/')) throw new PhoneProofError('otp_invalid', 'Incorrect code.');
    throw err; // misconfiguration (missing/invalid key file): a server error, not the user's fault
  }
  if (decoded.firebase?.sign_in_provider !== 'phone' || !decoded.phone_number) {
    throw new PhoneProofError('otp_invalid', 'Incorrect code.');
  }
  if (Date.now() / 1000 - decoded.auth_time > MAX_PROOF_AGE_SECONDS) {
    throw new PhoneProofError('otp_expired', 'Code expired.');
  }
  return decoded.phone_number;
}

// Same checks as verifyPhoneProof, but also returns which sign-in this was, for flows that
// must accept each SMS confirmation only once (the corporate registration flows). `uid` and
// `auth_time` together identify one confirmation: a refreshed ID token for the same sign-in
// keeps both, a new SMS gets a new auth_time. verifyPhoneProof is left exactly as it is so
// the patient flows are untouched; unlike it, this refuses a token without an integer
// auth_time or a uid instead of letting a missing auth_time slip past the freshness check.
async function verifyPhoneProofDetails(idToken) {
  if (!idToken) throw new PhoneProofError('otp_invalid', 'Enter the code we sent you.');
  let decoded;
  try {
    decoded = await admin.auth.getAuth(firebaseApp()).verifyIdToken(String(idToken));
  } catch (err) {
    if (err.code === 'auth/id-token-expired') throw new PhoneProofError('otp_expired', 'Code expired.');
    if (String(err.code || '').startsWith('auth/')) throw new PhoneProofError('otp_invalid', 'Incorrect code.');
    throw err; // misconfiguration (missing/invalid key file): a server error, not the user's fault
  }
  if (decoded.firebase?.sign_in_provider !== 'phone' || !decoded.phone_number) {
    throw new PhoneProofError('otp_invalid', 'Incorrect code.');
  }
  const uid = decoded.uid || decoded.sub;
  const authTime = decoded.auth_time;
  if (!uid || !Number.isInteger(authTime)) throw new PhoneProofError('otp_invalid', 'Incorrect code.');
  const age = Date.now() / 1000 - authTime;
  if (age > MAX_PROOF_AGE_SECONDS) throw new PhoneProofError('otp_expired', 'Code expired.');
  if (age < -60) throw new PhoneProofError('otp_invalid', 'Incorrect code.'); // from the future
  return { phone: decoded.phone_number, uid: String(uid), authTime };
}

module.exports = { isFirebasePhoneEnabled, verifyPhoneProof, verifyPhoneProofDetails, PhoneProofError, MAX_PROOF_AGE_SECONDS };
