// Firebase phone verification. With PHONE_OTP_PROVIDER=firebase the app asks Firebase
// to send and check the SMS code; Firebase then gives the app a signed ID token, which
// the app passes to us instead of the code. This file checks that token.
//
// FIREBASE_SERVICE_ACCOUNT_PATH = path to the service-account JSON key (Firebase console
// > Project settings > Service accounts). Keep the file outside the repo; never commit it.
// An absolute path is used as it is; a relative one is resolved against the backend folder
// (not the folder the server happened to be started from).
const fs = require('fs');
const path = require('path');

// backend/ (this file is backend/src/integrations/firebase/firebase.js)
const BACKEND_DIR = path.resolve(__dirname, '..', '..', '..');
const KEY_PATH_VARIABLE = 'FIREBASE_SERVICE_ACCOUNT_PATH';
const REQUIRED_KEY_FIELDS = ['project_id', 'client_email', 'private_key'];

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

// The Firebase setup is wrong (not the user's fault): the key file is missing, unreadable,
// not JSON, or incomplete. Messages name the variable and the file's path, never its content.
class FirebaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirebaseConfigError';
    this.code = 'firebase_not_configured';
  }
}

function resolveKeyPath(rawPath = process.env[KEY_PATH_VARIABLE]) {
  const value = String(rawPath || '').trim();
  if (!value) {
    throw new FirebaseConfigError(
      `${KEY_PATH_VARIABLE} is not set. Set it in backend/.env to the Firebase service-account JSON key `
      + '(Firebase console > Project settings > Service accounts), stored outside the repository.',
    );
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(BACKEND_DIR, value);
}

// Reads and checks the key file. Returns the parsed key; the key itself is never logged.
function loadServiceAccount(keyPath = resolveKeyPath()) {
  const where = `The Firebase service-account file at "${keyPath}" (${KEY_PATH_VARIABLE})`;
  let text;
  try {
    text = fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new FirebaseConfigError(
        `${where} does not exist. Download the key from the Firebase console and point ${KEY_PATH_VARIABLE} at it.`,
      );
    }
    throw new FirebaseConfigError(`${where} could not be read (${err.code || 'unknown error'}).`);
  }
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    throw new FirebaseConfigError(`${where} is not valid JSON.`);
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    throw new FirebaseConfigError(`${where} is not a service-account key (expected a JSON object).`);
  }
  if (key.type !== undefined && key.type !== 'service_account') {
    throw new FirebaseConfigError(`${where} is not a service-account key (its "type" is not "service_account").`);
  }
  const missing = REQUIRED_KEY_FIELDS.filter((field) => typeof key[field] !== 'string' || !key[field].trim());
  if (missing.length) {
    throw new FirebaseConfigError(`${where} is missing required field(s): ${missing.join(', ')}.`);
  }
  return key;
}

// The Admin SDK is created once and reused (also when something else already created one).
let cachedApp = null;
function firebaseApp() {
  if (cachedApp) return cachedApp;
  const { initializeApp, cert, getApps } = admin.app;
  const existing = getApps();
  if (existing.length) {
    cachedApp = existing[0];
    return cachedApp;
  }
  const keyPath = resolveKeyPath();
  const serviceAccount = loadServiceAccount(keyPath);
  let credential;
  try {
    credential = cert(serviceAccount);
  } catch (err) {
    throw new FirebaseConfigError(`The Firebase service-account key at "${keyPath}" could not be used: ${err.message}`);
  }
  cachedApp = initializeApp({ credential });
  return cachedApp;
}

// For server start-up: loads and checks the credentials (no network call) so a wrong setup
// stops the server with a clear message instead of failing on the first user's OTP.
function assertFirebaseConfigured() {
  firebaseApp();
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

module.exports = {
  isFirebasePhoneEnabled,
  verifyPhoneProof,
  verifyPhoneProofDetails,
  PhoneProofError,
  MAX_PROOF_AGE_SECONDS,
  FirebaseConfigError,
  resolveKeyPath,
  loadServiceAccount,
  firebaseApp,
  assertFirebaseConfigured,
};
