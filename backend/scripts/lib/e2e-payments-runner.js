// The environment and the readiness rules of the isolated Razorpay TEST MODE runner (scripts/e2e-payments-runner.js). Pure and testable: no process is
// started here and nothing is printed.
//
// The environment is the one every other isolated test process uses (e2e-env.js: backend/.env.test ONLY, every other key the code reads blanked so the
// development .env can never leak in, NODE_ENV "test", database / mail / uploads validated by the existing guards) with three additions:
//   - BOTH Bitrix switches are forced OFF in memory (the file may have them on; it is never changed) and the Bitrix webhook URL is blanked
//   - nothing else is overridden; `overrides` exists for tests only and the script never passes any
// READINESS: the runner refuses to start unless the payment configuration is complete and is a TEST MODE one:
//   PAYMENTS_ENABLED exactly "true", a valid PAYMENTS_ENVIRONMENT_ID, a valid RAZORPAY_WEBHOOK_SECRET that differs from RAZORPAY_KEY_SECRET (the worker's
//   own gates), usable API credentials (orders are created through this server) and a Key ID that starts with "rzp_test_". Problems are fixed short codes.
const { buildIsolatedEnv } = require('../e2e-env');
const { isPaymentsEnabled, credentialProblem } = require('../../src/modules/payments/razorpay-config');
const { webhookConfigProblem } = require('../../src/modules/payments/razorpay-webhook.config');

const BITRIX_OFF = Object.freeze({ BITRIX_SYNC_ENABLED: 'false', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false', BITRIX24_WEBHOOK_URL: '' });
const DEVELOPMENT_PORT = 4000; // the development backend's port: never used here

function buildPaymentsRunnerEnv({ overrides = {}, base = buildIsolatedEnv } = {}) {
  const env = base();
  Object.assign(env, overrides, BITRIX_OFF); // Bitrix is forced off AFTER any override
  return env;
}

// Fixed codes naming what stops the runner; an empty list means ready. Never contains a value.
function runnerProblems(env) {
  const problems = [];
  // Each gate is reported on its own, so one run names EVERYTHING that is missing (the same three gates the worker applies).
  if (!isPaymentsEnabled(env)) problems.push('payments_disabled');
  const webhook = webhookConfigProblem(env); // the webhook secret, then the environment id
  if (webhook) problems.push(webhook);
  const credentials = credentialProblem(env);
  if (credentials) problems.push(credentials);
  if (!credentials && !/^rzp_test_/.test(env.RAZORPAY_KEY_ID || '')) problems.push('key_not_test_mode');
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === DEVELOPMENT_PORT) problems.push('port_invalid');
  return [...new Set(problems)];
}

module.exports = { buildPaymentsRunnerEnv, runnerProblems, BITRIX_OFF, DEVELOPMENT_PORT };
