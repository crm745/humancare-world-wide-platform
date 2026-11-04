// Admin authentication over HTTP (Step 7.8.3.2): every endpoint through the real Express app, with
// the in-memory Prisma stand-in and the software authenticator. No database, no real mail. Services
// use the real clock here, so seeded times are relative to Date.now().
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const http = require('http');
const request = require('supertest');
const kit = require('./admin-login-test-kit');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const { hashToken } = require('../src/common/utils/token-hash');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAccessToken } = require('../src/modules/auth/auth.service');
const { setAdminAuthLimiterSkip, resetAdminAuthLimiters } = require('../src/modules/admin/auth/admin-auth.limiters');
const cookies = require('../src/modules/admin/auth/admin-auth.cookies');
const { app } = require('../src/app');

const { db, fake, PASSWORD, PASSWORD_HASH, PCA, seedAdmin, seedPasskey, makeAssertionResponse } = kit;

const ORIGIN = 'http://localhost:3000';
const DAY = 24 * 60 * 60 * 1000;
const GOOD_PASSWORD = 'Sunrise2027x';
const GENERIC_LOGIN = { error: 'Invalid credentials', code: 'invalid_credentials' };

beforeEach(async () => {
  fake.reset();
  kit.setEnv();
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
  setAdminAuthLimiterSkip(() => true);
  await resetAdminAuthLimiters();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  setAdminAuthLimiterSkip(null);
  jest.restoreAllMocks();
  kit.restoreEnv();
});

// ---- helpers -------------------------------------------------------------------------------

function send(method, path, body, { origin = ORIGIN, headers = {} } = {}) {
  let req = request(app)[method](path);
  if (origin !== null) req = req.set('Origin', origin);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
}
const post = (path, body, options) => send('post', path, body, options);
const get = (path, options) => send('get', path, undefined, options);

const setCookies = (res) => res.headers['set-cookie'] || [];
const cookieNamed = (res, name, predicate = () => true) => setCookies(res).find((c) => c.startsWith(`${name}=`) && predicate(c));
const valueOf = (setCookie) => setCookie.split(';')[0].split('=').slice(1).join('=');
const isCleared = (c) => /^[^=]+=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c);
const logged = () => console.error.mock.calls.flat().map(String).join('\n');
const CSRF = { 'X-HC-Admin': '1' };

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function seedInvited() {
  const admin = seedAdmin({ status: 'invited', passwordHash: null, passwordChangedAt: null, emailVerifiedAt: null });
  const token = newToken();
  db.invitations.push({
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'activation',
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(Date.now() + DAY),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 60000),
  });
  return { admin, token };
}

function seedPendingForRedeem() {
  const admin = seedAdmin({ status: 'pending_passkey' });
  const token = newToken();
  db.invitations.push({
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'passkey_enrollment',
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(Date.now() + DAY),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 60000),
  });
  return { admin, token };
}

function seedPendingWithTicket() {
  const admin = seedAdmin({ status: 'pending_passkey', passwordChangedAt: PCA });
  const invitation = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'activation',
    tokenHash: crypto.randomBytes(32).toString('hex'),
    sentToEmail: admin.email,
    expiresAt: new Date(PCA.getTime() + 72 * 3600 * 1000),
    usedAt: PCA,
    revokedAt: null,
  };
  db.invitations.push(invitation);
  const ticket = signAdminEnrollmentTicket({ adminId: admin.id, invitationId: invitation.id, passwordChangedAt: PCA });
  return { admin, ticket };
}

// An active Admin with a passkey, and the two login requests.
function activeAdmin(overrides) {
  const admin = seedAdmin(overrides);
  const passkey = seedPasskey(admin);
  return { admin, passkey, nextCounter: 1 };
}

async function httpLogin(ctx) {
  const password = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
  expect(password.status).toBe(200);
  const response = makeAssertionResponse({ challenge: password.body.options.challenge, registered: ctx.passkey.reg, counter: ctx.nextCounter });
  ctx.nextCounter += 1;
  const res = await post('/admin/login/passkey', { loginTicket: password.body.loginTicket, response });
  expect(res.status).toBe(200);
  return {
    res,
    access: valueOf(cookieNamed(res, 'hc_admin_token', (c) => /Path=\/admin;/.test(c) && !isCleared(c))),
    refresh: valueOf(cookieNamed(res, 'hc_admin_refresh')),
  };
}

const sessionCookie = (access) => ({ Cookie: `hc_admin_token=${access}` });
const refreshCookie = (refresh) => ({ Cookie: `hc_admin_refresh=${refresh}` });

// ---- A. invitation inspection --------------------------------------------------------------

