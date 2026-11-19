/* global describe, test, expect, jest, afterEach */
// Razorpay webhook signature verification (razorpay-webhook.signature.js): HMAC-SHA256 over the EXACT raw bytes, strict hex, constant-time
// comparison, fail closed, and nothing (secret, body, signature) ever logged or returned. Every signature is computed locally with Node's crypto;
// no network, no database, no Razorpay.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyWebhookSignature, SIGNATURE_LENGTH } = require('../../src/modules/payments/razorpay-webhook.signature');

const SECRET = 'whsec_FAKE_WEBHOOK_SECRET_0123';
const OTHER_SECRET = 'whsec_ANOTHER_FAKE_SECRET_4567';
const KEY_SECRET = 'FAKE_API_KEY_SECRET_999999';
const env = (over = {}) => ({ RAZORPAY_WEBHOOK_SECRET: SECRET, PAYMENTS_ENVIRONMENT_ID: 'test', ...over });
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const PAYLOAD = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_FAKE1","order_id":"order_FAKE1","amount":150000,"currency":"INR"}}}}';
const RAW = Buffer.from(PAYLOAD, 'utf8');
const ok = (body, signature, e = env()) => verifyWebhookSignature(body, signature, { env: e });
const code = (body, signature, e = env()) => { const r = ok(body, signature, e); return r.ok ? 'OK' : `${r.kind}:${r.code}`; };

afterEach(() => { jest.restoreAllMocks(); });

