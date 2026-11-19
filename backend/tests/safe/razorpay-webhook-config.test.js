/* global describe, test, expect */
// Razorpay webhook configuration (razorpay-webhook.config.js): the webhook secret and the environment identifier. Read at call time, never
// trimmed or repaired, fail closed, and reported as short codes only. Local logic only: no network, no database.
const fs = require('fs');
const path = require('path');
const cfg = require('../../src/modules/payments/razorpay-webhook.config');

const SECRET = 'whsec_FAKE_WEBHOOK_SECRET_0123'; // 31 characters, fake
const KEY_SECRET = 'FAKE_API_KEY_SECRET_999999';
const good = (over = {}) => ({ RAZORPAY_WEBHOOK_SECRET: SECRET, PAYMENTS_ENVIRONMENT_ID: 'test', ...over });
const ALLOWED_CODES = new Set([
  'webhook_secret_missing', 'webhook_secret_invalid', 'webhook_secret_short', 'webhook_secret_reused', 'environment_id_missing', 'environment_id_invalid',
]);

describe('the webhook secret', () => {
  test('a secret of at least 16 characters is accepted, exactly as given', () => {
    expect(cfg.webhookSecretProblem(good())).toBeNull();
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: 'a'.repeat(16) }))).toBeNull(); // the minimum
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: 'a'.repeat(200) }))).toBeNull();
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: 'p@ss w0rd/with+symbols=and spaces inside' }))).toBeNull(); // inner spaces are fine
  });

  test('a missing, null or empty secret is "missing"', () => {
    for (const value of [undefined, null, '']) expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: value }))).toBe('webhook_secret_missing');
    expect(cfg.webhookSecretProblem({ PAYMENTS_ENVIRONMENT_ID: 'test' })).toBe('webhook_secret_missing');
    expect(cfg.webhookSecretProblem({})).toBe('webhook_secret_missing');
  });

  test('a short secret is refused at every length below 16', () => {
    for (let length = 1; length < 16; length += 1) expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: 'x'.repeat(length) }))).toBe('webhook_secret_short');
  });

  test('a value that is not text is invalid', () => {
    for (const value of [1234567890123456, true, ['x'.repeat(20)], { secret: 'x'.repeat(20) }]) {
      expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: value }))).toBe('webhook_secret_invalid');
    }
  });

  test('surrounding whitespace is refused, never trimmed: a pasting mistake is reported, not silently repaired', () => {
    for (const value of [` ${SECRET}`, `${SECRET} `, `${SECRET}\n`, `\t${SECRET}`, `${SECRET}\r\n`]) {
      expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: value }))).toBe('webhook_secret_invalid');
      expect(cfg.getWebhookSecret(good({ RAZORPAY_WEBHOOK_SECRET: value }))).toBeNull(); // and the padded value is never handed out
    }
  });

  test('a secret that is only whitespace is invalid, even when long', () => {
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: ' '.repeat(20) }))).toBe('webhook_secret_invalid');
  });

  test('the webhook secret is kept separate from RAZORPAY_KEY_SECRET: the same value is refused', () => {
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_WEBHOOK_SECRET: KEY_SECRET, RAZORPAY_KEY_SECRET: KEY_SECRET }))).toBe('webhook_secret_reused');
    expect(cfg.webhookConfigProblem(good({ RAZORPAY_WEBHOOK_SECRET: KEY_SECRET, RAZORPAY_KEY_SECRET: KEY_SECRET }))).toBe('webhook_secret_reused');
    expect(cfg.webhookSecretProblem(good({ RAZORPAY_KEY_SECRET: KEY_SECRET }))).toBeNull(); // different values are fine
  });

  test('the API key secret is never used in place of a missing webhook secret', () => {
    const env = { PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456' };
    expect(cfg.webhookSecretProblem(env)).toBe('webhook_secret_missing');
    expect(cfg.getWebhookSecret(env)).toBeNull();
  });
});

describe('the environment identifier', () => {
  test('a valid PAYMENTS_ENVIRONMENT_ID is required: development, test, staging and production are accepted', () => {
    for (const id of ['development', 'test', 'staging', 'production', 'staging-2', 'qa_eu']) {
      expect(cfg.webhookConfigProblem(good({ PAYMENTS_ENVIRONMENT_ID: id }))).toBeNull();
    }
  });

  test('a missing or empty identifier is refused as missing', () => {
    for (const id of [undefined, null, '']) expect(cfg.webhookConfigProblem(good({ PAYMENTS_ENVIRONMENT_ID: id }))).toBe('environment_id_missing');
    expect(cfg.webhookConfigProblem({ RAZORPAY_WEBHOOK_SECRET: SECRET })).toBe('environment_id_missing');
  });

  test('an invalid identifier is refused, never repaired (case, padding, characters, length, type)', () => {
    for (const id of ['Test', 'TEST', ' test', 'test ', 'te st', 'test;', 'prod/uction', '1test', 'a', 'a'.repeat(33), 'test\n', 5, ['test'], { id: 'test' }]) {
      expect(cfg.webhookConfigProblem(good({ PAYMENTS_ENVIRONMENT_ID: id }))).toBe('environment_id_invalid');
    }
  });

  test('it is NEVER inferred from NODE_ENV', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'staging', 'production']) {
      expect(cfg.webhookConfigProblem({ RAZORPAY_WEBHOOK_SECRET: SECRET, NODE_ENV: nodeEnv })).toBe('environment_id_missing');
    }
  });
});