describe('POST /admin/invitations/inspect', () => {
  it('reports a valid link with safe display data only', async () => {
    const { admin, token } = seedInvited();
    const res = await post('/admin/invitations/inspect', { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, state: 'valid', adminName: admin.name, purpose: 'activation' });
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toContain(admin.email);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    expect(setCookies(res)).toHaveLength(0);
  });

  it('answers an unknown link with 200 valid:false and no detail', async () => {
    const res = await post('/admin/invitations/inspect', { token: newToken() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, state: 'invalid' });
  });

  it('refuses malformed bodies with a fixed 400 that echoes nothing', async () => {
    for (const body of [{}, { token: 'short' }, { token: 123 }, { token: newToken(), extra: 'x' }, [], 'text']) {
      const res = await post('/admin/invitations/inspect', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
    const res = await post('/admin/invitations/inspect', { token: 'sentinel-value-should-not-be-echoed' });
    expect(JSON.stringify(res.body)).not.toContain('sentinel');
  });
});

// ---- B. activation acceptance --------------------------------------------------------------

describe('POST /admin/invitations/accept', () => {
  it('sets the password, returns an enrollment ticket and sets no cookie', async () => {
    const { admin, token } = seedInvited();
    const res = await post('/admin/invitations/accept', { token, password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending_passkey', nextStep: 'passkey_enrollment', ticketExpiresInSeconds: 600 });
    expect(typeof res.body.enrollmentTicket).toBe('string');
    expect(res.body).not.toHaveProperty('accessToken');
    expect(setCookies(res)).toHaveLength(0);
    expect(admin.status).toBe('pending_passkey');
  });

  it('refuses a weak password with the service message and leaves the link usable', async () => {
    const { token } = seedInvited();
    const res = await post('/admin/invitations/accept', { token, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'weak_password' });
    expect((await post('/admin/invitations/accept', { token, password: GOOD_PASSWORD })).status).toBe(200);
  });

  it('tells the holder of a used link why, and says nothing for an unknown one', async () => {
    const { token } = seedInvited();
    await post('/admin/invitations/accept', { token, password: GOOD_PASSWORD });
    const used = await post('/admin/invitations/accept', { token, password: GOOD_PASSWORD });
    expect(used.status).toBe(400);
    expect(used.body).toEqual({ error: 'This invitation link is not valid.', code: 'invalid_invitation', state: 'used' });
    const unknown = await post('/admin/invitations/accept', { token: newToken(), password: GOOD_PASSWORD });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: 'This invitation link is not valid.', code: 'invalid_invitation' });
  });

  it('turns an unexpected storage failure into a generic 500, never an invitation error', async () => {
    const { token } = seedInvited();
    db.failAudit = true;
    const res = await post('/admin/invitations/accept', { token, password: GOOD_PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses non-string and oversize passwords', async () => {
    const { token } = seedInvited();
    expect((await post('/admin/invitations/accept', { token, password: 5 })).status).toBe(400);
    expect((await post('/admin/invitations/accept', { token, password: 'x'.repeat(2000) })).body.code).toBe('invalid_request');
  });
});

// ---- C. enrollment redemption --------------------------------------------------------------

describe('POST /admin/enrollment/redeem', () => {
  it('redeems a pending-passkey link with the current password', async () => {
    const { token } = seedPendingForRedeem();
    const res = await post('/admin/enrollment/redeem', { token, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending_passkey', nextStep: 'passkey_enrollment' });
    expect(setCookies(res)).toHaveLength(0);
  });

  it('answers a wrong password and an unknown link identically, with no state', async () => {
    const { token } = seedPendingForRedeem();
    const wrong = await post('/admin/enrollment/redeem', { token, password: 'WrongPass2027x' });
    const unknown = await post('/admin/enrollment/redeem', { token: newToken(), password: PASSWORD });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'This invitation link is not valid.', code: 'invalid_invitation' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('maps an unexpected storage failure to a generic 500, not invalid_invitation', async () => {
    const { token } = seedPendingForRedeem();
    db.failAudit = true;
    const res = await post('/admin/enrollment/redeem', { token, password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

// ---- D & E. passkey registration -----------------------------------------------------------

describe('passkey registration', () => {
  it('issues options, then verifies the genuine response and activates the Admin without a session', async () => {
    const { admin, ticket } = seedPendingWithTicket();
    const options = await post('/admin/passkeys/registration/options', { ticket });
    expect(options.status).toBe(200);
    expect(options.body.options).toMatchObject({ rp: { id: 'localhost' } });
    expect(setCookies(options)).toHaveLength(0);

    const reg = makeRegistrationResponse({ challenge: options.body.options.challenge });
    const verify = await post('/admin/passkeys/registration/verify', { ticket, response: reg.response, label: 'My laptop' });
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(setCookies(verify)).toHaveLength(0);
    expect(admin.status).toBe('active');
    expect(db.passkeys).toHaveLength(1);
  });

  it('refuses a bad ticket and a bad assertion with the generic enrollment error', async () => {
    const bad = await post('/admin/passkeys/registration/options', { ticket: 'not-a-ticket' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_enrollment' });

    const { ticket } = seedPendingWithTicket();
    const options = await post('/admin/passkeys/registration/options', { ticket });
    const reg = makeRegistrationResponse({ challenge: options.body.options.challenge, origin: 'https://evil.example' });
    const verify = await post('/admin/passkeys/registration/verify', { ticket, response: reg.response });
    expect(verify.status).toBe(400);
    expect(verify.body.code).toBe('invalid_enrollment');
    expect(db.passkeys).toHaveLength(0);
  });

  it('validates the body shape', async () => {
    const { ticket } = seedPendingWithTicket();
    for (const body of [{}, { ticket: 5 }, { ticket, response: 'x' }, { ticket, response: [] }, { ticket, response: {}, label: 7 }, { ticket, response: {}, other: 1 }]) {
      const res = await post('/admin/passkeys/registration/verify', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }
  });

  it('refuses a declared body over 64 KB (413) before any work', async () => {
    const res = await post('/admin/passkeys/registration/options', { ticket: 'a'.repeat(70000) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large', code: 'payload_too_large' });
  });
});

// ---- F & G. login --------------------------------------------------------------------------

describe('POST /admin/login/password and /admin/login/passkey', () => {
  it('step one returns a ticket and options and sets nothing', async () => {
    const ctx = activeAdmin();
    const res = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ loginTicketExpiresInSeconds: 120 });
    expect(typeof res.body.loginTicket).toBe('string');
    expect(res.body.options.challenge).toBeTruthy();
    expect(setCookies(res)).toHaveLength(0);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('step two sets exactly the approved cookies and returns no token in the body', async () => {
    const ctx = activeAdmin();
    const { res, access, refresh } = await httpLogin(ctx);

    const accessCookie = cookieNamed(res, 'hc_admin_token', (c) => /Path=\/admin;/.test(c));
    expect(accessCookie).toMatch(/; Max-Age=900;/);
    expect(accessCookie).toMatch(/; Path=\/admin;/);
    expect(accessCookie).toMatch(/; HttpOnly/);
    expect(accessCookie).toMatch(/; SameSite=Strict/);
    expect(accessCookie).not.toMatch(/Secure/); // not production

    const refreshCookieHeader = cookieNamed(res, 'hc_admin_refresh');
    expect(refreshCookieHeader).toMatch(/; Path=\/admin\/refresh;/);
    expect(refreshCookieHeader).toMatch(/; HttpOnly/);
    expect(refreshCookieHeader).toMatch(/; SameSite=Strict/);
    expect(refreshCookieHeader).not.toMatch(/Max-Age/);
    const expires = new Date(/Expires=([^;]+)/.exec(refreshCookieHeader)[1]);
    expect(Math.abs(expires.getTime() - new Date(res.body.refreshExpiresAt).getTime())).toBeLessThan(1000);
    expect(Math.abs(expires.getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60 * 1000);

    // the legacy cookie variant is cleared with its original attributes
    const legacy = cookieNamed(res, 'hc_admin_token', (c) => /Path=\/;/.test(c));
    expect(legacy).toMatch(/SameSite=Lax/);
    expect(isCleared(legacy)).toBe(true);

    expect(res.body).toMatchObject({ admin: { id: ctx.admin.id, name: ctx.admin.name, email: ctx.admin.email, role: 'admin' }, accessTokenExpiresInSeconds: 900 });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(access);
    expect(body).not.toContain(refresh);
    expect(Object.keys(res.body).sort()).toEqual(['accessTokenExpiresInSeconds', 'admin', 'refreshExpiresAt']);
  });

  it('a wrong password, an unknown email and a wrong passkey are one generic 401 with no cookies', async () => {
    const ctx = activeAdmin();
    const wrong = await post('/admin/login/password', { email: ctx.admin.email, password: 'WrongPass2027x' });
    const unknown = await post('/admin/login/password', { email: 'nobody@example.org', password: PASSWORD });
    const step = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    const forged = makeAssertionResponse({ challenge: step.body.options.challenge, registered: ctx.passkey.reg, origin: 'https://evil.example' });
    const passkey = await post('/admin/login/passkey', { loginTicket: step.body.loginTicket, response: forged });
    for (const res of [wrong, unknown, passkey]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(GENERIC_LOGIN);
      expect(setCookies(res)).toHaveLength(0);
    }
  });

  it('locks at the fifth failure over HTTP and refuses even the right password', async () => {
    const ctx = activeAdmin();
    for (let i = 0; i < 5; i += 1) {
      expect((await post('/admin/login/password', { email: ctx.admin.email, password: `WrongPass2027-${i}` })).status).toBe(401);
    }
    expect(ctx.admin.lockedUntil).not.toBeNull();
    const res = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_LOGIN);
  });

  it('validates the body without echoing it', async () => {
    for (const body of [{}, { email: 1, password: 'x' }, { email: 'a@b.c' }, { email: 'a@b.c', password: '' }, { email: 'a'.repeat(300), password: 'x' }, { email: 'a@b.c', password: 'x', extra: 1 }]) {
      const res = await post('/admin/login/password', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
    for (const body of [{}, { loginTicket: 'x' }, { loginTicket: 'x', response: 'no' }, { response: {} }]) {
      expect((await post('/admin/login/passkey', body)).status).toBe(400);
    }
  });

  it('turns an unexpected audit failure into a generic 500 with no cookies, logging only safe metadata', async () => {
    const ctx = activeAdmin();
    const step = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    const response = makeAssertionResponse({ challenge: step.body.options.challenge, registered: ctx.passkey.reg });
    db.failAudit = true;
    const res = await post('/admin/login/passkey', { loginTicket: step.body.loginTicket, response });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(setCookies(res)).toHaveLength(0);
    expect(logged()).toMatch(/Request failed: \{"name":"Error","status":500,"method":"POST","path":"\/admin\/login\/passkey"\}/);
    expect(logged()).not.toMatch(/audit write failed/);
  });

  it('turns a missing WebAuthn configuration into a generic 500 and never an open guard', async () => {
    delete process.env.ADMIN_WEBAUTHN_ORIGIN;
    const res = await post('/admin/login/password', { email: 'a@example.org', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

// ---- H. refresh ----------------------------------------------------------------------------

describe('POST /admin/refresh', () => {
  it('rotates the tokens into new cookies and returns no token in the body', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    const res = await post('/admin/refresh', undefined, { headers: { ...CSRF, ...refreshCookie(session.refresh) } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessTokenExpiresInSeconds', 'refreshExpiresAt']);
    const newRefresh = valueOf(cookieNamed(res, 'hc_admin_refresh'));
    const newAccess = valueOf(cookieNamed(res, 'hc_admin_token', (c) => /Path=\/admin;/.test(c)));
    expect(newRefresh).not.toBe(session.refresh); // (access tokens minted in the same second are identical by design)
    expect(JSON.stringify(res.body)).not.toContain(newRefresh);
    // the session keeps its original absolute end
    const expires = new Date(/Expires=([^;]+)/.exec(cookieNamed(res, 'hc_admin_refresh'))[1]);
    expect(Math.abs(expires.getTime() - new Date(session.res.body.refreshExpiresAt).getTime())).toBeLessThan(1000);
    // and the new access cookie works
    expect((await get('/admin/me', { headers: sessionCookie(newAccess) })).status).toBe(200);
  });

  it('answers a second use of the same token inside the grace period with 409, touching nothing', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    await post('/admin/refresh', undefined, { headers: { ...CSRF, ...refreshCookie(session.refresh) } });
    const again = await post('/admin/refresh', undefined, { headers: { ...CSRF, ...refreshCookie(session.refresh) } });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ status: 'retry', code: 'refresh_retry' });
    expect(again.headers['retry-after']).toBe('1');
    expect(setCookies(again)).toHaveLength(0);
    expect(db.sessions[0].revokedAt).toBeNull();
  });

  it('treats reuse after the grace period as theft: 401, cookies cleared, session revoked', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    await post('/admin/refresh', undefined, { headers: { ...CSRF, ...refreshCookie(session.refresh) } });
    db.refreshTokens.find((t) => t.usedAt).usedAt = new Date(Date.now() - 60 * 1000);
    const res = await post('/admin/refresh', undefined, { headers: { ...CSRF, ...refreshCookie(session.refresh) } });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'invalid_session' });
    expect(setCookies(res).filter(isCleared)).toHaveLength(3);
    expect(db.sessions[0].revokedAt).not.toBeNull();
  });

  it('uses only the refresh cookie: no cookie, a Bearer token or the access cookie is not enough', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    const none = await post('/admin/refresh', undefined, { headers: CSRF });
    const bearer = await post('/admin/refresh', undefined, { headers: { ...CSRF, Authorization: `Bearer ${session.access}` } });
    const accessOnly = await post('/admin/refresh', undefined, { headers: { ...CSRF, ...sessionCookie(session.access) } });
    for (const res of [none, bearer, accessOnly]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_session');
    }
  });
});

// ---- I. logout -----------------------------------------------------------------------------

describe('POST /admin/logout', () => {
  it('revokes only the caller\'s own session and clears all three cookie variants', async () => {
    const ctx = activeAdmin();
    const first = await httpLogin(ctx);
    const second = await httpLogin(ctx);
    const res = await post('/admin/logout', undefined, { headers: { ...CSRF, ...sessionCookie(first.access) } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out.' });

    const cleared = setCookies(res).filter(isCleared);
    expect(cleared).toHaveLength(3);
    expect(cleared.find((c) => c.startsWith('hc_admin_token=') && /Path=\/admin;/.test(c))).toMatch(/HttpOnly; SameSite=Strict/);
    expect(cleared.find((c) => c.startsWith('hc_admin_refresh=') && /Path=\/admin\/refresh;/.test(c))).toMatch(/HttpOnly; SameSite=Strict/);
    expect(cleared.find((c) => c.startsWith('hc_admin_token=') && /Path=\/;/.test(c))).toMatch(/HttpOnly; SameSite=Lax/);

    expect(db.sessions[0].revokedAt).not.toBeNull();
    expect(db.sessions[0].revokedReason).toBe('logout');
    expect(db.sessions[1].revokedAt).toBeNull();
    expect((await get('/admin/me', { headers: sessionCookie(first.access) })).status).toBe(401);
    expect((await get('/admin/me', { headers: sessionCookie(second.access) })).status).toBe(200);
  });

  it('requires the CSRF header and a database-backed session', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    const noHeader = await post('/admin/logout', undefined, { headers: sessionCookie(session.access) });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body).toEqual({ error: 'Forbidden', code: 'csrf_required' });
    expect(db.sessions[0].revokedAt).toBeNull();

    const anonymous = await post('/admin/logout', undefined, { headers: CSRF });
    expect(anonymous.status).toBe(401);
  });

  it('does not clear the current cookies when authentication fails (so refresh-then-logout works), but still removes the legacy one', async () => {
    const res = await post('/admin/logout', undefined, { headers: { ...CSRF, ...sessionCookie('expired') } });
    expect(res.status).toBe(401);
    const legacy = cookieNamed(res, 'hc_admin_token', (c) => /Path=\/;/.test(c));
    expect(isCleared(legacy)).toBe(true);
    expect(setCookies(res).filter((c) => /Path=\/admin/.test(c))).toHaveLength(0);
  });

  it('a legacy password-only session cannot log out through the database-backed route', async () => {
    const admin = seedAdmin();
    const legacyToken = signAccessToken({ sub: admin.id, role: 'admin', adminRole: 'admin' });
    const res = await post('/admin/logout', undefined, { headers: { ...CSRF, Authorization: `Bearer ${legacyToken}` } });
    expect(res.status).toBe(401);
  });
});

// ---- J. /me and the authenticated router ---------------------------------------------------

describe('authenticated Admin routes', () => {
  it('/admin/me returns an allowlist and never the session id', async () => {
    const ctx = activeAdmin({ role: 'superadmin' });
    const session = await httpLogin(ctx);
    const res = await get('/admin/me', { headers: sessionCookie(session.access) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.admin).sort()).toEqual(['adminRole', 'corporateId', 'corporateReview', 'id', 'role']);
    expect(res.body.admin).toMatchObject({ id: ctx.admin.id, role: 'admin', adminRole: 'superadmin', corporateReview: true });
    expect(JSON.stringify(res.body)).not.toMatch(/sessionId|sid/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the existing role gates working behind the new middleware', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    const res = await get('/admin/admins', { headers: sessionCookie(session.access) });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Superadmin access required' });
  });

  it('takes the role from the database on every request', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    ctx.admin.role = 'superadmin';
    const res = await get('/admin/me', { headers: sessionCookie(session.access) });
    expect(res.body.admin.adminRole).toBe('superadmin');
  });

  it('rejects an Admin disabled after login', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    ctx.admin.status = 'disabled';
    expect((await get('/admin/me', { headers: sessionCookie(session.access) })).status).toBe(401);
  });

  it('rejects an enrollment ticket and a login ticket used as credentials', async () => {
    const { ticket } = seedPendingWithTicket();
    const ctx = activeAdmin();
    const step = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    for (const credential of [ticket, step.body.loginTicket]) {
      expect((await get('/admin/me', { headers: { Authorization: `Bearer ${credential}` } })).status).toBe(401);
      expect((await get('/admin/me', { headers: sessionCookie(credential) })).status).toBe(401);
    }
  });

  describe('legacy tokens', () => {
    it('are accepted for an active Admin with no passkey while enforcement is off', async () => {
      const admin = seedAdmin();
      const token = signAccessToken({ sub: admin.id, role: 'admin', adminRole: 'admin' });
      const res = await get('/admin/me', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(res.body.admin).not.toHaveProperty('sessionId');
    });

    it('are refused for an Admin who has a passkey', async () => {
      const ctx = activeAdmin();
      const token = signAccessToken({ sub: ctx.admin.id, role: 'admin', adminRole: 'admin' });
      expect((await get('/admin/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    });

    it('are refused for everyone once enforcement is on', async () => {
      const admin = seedAdmin();
      const token = signAccessToken({ sub: admin.id, role: 'admin', adminRole: 'admin' });
      process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
      expect((await get('/admin/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    });
  });
});

// ---- public endpoints ignore credentials ---------------------------------------------------

describe('public endpoints ignore Bearer tokens and cookies', () => {
  it('behave identically with garbage or even valid credentials attached', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    const { token } = seedInvited();
    const credentials = [
      { Authorization: 'Bearer garbage', Cookie: 'hc_admin_token=garbage; hc_admin_refresh=garbage' },
      { Authorization: `Bearer ${session.access}`, Cookie: `hc_admin_token=${session.access}; hc_admin_refresh=${session.refresh}` },
    ];
    for (const headers of credentials) {
      const inspect = await post('/admin/invitations/inspect', { token }, { headers });
      expect(inspect.status).toBe(200);
      expect(inspect.body.valid).toBe(true);
      const login = await post('/admin/login/password', { email: ctx.admin.email, password: 'WrongPass2027x' }, { headers });
      expect(login.status).toBe(401);
      expect(login.body).toEqual(GENERIC_LOGIN);
      expect(setCookies(login)).toHaveLength(0);
    }
  });
});

// ---- Origin / CSRF / CORS ------------------------------------------------------------------

describe('origin and CSRF enforcement', () => {
  const endpoints = [
    '/admin/invitations/inspect', '/admin/invitations/accept', '/admin/enrollment/redeem',
    '/admin/passkeys/registration/options', '/admin/passkeys/registration/verify',
    '/admin/login/password', '/admin/login/passkey', '/admin/refresh', '/admin/logout',
  ];

  it.each(endpoints)('%s refuses a foreign, missing or "null" Origin', async (path) => {
    for (const origin of ['https://evil.example', null, 'null', 'http://localhost:3000.evil.example']) {
      const res = await post(path, {}, { origin, headers: CSRF });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden', code: 'origin_not_allowed' });
      expect(setCookies(res)).toHaveLength(0);
    }
  });

  it.each(['/admin/refresh', '/admin/logout'])('%s requires X-HC-Admin: 1', async (path) => {
    for (const headers of [{}, { 'X-HC-Admin': '0' }, { 'X-HC-Admin': 'true' }]) {
      const res = await post(path, undefined, { headers });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden', code: 'csrf_required' });
    }
  });

  it('fails closed with a generic 500 when the origin configuration is unusable', async () => {
    process.env.ADMIN_WEBAUTHN_ORIGIN = 'not a url';
    const res = await post('/admin/login/password', { email: 'a@example.org', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('leaves the global CORS behavior unchanged: a preflight is still answered, the real request is not', async () => {
    const preflight = await request(app)
      .options('/admin/login/password')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://evil.example');
    expect((await post('/admin/login/password', { email: 'a@example.org', password: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  describe('the pre-existing authenticated routes (lenient guard)', () => {
    it('refuse a foreign Origin on any method', async () => {
      const ctx = activeAdmin();
      const session = await httpLogin(ctx);
      const res = await get('/admin/me', { origin: 'https://evil.example', headers: sessionCookie(session.access) });
      expect(res.status).toBe(403);
    });

    it('refuse a state-changing cookie request with no Origin, but allow a Bearer client and reads', async () => {
      const ctx = activeAdmin();
      const session = await httpLogin(ctx);
      expect((await send('post', '/admin/corporates', {}, { origin: null, headers: sessionCookie(session.access) })).status).toBe(403);
      expect((await get('/admin/me', { origin: null, headers: sessionCookie(session.access) })).status).toBe(200);
      expect((await send('post', '/admin/corporates', {}, { origin: null, headers: { Authorization: 'Bearer garbage' } })).status).toBe(401);
    });
  });
});

// ---- bodies, errors and logs ---------------------------------------------------------------

describe('malformed, oversized and failing requests', () => {
  it('answers malformed JSON with a fixed body and neither sends nor logs any of it', async () => {
    const res = await request(app)
      .post('/admin/login/password')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"email":"a@example.org","password":"Sup3rSecretValue!');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON body', code: 'invalid_json' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/Sup3rSecret|Unexpected|position/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('refuses a body over the 100 KB parser limit without echoing it', async () => {
    const res = await post('/admin/invitations/inspect', { token: 'q'.repeat(120000) });
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).not.toContain('qqqq');
  });

  it('logs only name, code, status, method and path - never bodies, tickets, tokens or messages', async () => {
    const ctx = activeAdmin();
    const secretPassword = 'Sup3rSecretValue!9';
    const step = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    const response = makeAssertionResponse({ challenge: step.body.options.challenge, registered: ctx.passkey.reg });
    db.failAudit = true;
    await post('/admin/login/passkey', { loginTicket: step.body.loginTicket, response });
    db.failAudit = false;
    await post('/admin/enrollment/redeem', { token: newToken(), password: secretPassword });
    await request(app).post('/admin/login/password').set('Origin', ORIGIN).set('Content-Type', 'application/json').send(`{"password":"${secretPassword}`);

    const output = [logged(), console.log.mock.calls.flat().map(String).join('\n')].join('\n');
    for (const secret of [secretPassword, PASSWORD, step.body.loginTicket, step.body.options.challenge, ctx.admin.email, response.response.signature]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/audit write failed/);
  });
});

// ---- rate limits ---------------------------------------------------------------------------

describe('rate limiting', () => {
  beforeEach(() => setAdminAuthLimiterSkip(() => false));

  it('limits invitation acceptance to 10 per 15 minutes per IP', async () => {
    for (let i = 0; i < 10; i += 1) expect((await post('/admin/invitations/accept', {})).status).toBe(400);
    const res = await post('/admin/invitations/accept', {});
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests. Please try again later.', code: 'rate_limited' });
    expect(res.headers.ratelimit || res.headers['ratelimit-limit']).toBeTruthy();
  });

  it('limits the password step to 20 per 15 minutes per IP, counting failures and successes alike', async () => {
    for (let i = 0; i < 20; i += 1) expect((await post('/admin/login/password', {})).status).toBe(400);
    expect((await post('/admin/login/password', {})).status).toBe(429);
  });

  it('keeps separate budgets per endpoint', async () => {
    for (let i = 0; i < 10; i += 1) await post('/admin/enrollment/redeem', {});
    expect((await post('/admin/enrollment/redeem', {})).status).toBe(429);
    expect((await post('/admin/invitations/inspect', {})).status).toBe(400);
  });

  it('does not touch the service-level lockout: the account still locks at five failures well inside the IP limit', async () => {
    const ctx = activeAdmin();
    for (let i = 0; i < 5; i += 1) await post('/admin/login/password', { email: ctx.admin.email, password: `WrongPass2027-${i}` });
    expect(ctx.admin.lockedUntil).not.toBeNull();
  });
});

// ---- cookie configuration ------------------------------------------------------------------

describe('cookie options in production', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; });

  it('are Secure in production, with the same Path and SameSite on set and clear', () => {
    process.env.NODE_ENV = 'production';
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    const expires = new Date(Date.now() + DAY);
    cookies.setSessionCookies(res, { accessToken: 'a', refreshToken: 'r', refreshExpiresAt: expires });
    cookies.clearAllSessionCookies(res);

    expect(res.cookie).toHaveBeenCalledWith('hc_admin_token', 'a', { httpOnly: true, secure: true, sameSite: 'strict', path: '/admin', maxAge: 900000 });
    expect(res.cookie).toHaveBeenCalledWith('hc_admin_refresh', 'r', { httpOnly: true, secure: true, sameSite: 'strict', path: '/admin/refresh', expires });
    expect(res.clearCookie).toHaveBeenCalledWith('hc_admin_token', { httpOnly: true, secure: true, sameSite: 'strict', path: '/admin' });
    expect(res.clearCookie).toHaveBeenCalledWith('hc_admin_refresh', { httpOnly: true, secure: true, sameSite: 'strict', path: '/admin/refresh' });
    expect(res.clearCookie).toHaveBeenCalledWith('hc_admin_token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });
});

describe('legacy login is unchanged', () => {
  it('POST /admin/login still works without an Origin and still returns the legacy body', async () => {
    const admin = seedAdmin();
    const res = await request(app).post('/admin/login').send({ email: admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(cookieNamed(res, 'hc_admin_token')).toMatch(/Path=\/;/);
    expect(PASSWORD_HASH).toBeTruthy();
  });
});

// ---- exact 64 KB enforcement on the WebAuthn bodies ---------------------------------------

// A real HTTP request with NO Content-Length: Node frames it with Transfer-Encoding: chunked.
function chunkedPost(path, bodyText) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      let chunked = false;
      const req = http.request(
        { port: server.address().port, method: 'POST', path, agent: false, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (part) => { data += part; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, chunked }); });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      const middle = Math.floor(bodyText.length / 2);
      req.write(bodyText.slice(0, middle));
      req.write(bodyText.slice(middle));
      req.end();
      chunked = req.chunkedEncoding === true && req.getHeader('content-length') === undefined;
    });
  });
}

const declaredPost = (path, bodyText) => request(app).post(path).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(bodyText);

// A JSON body of exactly `total` bytes (ASCII only) for each limited endpoint.
const LIMITED = {
  '/admin/passkeys/registration/options': (pad) => ({ ticket: 'x', pad }),
  '/admin/passkeys/registration/verify': (pad) => ({ ticket: 'x', response: { pad } }),
  '/admin/login/passkey': (pad) => ({ loginTicket: 'x', response: { pad } }),
};
function bodyOfSize(path, total) {
  const make = (n) => JSON.stringify(LIMITED[path]('a'.repeat(n)));
  return make(total - make(0).length);
}

describe.each(Object.keys(LIMITED))('64 KB body limit on %s', (path) => {
  const KB64 = 64 * 1024;

  it('refuses a chunked body (no Content-Length) between 64 KB and 100 KB', async () => {
    const text = bodyOfSize(path, 80000);
    expect(Buffer.byteLength(text)).toBe(80000);
    const res = await chunkedPost(path, text);
    expect(res.chunked).toBe(true);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large', code: 'payload_too_large' });
  });

  it('refuses a declared body between 64 KB and 100 KB', async () => {
    const res = await declaredPost(path, bodyOfSize(path, 80000));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large', code: 'payload_too_large' });
  });

  it('counts the bytes received: exactly 64 KB passes, one byte more is refused (chunked and declared)', async () => {
    const atLimit = bodyOfSize(path, KB64);
    const over = bodyOfSize(path, KB64 + 1);
    expect(Buffer.byteLength(atLimit)).toBe(KB64);
    expect((await chunkedPost(path, atLimit)).status).not.toBe(413);
    expect((await declaredPost(path, atLimit)).status).not.toBe(413);
    expect((await chunkedPost(path, over)).status).toBe(413);
    expect((await declaredPost(path, over)).status).toBe(413);
  });

  it('lets an ordinary small body through to validation and the service', async () => {
    const res = await chunkedPost(path, bodyOfSize(path, 400));
    expect(res.status).not.toBe(413);
    expect(res.body.code).not.toBe('payload_too_large');
  });

  it('leaves anything over the global 100 KB limit to the global parser, echoing nothing', async () => {
    const res = await declaredPost(path, bodyOfSize(path, 120000));
    expect(res.status).toBe(413);
    expect(res.body.code).not.toBe('payload_too_large'); // the parser answered, not the route check
    expect(JSON.stringify(res.body)).not.toContain('aaaa');
  });

  it('still answers malformed JSON with the fixed body, logging nothing', async () => {
    const res = await declaredPost(path, '{"ticket":"Sup3rSecretValue!');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON body', code: 'invalid_json' });
    expect(console.error).not.toHaveBeenCalled();
  });
});

// ---- the lenient guard fails closed without a usable expected origin ------------------------

describe('lenient origin guard without a usable ADMIN_WEBAUTHN_ORIGIN configuration', () => {
  const BROKEN = {
    'missing origin': () => { delete process.env.ADMIN_WEBAUTHN_ORIGIN; },
    'invalid origin': () => { process.env.ADMIN_WEBAUTHN_ORIGIN = 'not a url'; },
    'valid origin but incomplete configuration (no RP name)': () => { delete process.env.ADMIN_WEBAUTHN_RP_NAME; },
  };
  const cookie = { Cookie: 'hc_admin_token=anything' };

  describe.each(Object.keys(BROKEN))('%s', (name) => {
    beforeEach(() => BROKEN[name]());

    it('refuses a cookie-authenticated state-changing request, whatever its Origin', async () => {
      for (const origin of [ORIGIN, 'https://evil.example', 'null', null]) {
        const res = await send('post', '/admin/corporates', {}, { origin, headers: cookie });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden', code: 'origin_not_allowed' });
      }
      const refreshOnly = await send('delete', '/admin/cases/1', undefined, { origin: null, headers: { Cookie: 'hc_admin_refresh=anything' } });
      expect(refreshOnly.status).toBe(403);
    });

    it('still lets Bearer clients, reads and cookie-less requests reach authentication', async () => {
      expect((await send('post', '/admin/corporates', {}, { origin: null, headers: { Authorization: 'Bearer garbage', ...cookie } })).status).toBe(401);
      expect((await get('/admin/me', { origin: null, headers: cookie })).status).toBe(401);
      expect((await send('post', '/admin/corporates', {}, { origin: null })).status).toBe(401);
    });

    it('does not weaken the strict guard on the new endpoints', async () => {
      const res = await post('/admin/login/password', { email: 'a@example.org', password: PASSWORD });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    });
  });

  it('behaves as before with a valid configuration: a matching Origin reaches authentication', async () => {
    expect((await send('post', '/admin/corporates', {}, { origin: ORIGIN, headers: cookie })).status).toBe(401);
    expect((await send('post', '/admin/corporates', {}, { origin: 'https://evil.example', headers: cookie })).status).toBe(403);
  });
});

// ---- retired legacy Admin management routes ----------------------------------------------

describe('legacy Admin create / hard-delete routes are retired', () => {
  it('POST and DELETE /admin/admins return 404 under a valid database-backed superadmin session, changing nothing', async () => {
    const ctx = activeAdmin({ role: 'superadmin' });
    const other = seedAdmin({ email: 'other-admin@example.org' });
    const session = await httpLogin(ctx);
    const admins = db.admins.length;

    const created = await post('/admin/admins', { name: 'Should Not Exist', email: 'new@example.org', password: 'SomePass@123' }, { headers: sessionCookie(session.access) });
    expect(created.status).toBe(404);
    expect(db.admins).toHaveLength(admins);
    expect(db.admins.some((a) => a.email === 'new@example.org')).toBe(false);

    for (const id of [other.id, ctx.admin.id, 999999]) {
      const deleted = await send('delete', `/admin/admins/${id}`, undefined, { headers: sessionCookie(session.access) });
      expect(deleted.status).toBe(404);
    }
    expect(db.admins).toHaveLength(admins);
    expect(db.admins.find((a) => a.id === other.id)).toBeDefined();
  });

  it('answers 404 for a regular admin too (the route no longer exists), and still 401 without a session', async () => {
    const ctx = activeAdmin();
    const session = await httpLogin(ctx);
    expect((await post('/admin/admins', {}, { headers: sessionCookie(session.access) })).status).toBe(404);
    expect((await send('delete', '/admin/admins/1', undefined, { headers: sessionCookie(session.access) })).status).toBe(404);
    expect((await post('/admin/admins', {})).status).toBe(401);
    expect((await send('delete', '/admin/admins/1')).status).toBe(401);
  });

  it('GET /admin/admins stays, protected by requireSuperAdmin', async () => {
    const superadmin = activeAdmin({ role: 'superadmin' });
    const regular = activeAdmin();
    const superSession = await httpLogin(superadmin);
    const regularSession = await httpLogin(regular);

    const allowed = await get('/admin/admins', { headers: sessionCookie(superSession.access) });
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.admins)).toBe(true);
    expect(allowed.body.admins.length).toBe(2);

    const refused = await get('/admin/admins', { headers: sessionCookie(regularSession.access) });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'Superadmin access required' });
    expect((await get('/admin/admins')).status).toBe(401);
  });
});