describe('a correct signature', () => {
  test('is accepted', () => {
    expect(ok(RAW, sign(RAW))).toEqual({ ok: true });
  });
  test('is accepted in lower or upper case hexadecimal (it is the same bytes)', () => {
    expect(ok(RAW, sign(RAW).toUpperCase())).toEqual({ ok: true });
    expect(ok(RAW, sign(RAW).toLowerCase())).toEqual({ ok: true });
  });
  test('works for any body: binary bytes, multi-byte characters, large payloads, a single byte', () => {
    for (const body of [Buffer.from([0, 1, 2, 255, 254]), Buffer.from('{"name":"Zoë 日本語 🚑"}', 'utf8'), Buffer.alloc(200000, 'a'), Buffer.from('x')]) {
      expect(ok(body, sign(body))).toEqual({ ok: true });
    }
  });
  test('matches the value computed independently with the secret read at call time', () => {
    const e = env();
    expect(ok(RAW, sign(RAW), e).ok).toBe(true);
    e.RAZORPAY_WEBHOOK_SECRET = OTHER_SECRET; // the secret is read when called, never cached
    expect(ok(RAW, sign(RAW), e).ok).toBe(false);
    expect(ok(RAW, sign(RAW, OTHER_SECRET), e).ok).toBe(true);
  });
  test('uses process.env by default', () => {
    const saved = { s: process.env.RAZORPAY_WEBHOOK_SECRET, e: process.env.PAYMENTS_ENVIRONMENT_ID };
    try {
      process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
      process.env.PAYMENTS_ENVIRONMENT_ID = 'test';
      expect(verifyWebhookSignature(RAW, sign(RAW))).toEqual({ ok: true });
    } finally {
      for (const [key, value] of [['RAZORPAY_WEBHOOK_SECRET', saved.s], ['PAYMENTS_ENVIRONMENT_ID', saved.e]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

describe('an incorrect signature is refused', () => {
  test('a signature made with another secret', () => {
    expect(code(RAW, sign(RAW, OTHER_SECRET))).toBe('signature:signature_mismatch');
  });
  test('a signature made with the API key secret (the two secrets are never interchangeable)', () => {
    expect(code(RAW, sign(RAW, KEY_SECRET), env({ RAZORPAY_KEY_SECRET: KEY_SECRET }))).toBe('signature:signature_mismatch');
  });
  test('a well-formed but arbitrary signature', () => {
    expect(code(RAW, 'a'.repeat(64))).toBe('signature:signature_mismatch');
    expect(code(RAW, '0'.repeat(64))).toBe('signature:signature_mismatch');
    expect(code(RAW, crypto.randomBytes(32).toString('hex'))).toBe('signature:signature_mismatch');
  });
  test('a signature of another body', () => {
    expect(code(RAW, sign(Buffer.from('{"event":"payment.failed"}')))).toBe('signature:signature_mismatch');
  });
  test('a single changed character in the signature, in any position', () => {
    const good = sign(RAW);
    for (const index of [0, 1, 31, 32, 62, 63]) {
      const flipped = good.slice(0, index) + (good[index] === '0' ? '1' : '0') + good.slice(index + 1);
      expect(code(RAW, flipped)).toBe('signature:signature_mismatch');
    }
  });
  test('a hash of the payload without the secret (a plain SHA-256) is not a signature', () => {
    expect(code(RAW, crypto.createHash('sha256').update(RAW).digest('hex'))).toBe('signature:signature_mismatch');
  });
});

describe('a missing signature is refused', () => {
  test.each([[undefined], [null], ['']])('%p', (value) => {
    expect(code(RAW, value)).toBe('signature:signature_missing');
  });
  test('a repeated header (an array), a number, an object or a Buffer is not a signature', () => {
    for (const value of [[sign(RAW), sign(RAW)], [sign(RAW)], 12345, {}, Buffer.from(sign(RAW)), true]) expect(code(RAW, value)).toBe('signature:signature_malformed');
  });
});

describe('invalid hexadecimal characters are refused', () => {
  test.each([
    ['g in every position of a 64-character value', 'g'.repeat(64)],
    ['one non-hex character', `${sign(RAW).slice(0, 63)}z`],
    ['a leading 0x prefix', `0x${sign(RAW).slice(0, 62)}`],
    ['a space inside', `${sign(RAW).slice(0, 30)} ${sign(RAW).slice(31)}`],
    ['a newline inside', `${sign(RAW).slice(0, 30)}\n${sign(RAW).slice(31)}`],
    ['a dash', `${sign(RAW).slice(0, 63)}-`],
    ['base64 of the digest instead of hex', crypto.createHmac('sha256', SECRET).update(RAW).digest('base64').padEnd(64, '=')],
    ['a unicode look-alike digit', `${sign(RAW).slice(0, 63)}０`],
    ['punctuation', '!'.repeat(64)],
  ])('%s', (_label, signature) => {
    expect(signature).toHaveLength(64);
    expect(code(RAW, signature)).toBe('signature:signature_not_hex');
  });
});

describe('an incorrect signature length is refused', () => {
  test.each([[0 + 1], [31], [32], [63], [65], [96], [128]])('%i characters', (length) => {
    const value = (sign(RAW) + sign(RAW) + sign(RAW)).slice(0, length);
    expect(code(RAW, value)).toBe('signature:signature_wrong_length');
  });
  test('a truncated valid signature (any prefix of the right one) is refused', () => {
    const good = sign(RAW);
    for (let length = 1; length < SIGNATURE_LENGTH; length += 1) expect(code(RAW, good.slice(0, length))).toBe('signature:signature_wrong_length');
  });
  test('a valid signature with anything appended or prepended is refused', () => {
    const good = sign(RAW);
    for (const value of [`${good}0`, `${good} `, ` ${good}`, `${good}\n`, `0${good}`, `${good}${good}`]) expect(code(RAW, value)).toBe('signature:signature_wrong_length');
  });
  test('the expected length is the 64 hexadecimal characters of a SHA-256 digest', () => {
    expect(SIGNATURE_LENGTH).toBe(64);
    expect(sign(RAW)).toHaveLength(SIGNATURE_LENGTH);
  });
});

describe('a modified raw body is refused', () => {
  const signature = sign(RAW);
  test.each([
    ['one byte changed', () => { const b = Buffer.from(RAW); b[10] ^= 1; return b; }],
    ['the last byte changed', () => { const b = Buffer.from(RAW); b[b.length - 1] ^= 1; return b; }],
    ['a trailing newline added', () => Buffer.concat([RAW, Buffer.from('\n')])],
    ['a trailing space added', () => Buffer.concat([RAW, Buffer.from(' ')])],
    ['a leading space added', () => Buffer.concat([Buffer.from(' '), RAW])],
    ['a UTF-8 byte-order mark prepended', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), RAW])],
    ['a byte removed', () => RAW.subarray(0, RAW.length - 1)],
    ['a byte removed from the start', () => RAW.subarray(1)],
    ['an amount edited', () => Buffer.from(PAYLOAD.replace('150000', '150001'))],
    ['an order id edited', () => Buffer.from(PAYLOAD.replace('order_FAKE1', 'order_FAKE2'))],
    ['the event name edited', () => Buffer.from(PAYLOAD.replace('payment.captured', 'payment.failed'))],
    ['carriage returns inserted', () => Buffer.from(PAYLOAD.replace(',', ',\r\n'))],
    ['two bodies concatenated', () => Buffer.concat([RAW, RAW])],
  ])('%s', (_label, make) => {
    const modified = make();
    expect(Buffer.compare(modified, RAW)).not.toBe(0);
    expect(code(modified, signature)).toBe('signature:signature_mismatch');
  });
  test('the untouched body still verifies with the same signature (the test above really changed the bytes)', () => {
    expect(ok(Buffer.from(PAYLOAD), signature)).toEqual({ ok: true });
  });
});

describe('re-serialized JSON produces a different signature', () => {
  // Razorpay signs the bytes it sent. Parsing and re-serializing changes whitespace, key order or number formatting, so the signature of the
  // re-serialized text is not the signature that was sent.
  const SENT = '{ "event": "payment.captured",\n  "payload": { "payment": { "entity": { "amount": 150000.0, "id": "pay_FAKE1", "currency": "INR" } } } }\n';
  const sentRaw = Buffer.from(SENT);
  const sentSignature = sign(sentRaw);

  test('JSON.stringify(JSON.parse(raw)) is NOT the bytes that were signed', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(SENT)));
    expect(Buffer.compare(reserialized, sentRaw)).not.toBe(0);
    expect(sign(reserialized)).not.toBe(sentSignature);
    expect(code(reserialized, sentSignature)).toBe('signature:signature_mismatch'); // the sent signature does not verify the re-serialized body
  });
  test('the raw bytes that were sent DO verify', () => {
    expect(ok(sentRaw, sentSignature)).toEqual({ ok: true });
  });
  test('reordered keys, pretty-printing and number formatting are all different bytes with different signatures', () => {
    const variants = [
      JSON.stringify(JSON.parse(SENT), null, 2),
      JSON.stringify(JSON.parse(SENT), Object.keys(JSON.parse(SENT)).sort()),
      SENT.replace('150000.0', '150000'),
      SENT.replace(/\s+/g, ''),
      `${JSON.stringify(JSON.parse(SENT))}\n`,
    ];
    for (const text of variants) {
      expect(text).not.toBe(SENT);
      expect(code(Buffer.from(text), sentSignature)).toBe('signature:signature_mismatch');
      expect(sign(Buffer.from(text))).not.toBe(sentSignature);
    }
  });
  test('a string or an already-parsed object is refused outright: only raw bytes are accepted', () => {
    for (const body of [SENT, JSON.parse(SENT), JSON.stringify(JSON.parse(SENT)), new Uint8Array(sentRaw), [...sentRaw], null, undefined, 42]) {
      expect(code(body, sentSignature)).toBe('body:body_not_buffer');
    }
  });
  test('an empty body is refused even with the signature of an empty body', () => {
    expect(code(Buffer.alloc(0), sign(Buffer.alloc(0)))).toBe('body:body_empty');
  });
});

describe('a missing or short webhook secret fails closed', () => {
  test.each([
    ['missing', undefined, 'webhook_secret_missing'],
    ['empty', '', 'webhook_secret_missing'],
    ['null', null, 'webhook_secret_missing'],
    ['one character', 'x', 'webhook_secret_short'],
    ['15 characters', 'x'.repeat(15), 'webhook_secret_short'],
    ['padded with whitespace', ` ${SECRET}`, 'webhook_secret_invalid'],
    ['not text', 12345678901234567, 'webhook_secret_invalid'],
  ])('%s: refused as a configuration problem, and nothing is computed', (_label, value, expected) => {
    const signature = sign(RAW); // computed BEFORE the spy, so the spy sees only what the verifier does
    const spy = jest.spyOn(crypto, 'createHmac');
    expect(code(RAW, signature, env({ RAZORPAY_WEBHOOK_SECRET: value }))).toBe(`configuration:${expected}`);
    expect(spy).not.toHaveBeenCalled();
  });

  test('even a signature made with the "short" secret itself is refused (it is the configuration that is wrong)', () => {
    expect(code(RAW, sign(RAW, 'short'), env({ RAZORPAY_WEBHOOK_SECRET: 'short' }))).toBe('configuration:webhook_secret_short');
    expect(code(RAW, sign(RAW, ''), env({ RAZORPAY_WEBHOOK_SECRET: '' }))).toBe('configuration:webhook_secret_missing');
  });

  test('exactly 16 characters is the minimum that works', () => {
    const secret = 'a'.repeat(16);
    expect(ok(RAW, sign(RAW, secret), env({ RAZORPAY_WEBHOOK_SECRET: secret }))).toEqual({ ok: true });
  });

  test('the API key secret is never a fallback: with no webhook secret nothing verifies, whatever it was signed with', () => {
    const e = { PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_SECRET: KEY_SECRET };
    expect(code(RAW, sign(RAW, KEY_SECRET), e)).toBe('configuration:webhook_secret_missing');
  });

  test('the webhook secret may not equal the API key secret', () => {
    expect(code(RAW, sign(RAW, KEY_SECRET), env({ RAZORPAY_WEBHOOK_SECRET: KEY_SECRET, RAZORPAY_KEY_SECRET: KEY_SECRET }))).toBe('configuration:webhook_secret_reused');
  });

  test('the configuration is checked BEFORE the body and the signature', () => {
    expect(code('not a buffer', undefined, env({ RAZORPAY_WEBHOOK_SECRET: undefined }))).toBe('configuration:webhook_secret_missing');
  });
});

describe('a missing or invalid environment identifier fails closed', () => {
  test.each([
    ['missing', undefined, 'environment_id_missing'],
    ['empty', '', 'environment_id_missing'],
    ['upper case', 'Production', 'environment_id_invalid'],
    ['padded', 'test ', 'environment_id_invalid'],
    ['bad characters', 'te/st', 'environment_id_invalid'],
    ['too short', 'a', 'environment_id_invalid'],
    ['too long', 'a'.repeat(33), 'environment_id_invalid'],
    ['not text', 5, 'environment_id_invalid'],
  ])('%s: a correct signature is still refused, and nothing is computed', (_label, value, expected) => {
    const signature = sign(RAW); // computed BEFORE the spy, so the spy sees only what the verifier does
    const spy = jest.spyOn(crypto, 'createHmac');
    expect(code(RAW, signature, env({ PAYMENTS_ENVIRONMENT_ID: value }))).toBe(`configuration:${expected}`);
    expect(spy).not.toHaveBeenCalled();
  });

  test('it is not inferred from NODE_ENV', () => {
    expect(code(RAW, sign(RAW), { RAZORPAY_WEBHOOK_SECRET: SECRET, NODE_ENV: 'production' })).toBe('configuration:environment_id_missing');
    expect(code(RAW, sign(RAW), { RAZORPAY_WEBHOOK_SECRET: SECRET, NODE_ENV: 'test' })).toBe('configuration:environment_id_missing');
  });

  test('every valid environment name works', () => {
    for (const id of ['development', 'test', 'staging', 'production']) expect(ok(RAW, sign(RAW), env({ PAYMENTS_ENVIRONMENT_ID: id })).ok).toBe(true);
  });
});

describe('the comparison is timing-safe', () => {
  test('crypto.timingSafeEqual is used, once, on two equal-length digest buffers', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    expect(ok(RAW, sign(RAW)).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0];
    expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  test('it is also what rejects a wrong signature (the verdict comes from timingSafeEqual, not from a string comparison)', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    expect(code(RAW, sign(RAW, OTHER_SECRET))).toBe('signature:signature_mismatch');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0].value).toBe(false);
  });

  test('a verdict of "equal" from timingSafeEqual is what accepts: forcing it to false rejects a correct signature', () => {
    jest.spyOn(crypto, 'timingSafeEqual').mockReturnValue(false);
    expect(code(RAW, sign(RAW))).toBe('signature:signature_mismatch');
  });

  test('malformed input is rejected BEFORE any comparison (timingSafeEqual would throw on a length mismatch)', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    for (const value of [undefined, '', 'abc', 'g'.repeat(64), `${sign(RAW)}00`, [sign(RAW)]]) ok(RAW, value);
    expect(spy).not.toHaveBeenCalled();
  });

  test('the source compares with timingSafeEqual only: no ==, === or Buffer.compare/equals on the signature, and no JSON handling or logging', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'payments', 'razorpay-webhook.signature.js'), 'utf8');
    const code2 = source.replace(/\/\/.*$/gm, '');
    expect(code2).toContain('crypto.timingSafeEqual(');
    expect(code2).not.toMatch(/signatureHeader\s*[!=]==?\s*(expected|digest)|(expected|digest)\s*[!=]==?\s*signatureHeader/);
    expect(code2).not.toMatch(/\.equals\(|Buffer\.compare\(|localeCompare/);
    expect(code2).not.toMatch(/JSON\.(parse|stringify)/); // it never parses or re-serializes the body
    expect(code2).not.toMatch(/console\.|logger\./);
  });
});

