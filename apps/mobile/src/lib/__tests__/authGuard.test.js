/* global describe, test, expect, jest, beforeEach, __dirname */
// Phase 1 authentication route guard: which routes are protected, what the guard decides in every
// session state, how the saved session is checked, and how apiFetch behaves without a valid session.
// Nothing here touches the network, a device or a database: session, nav and fetch are fakes.
const fs = require('fs');
const path = require('path');

jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), getItemAsync: jest.fn() }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('../session', () => ({
  getAccessToken: jest.fn(), getRefreshToken: jest.fn(), saveTokens: jest.fn(), compareAndSaveTokens: jest.fn(), clearTokens: jest.fn(),
  compareAndClearTokens: jest.fn(),
}));

const session = require('../session');
const { navReplace } = require('../nav');
const guard = require('../authGuard');
const { checkSession } = require('../sessionCheck');
const { apiGet, apiPost } = require('../api');

const STATUSES = ['loading', 'authed', 'anon', 'unreachable', 'error'];
const decide = (pathname, status) => guard.guardDecision({ pathname, status });

describe('which routes are public', () => {
  test.each(['/', '/welcome', '/login', '/login-otp', '/register', '/register-otp', '/forgot-password', '/reset-password', '/corporate-login', '/corporate-otp', '/terms', '/privacy'])('%s is public', (p) => {
    expect(guard.isPublicRoute(p)).toBe(true);
  });
  test.each(['/home', '/profile', '/request-tracking', '/request-details', '/tracking', '/my-requests', '/my-documents', '/notifications', '/all-services', '/select-service', '/edit-profile', '/corporate-dashboard', '/corporate-new-case', '/request/review', '/request/step1', '/service/air'])('%s is protected', (p) => {
    expect(guard.isPublicRoute(p)).toBe(false);
  });
  test('a route nobody has listed is protected (default deny)', () => {
    expect(guard.isPublicRoute('/some-new-screen')).toBe(false);
  });
  test('a query string, a hash or a trailing slash does not change the answer', () => {
    expect(guard.isPublicRoute('/login?x=1')).toBe(true);
    expect(guard.isPublicRoute('/login/')).toBe(true);
    expect(guard.isPublicRoute('/profile?tab=docs')).toBe(false);
    expect(guard.isPublicRoute('/home#top')).toBe(false);
  });
});

describe('guardDecision', () => {
  test.each(['/home', '/profile', '/request-tracking'])('1-3. signed out on %s: redirected to Login, never shown', (p) => {
    expect(decide(p, 'anon')).toEqual({ action: 'redirect', redirect: '/login' });
  });
  test('corporate screens redirect to the corporate login', () => {
    expect(decide('/corporate-dashboard', 'anon')).toEqual({ action: 'redirect', redirect: '/corporate-login' });
  });
  test.each(['/home', '/profile', '/request-tracking'])('4. a valid session on %s is allowed', (p) => {
    expect(decide(p, 'authed')).toEqual({ action: 'allow' });
  });
  test('5. while the session is being checked a protected screen waits (it is not shown)', () => {
    expect(decide('/profile', 'loading')).toEqual({ action: 'wait' });
  });
  test('an unreachable server grants nothing and offers a retry', () => {
    expect(decide('/home', 'unreachable')).toEqual({ action: 'retry', reason: 'network' });
    expect(decide('/home', 'error')).toEqual({ action: 'retry', reason: 'storage' });
  });
  test('10. public routes are open in every state', () => {
    for (const status of STATUSES) for (const p of ['/', '/welcome', '/login', '/register', '/corporate-login', '/terms']) expect(decide(p, status)).toEqual({ action: 'allow' });
  });
  test('11. no redirect loop: every redirect target is public, so it is allowed in every state', () => {
    for (const p of ['/home', '/profile', '/request-tracking', '/corporate-dashboard', '/anything-else']) {
      for (const status of STATUSES) {
        const d = decide(p, status);
        if (d.action === 'redirect') for (const s of STATUSES) expect(decide(d.redirect, s)).toEqual({ action: 'allow' });
      }
    }
  });
  test('8-9. direct URL, or a reload, with no session (after logout) is the same as signed out', () => {
    // After logout the tokens are gone: the check answers 'anon', whatever the entry URL was.
    for (const p of ['/home', '/profile?x=1', '/request-tracking?id=5']) expect(decide(p, 'anon').action).toBe('redirect');
  });
});

