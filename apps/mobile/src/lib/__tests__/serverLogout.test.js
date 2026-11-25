/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// Telling the server a session has ended (POST /auth/logout), and the sequence behind Log out and the idle timeout (sessionEnd).
const fs = require('fs');
const path = require('path');
const { revokeServerSession, LOGOUT_TIMEOUT_MS, LOGOUT_PATH } = require('../serverLogout');
const { endSession } = require('../sessionEnd');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').split('\r\n').join('\n');

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('revokeServerSession', () => {
  test('POSTs the refresh token, and only that, to /auth/logout', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await revokeServerSession({ refreshToken: 'r.t.k', baseUrl: 'https://api.example.com', fetchImpl });
    expect(result).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/auth/logout');
    expect(LOGOUT_PATH).toBe('/auth/logout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'r.t.k' });
    expect(Object.keys(init.headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'content-type']); // no Authorization header
  });
  test.each([[undefined], [null], [''], [123], [{}]])('nothing to revoke (%p): nothing is sent', async (token) => {
    const fetchImpl = jest.fn();
    expect(await revokeServerSession({ refreshToken: token, baseUrl: 'https://api.example.com', fetchImpl })).toBe('skipped');
    expect(await revokeServerSession({ refreshToken: 'x', baseUrl: '', fetchImpl })).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('any answer counts as delivered, including a refusal', async () => {
    for (const status of [200, 400, 429, 500]) {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: status < 400, status });
      expect(await revokeServerSession({ refreshToken: 'x', baseUrl: 'https://a.example', fetchImpl })).toBe('sent');
    }
  });
  test('offline (the call fails) is "failed", never a throw', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    await expect(revokeServerSession({ refreshToken: 'x', baseUrl: 'https://a.example', fetchImpl })).resolves.toBe('failed');
    await expect(revokeServerSession({ refreshToken: 'x', baseUrl: 'https://a.example', fetchImpl: undefined, timeoutMs: 1 }).catch(() => 'threw')).resolves.not.toBe('threw');
  });
  test('it gives up after 8 seconds (the request is aborted) and never retries', async () => {
    expect(LOGOUT_TIMEOUT_MS).toBe(8000);
    let aborted = false;
    const fetchImpl = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }));
    const pending = revokeServerSession({ refreshToken: 'x', baseUrl: 'https://a.example', fetchImpl });
    await jest.advanceTimersByTimeAsync(7999);
    expect(aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('failed');
    expect(aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('endSession: the order of a sign-out', () => {
  const rig = (extra = {}) => {
    const calls = [];
    return {
      calls,
      args: {
        readRefreshToken: jest.fn(async () => { calls.push('read'); return 'REFRESH'; }),
        revoke: jest.fn(async () => { calls.push('revoke'); return 'sent'; }),
        clear: jest.fn(async () => { calls.push('clear'); }),
        beforeClear: jest.fn(async () => { calls.push('beforeClear'); }),
        ...extra,
      },
    };
  };
  test('a patient: the token is read, the draft goes, the server is told, then the tokens are cleared', async () => {
    const { calls, args } = rig();
    await endSession(args);
    expect(calls).toEqual(['read', 'beforeClear', 'revoke', 'clear']);
    expect(args.revoke).toHaveBeenCalledWith('REFRESH');
  });
  test('the draft is removed BEFORE the tokens are cleared (the account is read from them); the idle timeout passes no beforeClear and keeps the draft', async () => {
    const { calls, args } = rig({ beforeClear: null });
    await endSession(args);
    expect(calls).toEqual(['read', 'revoke', 'clear']);
  });
  test('the server call is not waited for: a call that never answers does not hold the sign-out', async () => {
    const { calls, args } = rig({ revoke: jest.fn(() => { calls.push('revoke'); return new Promise(() => {}); }) });
    await endSession(args);
    expect(calls).toEqual(['read', 'beforeClear', 'revoke', 'clear']);
  });
  test.each([
    ['the token cannot be read', { readRefreshToken: jest.fn().mockRejectedValue(new Error('keychain')) }],
    ['the server call throws', { revoke: jest.fn(() => { throw new Error('boom'); }) }],
    ['the server call rejects', { revoke: jest.fn().mockRejectedValue(new Error('offline')) }],
    ['removing the draft fails', { beforeClear: jest.fn().mockRejectedValue(new Error('disk')) }],
  ])('%s: the person is still signed out on the phone', async (_name, extra) => {
    const { args } = rig(extra);
    await expect(endSession(args)).resolves.toBeUndefined();
    expect(args.clear).toHaveBeenCalledTimes(1);
  });
  test('a corporate account has nothing to revoke: the token is not even read, and the server is not called', async () => {
    const { calls, args } = rig();
    await endSession({ ...args, isCorporate: true });
    expect(args.readRefreshToken).not.toHaveBeenCalled();
    expect(args.revoke).not.toHaveBeenCalled();
    expect(calls).toEqual(['beforeClear', 'clear']);
  });
  test('no refresh token saved: nothing to revoke, still signed out', async () => {
    const { args } = rig({ readRefreshToken: jest.fn().mockResolvedValue(null) });
    await endSession(args);
    expect(args.revoke).not.toHaveBeenCalled();
    expect(args.clear).toHaveBeenCalledTimes(1);
  });
});

describe('the wiring', () => {
  test('signOut.js connects the real token store, the server call and the base URL', () => {
    const wiring = read('lib/signOut.js');
    expect(wiring).toContain("import { API_BASE_URL } from './api';");
    expect(wiring).toContain('readRefreshToken: getRefreshToken');
    expect(wiring).toContain('revokeServerSession({ refreshToken, baseUrl: API_BASE_URL })');
    expect(wiring).toContain('clear: clearTokens');
  });
  test('Profile > Log out uses it: the screen opens first, the draft goes before the tokens, as before', () => {
    const profile = read('app/profile.js');
    expect(profile).toMatch(/navReplace\(isCorporate \? '\/corporate-login' : '\/login'\);\s+const \{ push \} = await signOutSession\(\{ isCorporate, beforeClear: clearDraftEverywhere \}\);/);
    expect(profile).not.toContain('clearTokens');
  });
  test('account deletion is not changed (the server has already retired the account)', () => {
    expect(read('app/delete-account-otp.js')).toContain('await clearTokens();');
  });
});