describe('the combined configuration fails closed', () => {
  test('a usable configuration has no problem and hands the secret to the verifier', () => {
    expect(cfg.webhookConfigProblem(good())).toBeNull();
    expect(cfg.getWebhookSecret(good())).toBe(SECRET);
  });

  test('every problem yields NO secret', () => {
    for (const env of [
      good({ RAZORPAY_WEBHOOK_SECRET: undefined }), good({ RAZORPAY_WEBHOOK_SECRET: 'short' }), good({ RAZORPAY_WEBHOOK_SECRET: ` ${SECRET}` }),
      good({ PAYMENTS_ENVIRONMENT_ID: undefined }), good({ PAYMENTS_ENVIRONMENT_ID: 'Bad Value' }), good({ RAZORPAY_KEY_SECRET: SECRET }),
    ]) {
      expect(cfg.webhookConfigProblem(env)).not.toBeNull();
      expect(cfg.getWebhookSecret(env)).toBeNull();
    }
  });

  test('the secret problem is reported before the environment problem', () => {
    expect(cfg.webhookConfigProblem({})).toBe('webhook_secret_missing');
    expect(cfg.webhookConfigProblem({ RAZORPAY_WEBHOOK_SECRET: 'short', PAYMENTS_ENVIRONMENT_ID: 'Bad' })).toBe('webhook_secret_short');
  });

  test('the environment is read at CALL time: a change is picked up at once, nothing is cached', () => {
    const env = good();
    expect(cfg.webhookConfigProblem(env)).toBeNull();
    env.RAZORPAY_WEBHOOK_SECRET = 'short';
    expect(cfg.webhookConfigProblem(env)).toBe('webhook_secret_short');
    env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    env.PAYMENTS_ENVIRONMENT_ID = undefined;
    expect(cfg.webhookConfigProblem(env)).toBe('environment_id_missing');
    env.PAYMENTS_ENVIRONMENT_ID = 'staging';
    expect(cfg.webhookConfigProblem(env)).toBeNull();
  });

  test('the default environment is process.env, read when called', () => {
    const saved = { s: process.env.RAZORPAY_WEBHOOK_SECRET, e: process.env.PAYMENTS_ENVIRONMENT_ID };
    try {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      expect(cfg.webhookConfigProblem()).toBe('webhook_secret_missing');
      process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
      process.env.PAYMENTS_ENVIRONMENT_ID = 'test';
      expect(cfg.webhookConfigProblem()).toBeNull();
    } finally {
      for (const [key, value] of [['RAZORPAY_WEBHOOK_SECRET', saved.s], ['PAYMENTS_ENVIRONMENT_ID', saved.e]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

describe('only safe codes are ever reported, and the secret is never exposed', () => {
  test('every problem is one of a fixed set of short codes that contain no value', () => {
    const envs = [
      good({ RAZORPAY_WEBHOOK_SECRET: undefined }), good({ RAZORPAY_WEBHOOK_SECRET: 'x'.repeat(10) }), good({ RAZORPAY_WEBHOOK_SECRET: `  ${SECRET}  ` }),
      good({ RAZORPAY_WEBHOOK_SECRET: 12345 }), good({ RAZORPAY_KEY_SECRET: SECRET }), good({ PAYMENTS_ENVIRONMENT_ID: undefined }), good({ PAYMENTS_ENVIRONMENT_ID: 'SECRET-ENV VALUE' }),
    ];
    for (const env of envs) {
      const code = cfg.webhookConfigProblem(env);
      expect(ALLOWED_CODES.has(code)).toBe(true);
      expect(code).toMatch(/^[a-z_]{1,40}$/);
      expect(code).not.toContain(SECRET);
      expect(code).not.toMatch(/SECRET-ENV|x{10}/);
    }
  });

  test('the module has no logging, no JSON handling and no top-level environment reads', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'payments', 'razorpay-webhook.config.js'), 'utf8');
    const code = source.replace(/\/\/.*$/gm, ''); // comments aside
    expect(code).not.toMatch(/console\.|logger|JSON\.(parse|stringify)/);
    expect(code).not.toMatch(/^\s*(const|let|var)\s+\w+\s*=\s*process\.env/m); // nothing cached at import
    expect(code).not.toMatch(/RAZORPAY_KEY_SECRET\s*\)\s*return|\|\|\s*env\.RAZORPAY_KEY_SECRET/); // the API key secret is never a fallback
  });
});
