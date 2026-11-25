/* global describe, test, expect, jest */
// The Expo push client (integrations/push/expo-push.client.js) and the push delivery configuration. fetch is injected; nothing touches the network.
const { createExpoPushClient, PushNetworkSuppressedError, scrub, SEND_URL, RECEIPTS_URL } = require('../../src/integrations/push/expo-push.client');
const { readConfig, suppressionReason, POLICY } = require('../../src/modules/notifications/push-delivery.config');

const ACCESS = 'secret-access-token-0123456789';
const PROD = { NODE_ENV: 'production' };
const MESSAGE = { to: 'ExponentPushToken[abcdefghijklmnopqrstuv]', title: 'T', body: 'B', data: { screen: 'request', serviceRequestId: 7 } };

const reply = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; },
});
const clientWith = (fetchImpl, over = {}) => createExpoPushClient({ accessToken: ACCESS, env: PROD, fetchImpl, ...over });

describe('configuration', () => {
  test('delivery is OFF by default and only the exact value "true" turns it on', () => {
    expect(readConfig({})).toEqual({ enabled: false, problem: 'switch_off' });
    for (const v of ['false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', '']) {
      expect(readConfig({ PUSH_DELIVERY_ENABLED: v, EXPO_PUSH_ACCESS_TOKEN: ACCESS, ...PROD })).toEqual({ enabled: false, problem: 'switch_off' });
    }
    expect(readConfig({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: ACCESS, ...PROD })).toEqual({ enabled: true, accessToken: ACCESS });
  });

  test('enabled without a usable access token fails closed, with a code and never the value', () => {
    expect(readConfig({ PUSH_DELIVERY_ENABLED: 'true', ...PROD })).toEqual({ enabled: false, problem: 'access_token_missing' });
    expect(readConfig({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: '', ...PROD })).toEqual({ enabled: false, problem: 'access_token_missing' });
    for (const bad of ['short', 'has space inside 0123456789', 'line\nbreak0123456789', 'x'.repeat(600)]) {
      const res = readConfig({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: bad, ...PROD });
      expect(res).toEqual({ enabled: false, problem: 'access_token_invalid' });
    }
  });

  test('test, scoped, integration and synthetic runs are suppressed whatever else is set', () => {
    expect(suppressionReason({})).toBeNull();
    expect(suppressionReason({ NODE_ENV: 'test' })).toBe('test_environment');
    expect(suppressionReason({ HUMANCARE_SCOPED_RUN: 'true' })).toBe('scoped_test_run');
    expect(suppressionReason({ HUMANCARE_INTEGRATION_RUN: 'true' })).toBe('integration_test_run');
    expect(suppressionReason({ SYNTHETIC_E2E_AUTO_APPROVE: 'true' })).toBe('synthetic_run');
    expect(readConfig({ PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: ACCESS, HUMANCARE_SCOPED_RUN: 'true' })).toEqual({ enabled: false, problem: 'suppressed_scoped_test_run' });
  });

  test('the approved policy values', () => {
    expect(POLICY.MAX_ATTEMPTS).toBe(3);
    expect(POLICY.RETRY_DELAYS_SECONDS).toEqual([60, 300]);
    expect(POLICY.EXPIRY_HOURS).toBe(24);
  });
});