describe('checkSession', () => {
  const run = (getToken, fetchMe) => checkSession({ getToken, fetchMe });
  test('no saved token: signed out, and the server is not asked', async () => {
    const fetchMe = jest.fn();
    expect(await run(async () => null, fetchMe)).toEqual({ status: 'anon' });
    expect(fetchMe).not.toHaveBeenCalled();
  });
  test('a token the server accepts: signed in (a token that is only present is not enough)', async () => {
    expect(await run(async () => 'tok', async () => ({ user: { name: 'A' } }))).toEqual({ status: 'authed', me: { user: { name: 'A' } } });
  });
  test('6. an expired token that apiFetch renewed is accepted like any valid one', async () => {
    let calls = 0;
    const fetchMe = async () => { calls += 1; return { user: { name: 'A' } }; }; // apiGet renews inside
    expect((await run(async () => 'new', fetchMe)).status).toBe('authed');
    expect(calls).toBe(1);
  });
  test('the server refuses the token (401): signed out', async () => {
    expect(await run(async () => 'tok', async () => { const e = new Error('no'); e.status = 401; throw e; })).toEqual({ status: 'anon' });
  });
  test('a 403 is not a refusal of the session (the backend never answers /auth/me with 403 for a bad token): retry, not sign-out', async () => {
    expect(await run(async () => 'tok', async () => { const e = new Error('Not authorized'); e.status = 403; throw e; })).toEqual({ status: 'unreachable' });
  });
  test('7. the session could not be renewed (tokens cleared meanwhile): signed out', async () => {
    let token = 'tok';
    const out = await run(async () => token, async () => { token = null; throw new Error('Your session expired. Please log in again.'); });
    expect(out).toEqual({ status: 'anon' });
  });
  test('a network failure or a server error is unreachable, not signed in and not signed out', async () => {
    expect(await run(async () => 'tok', async () => { throw new TypeError('Network request failed'); })).toEqual({ status: 'unreachable' });
    expect(await run(async () => 'tok', async () => { const e = new Error('boom'); e.status = 500; throw e; })).toEqual({ status: 'unreachable' });
  });
});

