// Razorpay settings. Same convention as the Bitrix switches (bitrix-config.js): payments are ON only when the master switch is
// EXACTLY PAYMENTS_ENABLED=true; a missing or misspelled value keeps them off. Everything is read from the environment at call
// time (never at import), so both the API's .env loader and the tests' .env.test loader work, and nothing is cached.
//
// The Key ID is public (it is sent to the app for Checkout). The Key Secret is NEVER returned, logged, stored or put in an error: it
// is read only by razorpay.api.js, to build the Basic authorization header for one request.
const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
const MIN_SECRET_LENGTH = 8;
// The environment identifier (PAYMENTS_ENVIRONMENT_ID): a short, stable, lower-case name such as development, test, staging or production. It is
// written into every Razorpay order's notes and checked again before any order is recovered, so one environment can never attach an order
// created by another environment that shares the same Razorpay account. It is NEVER inferred from NODE_ENV: it must be configured explicitly.
const ENVIRONMENT_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

function isPaymentsEnabled(env = process.env) {
  return env.PAYMENTS_ENABLED === 'true';
}

// Live (Razorpay "rzp_live_") credentials are allowed ONLY in an environment that is explicitly configured as production: NODE_ENV is exactly
// "production" AND PAYMENTS_LIVE_MODE is exactly "true". Everything else (development, test, staging, an unset or misspelled NODE_ENV, a
// production NODE_ENV without the live flag, or the live flag without a production NODE_ENV) is a non-production environment and may hold
// Test Mode keys only. Both values must match exactly: nothing is trimmed, lower-cased or guessed.
function liveModeAllowed(env = process.env) {
  return env.NODE_ENV === 'production' && env.PAYMENTS_LIVE_MODE === 'true';
}

// The configured environment identifier, or null when it is missing or invalid. Nothing is trimmed, lower-cased or defaulted.
function paymentsEnvironmentId(env = process.env) {
  const id = env.PAYMENTS_ENVIRONMENT_ID;
  return typeof id === 'string' && ENVIRONMENT_ID_PATTERN.test(id) ? id : null;
}

// A short code naming what is wrong with the environment identifier, or null. Never contains a value.
function environmentIdProblem(env = process.env) {
  const id = env.PAYMENTS_ENVIRONMENT_ID;
  if (id === undefined || id === null || id === '') return 'environment_id_missing';
  return paymentsEnvironmentId(env) === null ? 'environment_id_invalid' : null;
}

// A short code naming what is wrong with the payment configuration (credentials AND environment identifier), or null when it is usable. Every
// order creation, recovery, timeout sweep and gateway call stops on a non-null result: the configuration fails CLOSED. Never contains a value.
function credentialProblem(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID;
  const secret = env.RAZORPAY_KEY_SECRET;
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) return 'key_id_invalid';
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || secret !== secret.trim()) return 'key_secret_invalid';
  const environmentProblem = environmentIdProblem(env);
  if (environmentProblem) return environmentProblem;
  // A live key outside an explicitly configured production environment is refused before any request is built.
  if (keyId.startsWith('rzp_live_') && !liveModeAllowed(env)) return 'key_mode_mismatch';
  return null;
}

// The public Key ID, or null when the credentials are not usable.
function publicKeyId(env = process.env) {
  return credentialProblem(env) === null ? env.RAZORPAY_KEY_ID : null;
}

module.exports = { isPaymentsEnabled, credentialProblem, environmentIdProblem, paymentsEnvironmentId, liveModeAllowed, publicKeyId, KEY_ID_PATTERN, ENVIRONMENT_ID_PATTERN };