describe('request', () => {
  test('goes to the send endpoint with the Bearer access token, as a one-element array', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { data: [{ status: 'ok', id: 'T1' }] }));
    await clientWith(fetchImpl).sendMessage(MESSAGE);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual([{ ...MESSAGE, sound: 'default' }]);
  });

  test('the access token is in no returned value', async () => {
    const results = [
      await clientWith(async () => reply(200, { data: [{ status: 'ok', id: 'T1' }] })).sendMessage(MESSAGE),
      await clientWith(async () => reply(429, {})).sendMessage(MESSAGE),
      await clientWith(async () => { throw Object.assign(new Error(`failed with ${ACCESS}`), { code: 'ECONNRESET' }); }).sendMessage(MESSAGE),
    ];
    expect(JSON.stringify(results)).not.toContain(ACCESS);
  });

  test('a client cannot be built without an access token', () => {
    expect(() => createExpoPushClient({ env: PROD })).toThrow();
    expect(() => createExpoPushClient({ accessToken: '', env: PROD })).toThrow();
  });

  test('in a test / scoped / synthetic run no request is ever made', async () => {
    for (const env of [{ NODE_ENV: 'test' }, { HUMANCARE_SCOPED_RUN: 'true' }, { SYNTHETIC_E2E_AUTO_APPROVE: 'true' }]) {
      const fetchImpl = jest.fn();
      await expect(clientWith(fetchImpl, { env }).sendMessage(MESSAGE)).rejects.toBeInstanceOf(PushNetworkSuppressedError);
      await expect(clientWith(fetchImpl, { env }).getReceipts(['a'])).rejects.toBeInstanceOf(PushNetworkSuppressedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('send outcomes', () => {
  test('an ok ticket is accepted and carries the receipt id', async () => {
    expect(await clientWith(async () => reply(200, { data: [{ status: 'ok', id: 'AAAA-1' }] })).sendMessage(MESSAGE)).toEqual({ outcome: 'accepted', ticketId: 'AAAA-1' });
  });

  test('DeviceNotRegistered on the ticket', async () => {
    const res = await clientWith(async () => reply(200, { data: [{ status: 'error', message: `"${MESSAGE.to}" is not registered`, details: { error: 'DeviceNotRegistered' } }] })).sendMessage(MESSAGE);
    expect(res.outcome).toBe('device_not_registered');
    expect(JSON.stringify(res)).not.toContain('abcdefghijklmnopqrstuv'); // Expo quotes the token in its message: scrubbed
  });

  test('other ticket errors: MessageRateExceeded is a safe retry; the rest are terminal with their own code', async () => {
    const ticket = (error) => clientWith(async () => reply(200, { data: [{ status: 'error', message: 'm', details: { error } }] })).sendMessage(MESSAGE);
    expect((await ticket('MessageRateExceeded')).outcome).toBe('retry');
    expect(await ticket('MessageTooBig')).toMatchObject({ outcome: 'failed', code: 'MessageTooBig' });
    expect(await ticket('MismatchSenderId')).toMatchObject({ outcome: 'failed', code: 'MismatchSenderId' });
    expect(await ticket('InvalidCredentials')).toMatchObject({ outcome: 'failed', code: 'InvalidCredentials' });
    expect(await ticket('weird code!')).toMatchObject({ outcome: 'failed', code: 'ticket_error' }); // not identifier-shaped: never stored as is
  });

  test('HTTP 429 is a retry, and a plain-seconds Retry-After is passed on', async () => {
    expect(await clientWith(async () => reply(429, {}, { 'retry-after': '30' })).sendMessage(MESSAGE)).toEqual({ outcome: 'retry', code: 'rate_limited', retryAfterSeconds: 30 });
    expect(await clientWith(async () => reply(429, {})).sendMessage(MESSAGE)).toEqual({ outcome: 'retry', code: 'rate_limited', retryAfterSeconds: null });
    expect((await clientWith(async () => reply(429, {}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).sendMessage(MESSAGE)).retryAfterSeconds).toBeNull();
    expect((await clientWith(async () => reply(400, { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'x' }] })).sendMessage(MESSAGE)).outcome).toBe('retry');
  });

  test('HTTP 5xx is a retry (Expo failed before accepting anything)', async () => {
    for (const status of [500, 502, 503, 504]) expect(await clientWith(async () => reply(status, {})).sendMessage(MESSAGE)).toMatchObject({ outcome: 'retry', code: 'expo_server_error' });
  });

  test('HTTP 401/403 is its own outcome: the ACCESS TOKEN was rejected (never a per-delivery retry)', async () => {
    for (const status of [401, 403]) expect(await clientWith(async () => reply(status, { errors: [{ code: 'UNAUTHORIZED' }] })).sendMessage(MESSAGE)).toEqual({ outcome: 'unauthorized', status });
    for (const status of [401, 403]) expect(await clientWith(async () => reply(status, {})).getReceipts(['a'])).toEqual({ outcome: 'unauthorized', status });
  });

  test('other 4xx are terminal', async () => {
    expect(await clientWith(async () => reply(400, { errors: [{ code: 'PUSH_TOO_MANY_NOTIFICATIONS', message: 'm' }] })).sendMessage(MESSAGE)).toMatchObject({ outcome: 'failed', code: 'expo_rejected_400' });
    expect(await clientWith(async () => reply(404, undefined)).sendMessage(MESSAGE)).toMatchObject({ outcome: 'failed', code: 'expo_rejected_404' });
  });

  test('a connection that could not even open is a safe retry; one that failed any other way is uncertain', async () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(await clientWith(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); }).sendMessage(MESSAGE)).toEqual({ outcome: 'retry', code: 'network_unreachable' });
    }
    for (const code of ['ECONNRESET', 'EPIPE', undefined]) {
      expect(await clientWith(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); }).sendMessage(MESSAGE)).toEqual({ outcome: 'uncertain', code: 'network_error' });
    }
  });

  test('our own timeout means the request may have arrived: uncertain', async () => {
    const hung = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    expect(await clientWith(hung, { timeoutMs: 20 }).sendMessage(MESSAGE)).toEqual({ outcome: 'uncertain', code: 'timeout' });
  });

  test.each([
    ['not JSON', undefined],
    ['no data', {}],
    ['data is an object, not an array', { data: { status: 'ok', id: 'x' } }],
    ['data is empty', { data: [] }],
    ['two tickets for one message', { data: [{ status: 'ok', id: 'a' }, { status: 'ok', id: 'b' }] }],
    ['ticket is not an object', { data: ['ok'] }],
    ['unknown ticket status', { data: [{ status: 'maybe' }] }],
    ['ok ticket without an id', { data: [{ status: 'ok' }] }],
    ['ok ticket with an oversized id', { data: [{ status: 'ok', id: 'x'.repeat(200) }] }],
  ])('HTTP 200 with a malformed answer (%s) is uncertain, never a success and never retried', async (_name, body) => {
    const res = await clientWith(async () => reply(200, body)).sendMessage(MESSAGE);
    expect(res.outcome).toBe('uncertain');
  });
});