describe('the secret, body and signature never leak', () => {
  const SENTINEL_BODY = '{"leak":"SENTINEL_BODY_TEXT_Asha_Rao_+971501234567"}';
  const spies = () => ['log', 'info', 'warn', 'error', 'debug'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
  const everyoneStaysQuiet = (list) => { for (const spy of list) expect(spy).not.toHaveBeenCalled(); };

  test('no result of any kind contains the secret, the body or the signature', () => {
    const body = Buffer.from(SENTINEL_BODY);
    const signature = sign(body);
    const attempts = [
      ok(body, signature), ok(body, sign(body, OTHER_SECRET)), ok(body, undefined), ok(body, 'g'.repeat(64)), ok(body, signature.slice(1)),
      ok(Buffer.concat([body, Buffer.from('x')]), signature), ok(body, signature, env({ RAZORPAY_WEBHOOK_SECRET: 'short' })), ok(body, signature, env({ PAYMENTS_ENVIRONMENT_ID: undefined })),
      ok('not a buffer', signature), ok(Buffer.alloc(0), signature),
    ];
    const text = JSON.stringify(attempts);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OTHER_SECRET);
    expect(text).not.toContain(signature);
    expect(text).not.toMatch(/SENTINEL_BODY_TEXT|Asha|971501234567/);
    for (const r of attempts) {
      expect(Object.keys(r).sort()).toEqual(r.ok ? ['ok'] : ['code', 'kind', 'ok']);
      if (!r.ok) expect(r.code).toMatch(/^[a-z_]{1,40}$/);
    }
  });

  test('nothing is written to the console, for success or for any failure', () => {
    const list = spies();
    const body = Buffer.from(SENTINEL_BODY);
    for (const [b, s, e] of [[body, sign(body), env()], [body, 'bad', env()], [body, undefined, env()], [body, sign(body), env({ RAZORPAY_WEBHOOK_SECRET: undefined })], ['text', 'x', env()]]) ok(b, s, e);
    everyoneStaysQuiet(list);
  });

  test('an unexpected internal failure is reported as a fixed code: the error message (which could quote the secret) is dropped', () => {
    const list = spies();
    const signature = sign(RAW); // before the mock: only the verifier's own HMAC call must fail
    jest.spyOn(crypto, 'createHmac').mockImplementation(() => { throw new Error(`boom ${SECRET} ${SENTINEL_BODY}`); });
    const result = ok(RAW, signature);
    expect(result).toEqual({ ok: false, kind: 'error', code: 'verification_error' });
    expect(JSON.stringify(result)).not.toMatch(/boom|whsec_|SENTINEL/);
    everyoneStaysQuiet(list);
  });

  test('a body whose methods throw (a hostile object) is rejected without throwing and without a leak', () => {
    const hostile = new Proxy({}, { get() { throw new Error(`hostile ${SECRET}`); } });
    expect(() => ok(hostile, sign(RAW))).not.toThrow();
    expect(JSON.stringify(ok(hostile, sign(RAW)))).not.toContain(SECRET);
  });

  test('the verifier never throws, for any input', () => {
    const odd = [undefined, null, 0, NaN, '', {}, [], () => {}, Symbol('x'), 10n];
    for (const body of odd) for (const sig of odd) expect(() => verifyWebhookSignature(body, sig, { env: env() })).not.toThrow();
  });

  test('the secret read at call time is not retained: a failure after the secret changed names no earlier value', () => {
    const e = env();
    ok(RAW, sign(RAW), e);
    e.RAZORPAY_WEBHOOK_SECRET = undefined;
    const result = ok(RAW, sign(RAW), e);
    expect(result).toEqual({ ok: false, kind: 'configuration', code: 'webhook_secret_missing' });
  });
});

describe('the verifier does not parse JSON', () => {
  test('a body that is not JSON at all verifies exactly like any other bytes', () => {
    const notJson = Buffer.from('this is not json {{{ \u0000 ');
    expect(ok(notJson, sign(notJson))).toEqual({ ok: true });
  });
  test('JSON.parse is never called, for success or failure', () => {
    const spy = jest.spyOn(JSON, 'parse');
    ok(RAW, sign(RAW));
    ok(RAW, 'bad');
    ok(RAW, sign(RAW, OTHER_SECRET));
    expect(spy).not.toHaveBeenCalled();
  });
  test('a signed body is verified without being decoded: invalid UTF-8 bytes are fine', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x80]);
    expect(ok(bytes, sign(bytes))).toEqual({ ok: true });
  });
});
