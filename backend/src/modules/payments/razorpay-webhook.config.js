// Configuration of the Razorpay WEBHOOK receiver: the webhook secret and the environment identifier. Everything is read from the environment at
// call time (never at import) and nothing is cached, trimmed, lower-cased or repaired: a wrong value is reported, not fixed. The configuration
// fails CLOSED: any problem means no webhook is accepted.
//
// RAZORPAY_WEBHOOK_SECRET is the signing secret set on the Razorpay Dashboard webhook. It is SEPARATE from RAZORPAY_KEY_SECRET (the API key's
// secret): the two must never be the same value, and neither is ever used in place of the other. The secret is never returned to a caller
// other than the signature verifier (getWebhookSecret), never logged and never put in an error. Problems are reported as short codes only.
const { environmentIdProblem } = require('./razorpay-config');

const MIN_WEBHOOK_SECRET_LENGTH = 16;

// Short code naming what is wrong with the webhook secret, or null. Never contains a value.
//   webhook_secret_missing   not set, null or empty
//   webhook_secret_invalid   not text, or has leading or trailing whitespace (a pasting mistake that must not be silently repaired)
//   webhook_secret_short     shorter than 16 characters
//   webhook_secret_reused    identical to RAZORPAY_KEY_SECRET: the two secrets must be different values
function webhookSecretProblem(env = process.env) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (secret === undefined || secret === null || secret === '') return 'webhook_secret_missing';
  if (typeof secret !== 'string' || secret !== secret.trim()) return 'webhook_secret_invalid';
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) return 'webhook_secret_short';
  if (typeof env.RAZORPAY_KEY_SECRET === 'string' && env.RAZORPAY_KEY_SECRET === secret) return 'webhook_secret_reused';
  return null;
}

// Short code naming what is wrong with the webhook configuration (the secret, then the environment identifier), or null when a webhook may be
// accepted. Never contains a value.
function webhookConfigProblem(env = process.env) {
  return webhookSecretProblem(env) || environmentIdProblem(env);
}

// The webhook secret, or null when the configuration is unusable. For the signature verifier ONLY: it must never be logged, returned in a
// response or put in an error.
function getWebhookSecret(env = process.env) {
  return webhookConfigProblem(env) === null ? env.RAZORPAY_WEBHOOK_SECRET : null;
}

module.exports = { webhookSecretProblem, webhookConfigProblem, getWebhookSecret, MIN_WEBHOOK_SECRET_LENGTH };