describe('receipts', () => {
  test('posts the ids with the access token and reads a map keyed by receipt id; ids Expo has no receipt for are absent', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { data: {
      a: { status: 'ok' },
      b: { status: 'error', message: 'gone ExponentPushToken[zzzzzzzzzzzzzzzzzzzz]', details: { error: 'DeviceNotRegistered' } },
    } }));
    const res = await clientWith(fetchImpl).getReceipts(['a', 'b', 'c']);
    expect(fetchImpl.mock.calls[0][0]).toBe(RECEIPTS_URL);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ids: ['a', 'b', 'c'] });
    expect(res.outcome).toBe('ok');
    expect(res.receipts.get('a')).toEqual({ status: 'ok' });
    expect(res.receipts.get('b')).toMatchObject({ status: 'error', code: 'DeviceNotRegistered' });
    expect(JSON.stringify([...res.receipts])).not.toContain('zzzzzzzz');
    expect(res.receipts.has('c')).toBe(false);
  });

  test('anything unusable means "unavailable": nothing is concluded', async () => {
    expect(await clientWith(async () => reply(503, {})).getReceipts(['a'])).toEqual({ outcome: 'unavailable', code: 'http_503' });
    expect(await clientWith(async () => reply(200, { data: [] })).getReceipts(['a'])).toEqual({ outcome: 'unavailable', code: 'malformed_response' });
    expect(await clientWith(async () => reply(200, undefined)).getReceipts(['a'])).toEqual({ outcome: 'unavailable', code: 'malformed_response' });
    expect((await clientWith(async () => { throw new Error('down'); }).getReceipts(['a'])).outcome).toBe('unavailable');
  });

  test('at most 1000 ids per request', async () => {
    await expect(clientWith(jest.fn()).getReceipts([])).rejects.toThrow();
    await expect(clientWith(jest.fn()).getReceipts(Array.from({ length: 1001 }, (_, i) => `i${i}`))).rejects.toThrow();
  });
});

describe('credential check (no delivery involved)', () => {
  test('asks for a receipt id that cannot exist, with the access token', async () => {
    const fetchImpl = jest.fn(async () => reply(200, { data: {} }));
    expect(await clientWith(fetchImpl).verifyCredentials()).toEqual({ outcome: 'valid' });
    expect(fetchImpl.mock.calls[0][0]).toBe(RECEIPTS_URL);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ids: ['00000000-0000-0000-0000-000000000000'] });
  });

  test('401/403 = rejected; a normal answer = valid; anything inconclusive = unknown (never a verdict)', async () => {
    for (const status of [401, 403]) expect(await clientWith(async () => reply(status, {})).verifyCredentials()).toEqual({ outcome: 'rejected', status });
    for (const status of [429, 500, 503]) expect(await clientWith(async () => reply(status, {})).verifyCredentials()).toEqual({ outcome: 'unknown', code: `http_${status}` });
    expect((await clientWith(async () => { throw new Error('down'); }).verifyCredentials()).outcome).toBe('unknown');
  });

  test('is suppressed in a test / scoped / synthetic run like every other request', async () => {
    const fetchImpl = jest.fn();
    await expect(clientWith(fetchImpl, { env: { HUMANCARE_SCOPED_RUN: 'true' } }).verifyCredentials()).rejects.toBeInstanceOf(PushNetworkSuppressedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('scrub', () => {
  test('push tokens and URLs never survive', () => {
    expect(scrub('bad ExponentPushToken[abc] and ExpoPushToken[def] at https://exp.host/x?k=1 end')).toBe('bad [token] and [token] at [url] end');
    expect(scrub(null)).toBeNull();
    expect(scrub('x'.repeat(500))).toHaveLength(300);
  });
});
