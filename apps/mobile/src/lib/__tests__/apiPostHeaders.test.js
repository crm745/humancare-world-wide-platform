/* global describe, test, expect, jest, beforeEach */
// apiPost's optional third argument (custom headers, e.g. a payment order's Idempotency-Key — see lib/api.js).
// Uses the real api.js and authGuard.js; only the native modules and the token store are faked.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('../session', () => ({
  getAccessToken: jest.fn(async () => 'test-token'),
  getRefreshToken: jest.fn(),
  compareAndSaveTokens: jest.fn(),
  compareAndClearTokens: jest.fn(),
}));

const guard = require('../authGuard');
const { apiPost } = require('../api');

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  require('../session').getAccessToken.mockResolvedValue('test-token');
  guard.setApiAuthStatus('authed');
  guard.setCurrentPath('/home');
  global.fetch = jest.fn().mockResolvedValue(reply(200, { ok: true }));
});

describe('apiPost', () => {
  test('an existing (path, body) call sends only the default headers, exactly as before', async () => {
    await apiPost('/requests', { a: 1 });
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer test-token' });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });
  test('an empty options object still behaves exactly as (path, body)', async () => {
    await apiPost('/requests', { a: 1 }, {});
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer test-token' });
  });
  test('a custom header (e.g. Idempotency-Key) is added on top of the defaults', async () => {
    await apiPost('/invoices/761/payment-orders', {}, { headers: { 'Idempotency-Key': 'abc123' } });
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer test-token', 'Idempotency-Key': 'abc123' });
    expect(init.body).toBe(JSON.stringify({}));
  });
});