describe('apiFetch without a valid session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    guard.setCurrentPath('/');
    guard.setApiAuthStatus('authed'); // a signed-in person: protected calls are sent
    session.compareAndSaveTokens.mockResolvedValue(true);
    session.compareAndClearTokens.mockResolvedValue('cleared');
    global.fetch = jest.fn();
  });
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

  test('a protected call with no token is not sent: the person goes to Login', async () => {
    session.getAccessToken.mockResolvedValue(null);
    await expect(apiGet('/requests/me')).rejects.toMatchObject({ status: 401 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('the corporate login is used when the person was on a corporate screen', async () => {
    session.getAccessToken.mockResolvedValue(null);
    guard.setCurrentPath('/corporate-dashboard');
    await expect(apiGet('/corporate/cases')).rejects.toBeTruthy();
    expect(navReplace).toHaveBeenCalledWith('/corporate-login');
  });
  test('10. public calls still work with no token (logging in, signing up, the public lists)', async () => {
    session.getAccessToken.mockResolvedValue(null);
    global.fetch.mockResolvedValue(reply(200, { ok: true }));
    await apiPost('/auth/login', { email: 'a@b.c', password: 'x' });
    await apiPost('/auth/register', {});
    await apiGet('/services');
    await apiGet('/geo/cities?q=mum');
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('a wrong password (401 on a public call) is an error message, not a redirect', async () => {
    session.getAccessToken.mockResolvedValue(null);
    global.fetch.mockResolvedValue(reply(401, { error: 'Invalid credentials' }));
    await expect(apiPost('/auth/login', {})).rejects.toThrow('Invalid credentials');
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('/auth/me is not public', () => {
    expect(guard.isPublicApiPath('/auth/me')).toBe(false);
    expect(guard.isPublicApiPath('/auth/push-token')).toBe(false);
    expect(guard.isPublicApiPath('/requests/me')).toBe(false);
    expect(guard.isPublicApiPath('/auth/login')).toBe(true);
    expect(guard.isPublicApiPath('/auth/password/forgot/verify-otp')).toBe(true);
  });
  test('6. an expired access token is renewed once and the call retried (one refresh, no loop)', async () => {
    session.getAccessToken.mockResolvedValue('old');
    session.getRefreshToken.mockResolvedValue('refresh');
    global.fetch
      .mockResolvedValueOnce(reply(401, { error: 'Token expired' })) // the call
      .mockResolvedValueOnce(reply(200, { token: 'new', refreshToken: 'r2' })) // /auth/refresh
      .mockResolvedValueOnce(reply(200, { requests: [] })); // the retry
    await expect(apiGet('/requests/me')).resolves.toEqual({ requests: [] });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls[1][0]).toMatch(/\/auth\/refresh$/);
    expect(session.compareAndSaveTokens).toHaveBeenCalledWith({ expectedRefreshToken: 'refresh', token: 'new', refreshToken: 'r2' });
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('7. an expired token that cannot be renewed signs out and goes to Login (no retry loop)', async () => {
    session.getAccessToken.mockResolvedValue('old');
    session.getRefreshToken.mockResolvedValue('refresh');
    global.fetch
      .mockResolvedValueOnce(reply(401, { error: 'Token expired' }))
      .mockResolvedValueOnce(reply(401, { error: 'Invalid or expired refresh token' }));
    await expect(apiGet('/requests/me')).rejects.toThrow('Your session expired');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('concurrent expired calls share one refresh (the existing behaviour is kept)', async () => {
    session.getAccessToken.mockResolvedValue('old');
    session.getRefreshToken.mockResolvedValue('refresh');
    let refreshCalls = 0;
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) { refreshCalls += 1; return reply(200, { token: 'new', refreshToken: 'r2' }); }
      const authed = global.fetch.mock.calls.filter((c) => String(c[0]) === String(url)).length > 1; // second try
      return authed ? reply(200, { ok: 1 }) : reply(401, { error: 'Token expired' });
    });
    await Promise.all([apiGet('/requests/me'), apiGet('/notifications')]);
    expect(refreshCalls).toBe(1);
  });
});

describe('wiring', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
  test('the gate is mounted in the root layout, over the navigator', () => {
    const layout = read('../../app/_layout.js');
    expect(layout).toContain("import { AuthGate } from '../components/AuthGate'");
    expect(layout).toMatch(/<Stack[^>]*\/>\s*<SosFab \/>\s*<RecaptchaBadgeGate \/>\s*<AuthGate \/>/);
  });
  test('the app context checks the saved session with the server and follows token changes', () => {
    const ctx = read('../../state/AppContext.js');
    expect(ctx).toContain('createAuthStore(');
    expect(ctx).toContain('onSessionChange(');
    expect(ctx).toContain('authStatus');
  });
  test('session.js tells listeners about sign-in and sign-out', () => {
    const s = read('../session.js');
    expect(s).toContain('announce(true)');
    expect(s).toContain('announce(false)');
  });
  test('the gate only redirects to a public screen', () => {
    for (const target of [guard.PATIENT_LOGIN, guard.CORPORATE_LOGIN]) expect(guard.isPublicRoute(target)).toBe(true);
  });
  test('sign out shows the destination before clearing tokens, so the gate cannot override it', () => {
    const profile = read('../../app/profile.js');
    expect(profile).toMatch(/navReplace\(isCorporate \? '\/corporate-login' : '\/login'\); await clearTokens\(\);/);
  });
});
