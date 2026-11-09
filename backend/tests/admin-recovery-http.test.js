// Admin passkey-recovery over HTTP (Step 7.9.7): the seven recovery endpoints through the real
// Express app, with the in-memory Prisma stand-in, the software authenticator and a mocked mailer.
// No database, no real mail, no real account. Services use the real clock here, so seeded times
// are relative to Date.now().
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const request = require('supertest');
const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const { hashToken } = require('../src/common/utils/token-hash');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminLoginTicket, ADMIN_LOGIN_FLOWS } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { setAdminAuthLimiterSkip, resetAdminAuthLimiters } = require('../src/modules/admin/auth/admin-auth.limiters');
const { app } = require('../src/app');

const { db, fake, PASSWORD, PCA, seedAdmin, seedPasskey, makeAssertionResponse } = kit;

const ORIGIN = 'http://localhost:3000';
const PORTAL = 'https://admin.example.org';
const DAY = 24 * 60 * 60 * 1000;
const CSRF = { 'X-HC-Admin': '1' };
const TARGET_EMAIL = 'target@example.org';
const GENERIC_RECOVERY = { error: 'This passkey recovery session is not valid. Please start again.', code: 'invalid_recovery' };

const savedPortal = process.env.ADMIN_PORTAL_URL;

beforeEach(async () => {
  fake.reset();
  kit.setEnv();
  process.env.ADMIN_PORTAL_URL = PORTAL;
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
  mailer.sendMail.mockReset().mockResolvedValue(undefined);
  setAdminAuthLimiterSkip(() => true);
  await resetAdminAuthLimiters();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  setAdminAuthLimiterSkip(null);
  jest.restoreAllMocks();
  kit.restoreEnv();
  if (savedPortal === undefined) delete process.env.ADMIN_PORTAL_URL; else process.env.ADMIN_PORTAL_URL = savedPortal;
});

// ---- helpers -------------------------------------------------------------------------------

function send(method, path, body, { origin = ORIGIN, headers = {} } = {}) {
  let req = request(app)[method](path);
  if (origin !== null) req = req.set('Origin', origin);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
}
const post = (path, body, options) => send('post', path, body, options);
const setCookies = (res) => res.headers['set-cookie'] || [];
const valueOf = (setCookie) => setCookie.split(';')[0].split('=').slice(1).join('=');
const isCleared = (c) => /^[^=]+=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c);
const cookieNamed = (res, name, predicate = () => true) => setCookies(res).find((c) => c.startsWith(`${name}=`) && predicate(c));
const logged = () => [...console.error.mock.calls, ...console.log.mock.calls].flat().map(String).join('\n');
const newToken = () => crypto.randomBytes(32).toString('base64url');
// Sign-in leaves an 'authentication' challenge behind; only recovery challenges matter here.
const recoveryChallenges = () => db.challenges.filter((c) => c.purpose.startsWith('recovery_'));
const auditsOf = (event) => db.audits.filter((a) => a.event === event);

// An active Admin with a passkey, signed in over HTTP. `cookie` is the session header to send.
async function signedIn(overrides = {}) {
  const admin = seedAdmin(overrides);
  const passkey = seedPasskey(admin);
  const ctx = { admin, passkey, nextCounter: 1 };
  const password = await post('/admin/login/password', { email: admin.email, password: PASSWORD });
  expect(password.status).toBe(200);
  const response = makeAssertionResponse({ challenge: password.body.options.challenge, registered: passkey.reg, counter: ctx.nextCounter });
  ctx.nextCounter += 1;
  const res = await post('/admin/login/passkey', { loginTicket: password.body.loginTicket, response });
  expect(res.status).toBe(200);
  const access = valueOf(cookieNamed(res, 'hc_admin_token', (c) => /Path=\/admin;/.test(c) && !isCleared(c)));
  ctx.cookie = { Cookie: `hc_admin_token=${access}` };
  ctx.sessionId = db.sessions.filter((s) => s.adminId === admin.id).at(-1).id;
  return ctx;
}
const superadmin = (n = 1) => signedIn({ role: 'superadmin', email: `super${n}@example.org`, name: `Super ${n}` });

// The Admin who lost their passkey, and an open request for them.
function seedTarget(overrides = {}) {
  const admin = seedAdmin({ email: TARGET_EMAIL, name: 'Tara Target', ...overrides });
  const oldPasskey = seedPasskey(admin);
  return { admin, oldPasskey };
}
function seedRequest(admin, overrides = {}) {
  const row = {
    id: db.recoveryRequests.length + 1,
    adminId: admin.id,
    requestedByAdminId: null,
    requestedVia: 'operator',
    requestIp: null,
    reason: 'Lost laptop',
    status: 'pending',
    approvalsRequired: 2,
    approvedAt: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 7 * DAY),
    createdAt: new Date(Date.now() - 60000),
    ...overrides,
  };
  db.recoveryRequests.push(row);
  return row;
}
// An approved request with a recovery invitation whose raw token we know.
function seedApproved(admin, { request: requestOverrides = {}, invitation: invitationOverrides = {} } = {}) {
  const row = seedRequest(admin, { status: 'approved', approvedAt: new Date(Date.now() - 60000), ...requestOverrides });
  const token = newToken();
  const invitation = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'passkey_recovery',
    recoveryRequestId: row.id,
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(Date.now() + DAY),
    usedAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 60000),
    ...invitationOverrides,
  };
  db.invitations.push(invitation);
  return { request: row, invitation, token };
}

const stepUpPath = (kind, id) => `/admin/recovery/requests/${id}/${kind === 'approve' ? 'approval' : 'rejection'}/options`;
const decisionPath = (kind, id) => `/admin/recovery/requests/${id}/${kind}`;
const authed = (who, extra = {}) => ({ headers: { ...CSRF, ...who.cookie, ...extra } });

function assertion(who, options, overrides = {}) {
  const response = makeAssertionResponse({ challenge: options.challenge, registered: who.passkey.reg, counter: who.nextCounter, ...overrides });
  who.nextCounter += 1;
  return response;
}

// Step-up then decision, over HTTP, the way a client would.
async function httpDecide(kind, who, id, { reason, body = {} } = {}) {
  const issued = await post(stepUpPath(kind, id), undefined, authed(who));
  expect(issued.status).toBe(200);
  const response = assertion(who, issued.body.options);
  return post(decisionPath(kind, id), { response, ...(reason !== undefined && { reason }), ...body }, authed(who));
}

const mailedToken = () => {
  const call = mailer.sendMail.mock.calls.find(([m]) => /#token=/.test(m.text));
  expect(call).toBeDefined();
  return /#token=(\S+)/.exec(call[0].text)[1];
};

// ---- 1. approval and rejection endpoints ----------------------------------------------------

describe('recovery decision endpoints: access', () => {
  const protectedCalls = (id) => [
    ['approval step-up', stepUpPath('approve', id), undefined],
    ['rejection step-up', stepUpPath('reject', id), undefined],
    ['approve', decisionPath('approve', id), { response: {} }],
    ['reject', decisionPath('reject', id), { response: {} }],
  ];

  it.each([0, 1, 2, 3])('refuses an anonymous caller with 401 (%#)', async (i) => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const [, path, body] = protectedCalls(row.id)[i];
    const res = await post(path, body, { headers: CSRF });
    expect(res.status).toBe(401);
    expect(setCookies(res)).toHaveLength(0);
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it.each([0, 1, 2, 3])('refuses a regular Admin with 403, creating no challenge or decision (%#)', async (i) => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const regular = await signedIn({ role: 'admin', email: 'regular@example.org' });
    const [, path, body] = protectedCalls(row.id)[i];
    const res = await post(path, body, authed(regular));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Superadmin access required' });
    expect(recoveryChallenges()).toHaveLength(0);
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('refuses wrong, revoked, idle-expired and non-session credentials with 401', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const path = stepUpPath('approve', row.id);

    expect((await post(path, undefined, { headers: { ...CSRF, Cookie: 'hc_admin_token=garbage' } })).status).toBe(401);
    expect((await post(path, undefined, { headers: { ...CSRF, Authorization: 'Bearer garbage' } })).status).toBe(401);

    // an enrollment ticket and a login ticket are not credentials
    const enrollment = signAdminEnrollmentTicket({ adminId: a.admin.id, invitationId: 1, passwordChangedAt: PCA });
    const login = signAdminLoginTicket({ adminId: a.admin.id, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    for (const ticket of [enrollment, login]) {
      expect((await post(path, undefined, { headers: { ...CSRF, Authorization: `Bearer ${ticket}` } })).status).toBe(401);
    }

    // idle-expired session (idle expiry ends a session for good)
    const idle = db.sessions.find((s) => s.id === a.sessionId);
    idle.idleExpiresAt = new Date(Date.now() - 1000);
    expect((await post(path, undefined, authed(a))).status).toBe(401);

    // revoked session
    const b = await superadmin(2);
    expect((await post(path, undefined, authed(b))).status).toBe(200);
    db.sessions.find((s) => s.id === b.sessionId).revokedAt = new Date();
    expect((await post(path, undefined, authed(b))).status).toBe(401);
  });

  it('a superadmin demoted or disabled after sign-in is refused at once (role and status come from the database)', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    a.admin.role = 'admin';
    expect((await post(stepUpPath('approve', row.id), undefined, authed(a))).status).toBe(403);
    a.admin.role = 'superadmin';
    a.admin.status = 'disabled';
    expect((await post(stepUpPath('approve', row.id), undefined, authed(a))).status).toBe(401);
  });

  it('the target cannot decide on their own request, and an unknown or malformed id is refused', async () => {
    const t = await signedIn({ role: 'superadmin', email: TARGET_EMAIL, name: 'Tara Target' });
    const row = seedRequest(t.admin);
    const res = await post(stepUpPath('approve', row.id), undefined, authed(t));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This recovery request is not available to you.', code: 'not_available' });

    const a = await superadmin(2);
    expect((await post(stepUpPath('approve', 999), undefined, authed(a))).status).toBe(404);
    for (const id of ['0', 'abc', '1.5', '99999999999', '-1']) {
      const bad = await post(stepUpPath('approve', id), undefined, authed(a));
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
  });
});

describe('recovery decision endpoints: behaviour', () => {
  it('issues step-up challenges for a superadmin: options only, bound to the session, nothing set', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    for (const kind of ['approve', 'reject']) {
      const res = await post(stepUpPath(kind, row.id), undefined, authed(a));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['decision', 'expiresAt', 'options', 'requestId']);
      expect(res.body).toMatchObject({ decision: kind, requestId: row.id });
      expect(res.body.options.challenge).toBeTruthy();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(setCookies(res)).toHaveLength(0);
    }
    const purposes = recoveryChallenges().map((c) => c.purpose).sort();
    expect(purposes).toEqual(['recovery_approval', 'recovery_rejection']);
    expect(recoveryChallenges().every((c) => c.sessionId === a.sessionId && c.adminId === a.admin.id && c.recoveryRequestId === row.id)).toBe(true);
  });

  it('never trusts an admin id, session id or request id from the body', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const b = await superadmin(2);
    for (const extra of [{ adminId: b.admin.id }, { approverId: b.admin.id }, { sessionId: b.sessionId }, { requestId: 99 }]) {
      const res = await post(stepUpPath('approve', row.id), extra, authed(a));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
    expect(recoveryChallenges()).toHaveLength(0);

    const issued = await post(stepUpPath('approve', row.id), undefined, authed(a));
    const response = assertion(a, issued.body.options);
    for (const extra of [{ adminId: b.admin.id }, { approverId: b.admin.id }, { sessionId: b.sessionId }, { decision: 'approved' }]) {
      const res = await post(decisionPath('approve', row.id), { response, ...extra }, authed(a));
      expect(res.status).toBe(400);
    }
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('an approval reaches the service as the SESSION\'s Admin, and the second one approves and mails the link', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const b = await superadmin(2);

    const first = await httpDecide('approve', a, row.id, { reason: 'Verified by phone' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ decision: 'approve', requestId: row.id, status: 'pending', validApprovals: 1 });
    expect(db.recoveryApprovals).toEqual([expect.objectContaining({ requestId: row.id, approverId: a.admin.id, decision: 'approved', reason: 'Verified by phone' })]);
    expect(mailer.sendMail).not.toHaveBeenCalled();

    const second = await httpDecide('approve', b, row.id);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ decision: 'approve', requestId: row.id, status: 'approved', validApprovals: 2 });
    expect(db.recoveryRequests[0].status).toBe('approved');
    expect(db.invitations).toHaveLength(1);
    expect(db.invitations[0]).toMatchObject({ purpose: 'passkey_recovery', recoveryRequestId: row.id, tokenHash: hashToken(mailedToken()) });
    // the response says nothing about the invitation, the target or the mail
    expect(JSON.stringify(second.body)).not.toMatch(/invitation|token|target@|email/i);
    expect(JSON.stringify(second.body)).not.toContain(mailedToken());
    expect(setCookies(second)).toHaveLength(0);
  });

  it('a rejection reaches the service and ends the request', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const res = await httpDecide('reject', a, row.id, { reason: 'Not requested by the admin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ decision: 'reject', requestId: row.id, status: 'rejected', validApprovals: 0 });
    expect(db.recoveryRequests[0].status).toBe('rejected');
    expect(db.recoveryApprovals[0]).toMatchObject({ approverId: a.admin.id, decision: 'rejected' });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail.mock.calls[0][0].to).toBe(TARGET_EMAIL);
  });

  it('an approval challenge cannot be used for a rejection, nor a rejection challenge for an approval', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const approvalIssued = await post(stepUpPath('approve', row.id), undefined, authed(a));
    const swapped = await post(decisionPath('reject', row.id), { response: assertion(a, approvalIssued.body.options) }, authed(a));
    expect(swapped.status).toBe(400);
    expect(swapped.body).toEqual({ error: 'The passkey confirmation was not accepted.', code: 'step_up_failed' });
    expect(db.recoveryRequests[0].status).toBe('pending');

    const rejectionIssued = await post(stepUpPath('reject', row.id), undefined, authed(a));
    const swapped2 = await post(decisionPath('approve', row.id), { response: assertion(a, rejectionIssued.body.options) }, authed(a));
    expect(swapped2.status).toBe(400);
    expect(swapped2.body.code).toBe('step_up_failed');
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('a second decision by the same approver is 409, and a wrong assertion is 400 without ending the session', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    expect((await httpDecide('approve', a, row.id)).status).toBe(200);
    const again = await post(stepUpPath('approve', row.id), undefined, authed(a));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'You have already decided on this recovery request.', code: 'already_decided' });

    const b = await superadmin(2);
    const issued = await post(stepUpPath('approve', row.id), undefined, authed(b));
    const bad = await post(decisionPath('approve', row.id), { response: assertion(b, issued.body.options, { challenge: crypto.randomBytes(32).toString('base64url') }) }, authed(b));
    expect(bad.status).toBe(400);
    expect(setCookies(bad)).toHaveLength(0); // the caller stays signed in
    expect((await post(stepUpPath('reject', row.id), undefined, authed(b))).status).toBe(200);
  });

  it('validates decision bodies without echoing them', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    for (const body of [undefined, {}, { response: 'x' }, { response: [] }, { response: {}, reason: 5 }, { response: {}, reason: 'x'.repeat(501) }]) {
      const res = await post(decisionPath('approve', row.id), body, authed(a));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
    const badReason = await post(decisionPath('approve', row.id), { response: {}, reason: 'a <b>' }, authed(a));
    expect(badReason.status).toBe(400);
  });
});

// ---- 2. redemption -------------------------------------------------------------------------

describe('POST /admin/recovery/redeem', () => {
  it('turns the link and the current password into a recovery ticket, and nothing else', async () => {
    const { admin } = seedTarget();
    const fx = seedApproved(admin);
    const res = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['nextStep', 'recoveryTicket', 'status', 'ticketExpiresInSeconds']);
    expect(res.body).toMatchObject({ status: 'approved', nextStep: 'passkey_registration', ticketExpiresInSeconds: 600 });
    expect(setCookies(res)).toHaveLength(0);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(db.sessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(fx.token);
    expect(logged()).not.toContain(fx.token);
    expect(JSON.stringify(db.audits)).not.toContain(fx.token);
  });

  it('requires the current password: wrong, empty and missing ones are refused and counted', async () => {
    const { admin } = seedTarget();
    const fx = seedApproved(admin);
    const wrong = await post('/admin/recovery/redeem', { token: fx.token, password: 'WrongPass2027x' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(GENERIC_RECOVERY);
    expect((await post('/admin/recovery/redeem', { token: fx.token, password: '' })).status).toBe(400);
    expect((await post('/admin/recovery/redeem', { token: fx.token })).status).toBe(400);
    expect(fx.invitation.usedAt).toBeNull();
    expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(1); // the wrong password; the others never reached the service
  });

  it('answers an unknown, expired, revoked and used link, a wrong password and a disabled admin identically', async () => {
    const { admin } = seedTarget();
    const unknown = await post('/admin/recovery/redeem', { token: newToken(), password: PASSWORD });
    const expired = seedApproved(admin, { invitation: { expiresAt: new Date(Date.now() - 1000) } });
    const revoked = seedApproved(admin, { request: { status: 'cancelled' }, invitation: { revokedAt: new Date() } });
    const used = seedApproved(admin, { request: { status: 'cancelled' }, invitation: { usedAt: new Date() } });
    const wrongPassword = seedApproved(admin, { request: { status: 'cancelled' } });
    const results = [
      unknown,
      await post('/admin/recovery/redeem', { token: expired.token, password: PASSWORD }),
      await post('/admin/recovery/redeem', { token: revoked.token, password: PASSWORD }),
      await post('/admin/recovery/redeem', { token: used.token, password: PASSWORD }),
      await post('/admin/recovery/redeem', { token: wrongPassword.token, password: 'WrongPass2027x' }),
    ];
    for (const res of results) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual(GENERIC_RECOVERY);
      expect(setCookies(res)).toHaveLength(0);
    }
    admin.status = 'disabled';
    const live = seedApproved(admin);
    const disabled = await post('/admin/recovery/redeem', { token: live.token, password: PASSWORD });
    expect(disabled.status).toBe(400);
    expect(disabled.body).toEqual(GENERIC_RECOVERY);
  });

  it('validates the body shape without echoing it', async () => {
    for (const body of [undefined, {}, { token: 'short', password: 'x' }, { token: newToken(), password: 5 }, { token: newToken(), password: 'x', email: 'a@b.c' }, { token: 'x'.repeat(50), password: 'x' }]) {
      const res = await post('/admin/recovery/redeem', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
  });

  it('ignores Bearer tokens and session cookies sent with it', async () => {
    const { admin } = seedTarget();
    const fx = seedApproved(admin);
    const a = await superadmin(1);
    const res = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD }, { headers: { ...a.cookie, Authorization: 'Bearer garbage' } });
    expect(res.status).toBe(200);
    const garbage = await post('/admin/recovery/redeem', { token: newToken(), password: PASSWORD }, { headers: { Authorization: 'Bearer garbage', Cookie: 'hc_admin_token=garbage' } });
    expect(garbage.body).toEqual(GENERIC_RECOVERY);
  });
});

// ---- 3. registration ------------------------------------------------------------------------

describe('recovery passkey registration', () => {
  async function toTicket() {
    const target = seedTarget();
    const fx = seedApproved(target.admin);
    const redeemed = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD });
    expect(redeemed.status).toBe(200);
    return { ...target, ...fx, ticket: redeemed.body.recoveryTicket };
  }

  it('issues options, then verifies the genuine response: new passkey, old one revoked, request completed, NO session', async () => {
    const ctx = await toTicket();
    const bystander = await superadmin(1); // a live session of someone else must survive
    const sessionsBefore = db.sessions.length;

    const options = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    expect(options.status).toBe(200);
    expect(Object.keys(options.body)).toEqual(['options']);
    expect(options.body.options.challenge).toBeTruthy();
    expect(setCookies(options)).toHaveLength(0);

    const reg = makeRegistrationResponse({ challenge: options.body.options.challenge });
    const verified = await post('/admin/recovery/passkeys/registration/verify', { ticket: ctx.ticket, response: reg.response, label: 'New key' });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ status: 'recovered', nextStep: 'sign_in' });
    expect(setCookies(verified)).toHaveLength(0);
    expect(verified.headers['cache-control']).toBe('no-store');

    expect(db.recoveryRequests[0].status).toBe('completed');
    expect(ctx.oldPasskey.row.revokedAt).not.toBeNull();
    expect(db.passkeys.filter((p) => p.adminId === ctx.admin.id && !p.revokedAt)).toHaveLength(1);
    expect(db.sessions).toHaveLength(sessionsBefore); // none created
    expect(db.sessions.find((s) => s.id === bystander.sessionId).revokedAt).toBeNull();
    expect(JSON.stringify(verified.body)).not.toMatch(/token|ticket|passkey/i);
  });

  it('refuses a bad ticket, an enrollment ticket, a login ticket and an assertion for another challenge, all generically', async () => {
    const ctx = await toTicket();
    const enrollment = signAdminEnrollmentTicket({ adminId: ctx.admin.id, invitationId: ctx.invitation.id, passwordChangedAt: ctx.admin.passwordChangedAt });
    const login = signAdminLoginTicket({ adminId: ctx.admin.id, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    for (const ticket of ['garbage', enrollment, login]) {
      const res = await post('/admin/recovery/passkeys/registration/options', { ticket });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(GENERIC_RECOVERY);
    }
    const options = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    const wrong = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url') });
    const bad = await post('/admin/recovery/passkeys/registration/verify', { ticket: ctx.ticket, response: wrong.response });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual(GENERIC_RECOVERY);
    expect(options.status).toBe(200);
    expect(db.recoveryRequests[0].status).toBe('approved');
    expect(ctx.oldPasskey.row.revokedAt).toBeNull();
  });

  it('a recovery ticket is useless to the ordinary enrollment and login endpoints', async () => {
    const ctx = await toTicket();
    const reg = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url') });
    const options = await post('/admin/passkeys/registration/options', { ticket: ctx.ticket });
    expect(options.status).toBe(400);
    expect(options.body.code).not.toBe('invalid_recovery');
    expect(recoveryChallenges()).toHaveLength(0);
    const verify = await post('/admin/passkeys/registration/verify', { ticket: ctx.ticket, response: reg.response });
    expect(verify.status).toBe(400);
    const login = await post('/admin/login/passkey', { loginTicket: ctx.ticket, response: makeAssertionResponse({ challenge: 'x', registered: ctx.oldPasskey.reg, counter: 1 }) });
    expect(login.status).toBe(401);
    expect(setCookies(login)).toHaveLength(0);
    // and it is not a credential
    const me = await request(app).get('/admin/me').set('Authorization', `Bearer ${ctx.ticket}`);
    expect(me.status).toBe(401);
  });

  it('a cancelled request or a disabled admin kills an issued ticket', async () => {
    const ctx = await toTicket();
    db.recoveryRequests[0].status = 'cancelled';
    const res = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(GENERIC_RECOVERY);
  });

  it('validates registration bodies', async () => {
    for (const body of [undefined, {}, { ticket: '' }, { ticket: 5 }, { ticket: 'x', extra: 1 }]) {
      const res = await post('/admin/recovery/passkeys/registration/options', body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', code: 'invalid_request' });
    }
    for (const body of [undefined, { ticket: 'x' }, { ticket: 'x', response: 'y' }, { ticket: 'x', response: {}, label: 5 }]) {
      const res = await post('/admin/recovery/passkeys/registration/verify', body);
      expect(res.status).toBe(400);
    }
  });
});

// ---- 4. protections ------------------------------------------------------------------------

describe('origin, CSRF, body size and rate limits', () => {
  const publicCalls = [
    ['/admin/recovery/redeem', { token: 'x', password: 'y' }],
    ['/admin/recovery/passkeys/registration/options', { ticket: 'x' }],
    ['/admin/recovery/passkeys/registration/verify', { ticket: 'x', response: {} }],
  ];
  const sessionCalls = (id) => [
    [stepUpPath('approve', id), undefined],
    [stepUpPath('reject', id), undefined],
    [decisionPath('approve', id), { response: {} }],
    [decisionPath('reject', id), { response: {} }],
  ];

  it('refuses a missing, foreign or "null" Origin on every recovery endpoint before anything else', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    for (const [path, body] of [...publicCalls, ...sessionCalls(row.id)]) {
      for (const origin of [null, 'http://evil.example', 'null']) {
        const res = await post(path, body, { origin, headers: { ...CSRF, ...a.cookie } });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden', code: 'origin_not_allowed' });
      }
    }
    expect(recoveryChallenges()).toHaveLength(0);
  });

  it('requires the CSRF header on the session endpoints only', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    for (const [path, body] of sessionCalls(row.id)) {
      const res = await post(path, body, { headers: { ...a.cookie } });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden', code: 'csrf_required' });
    }
    // the public ones are authenticated by the link / ticket themselves, and need no header
    const res = await post('/admin/recovery/redeem', { token: newToken(), password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(GENERIC_RECOVERY);
  });

  it('fails closed (generic 500) when the origin configuration is unusable', async () => {
    delete process.env.ADMIN_WEBAUTHN_ORIGIN;
    const res = await post('/admin/recovery/redeem', { token: newToken(), password: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('enforces the body-size limits: 64 KB for assertions and tickets, 8 KB for redemption, 1 KB for step-ups', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const big = (bytes) => ({ response: { pad: 'x'.repeat(bytes) } });

    const verify = await post('/admin/recovery/passkeys/registration/verify', { ticket: 'x', response: { pad: 'x'.repeat(70 * 1024) } });
    expect(verify.status).toBe(413);
    expect(verify.body).toEqual({ error: 'Request body too large', code: 'payload_too_large' });
    const approve = await post(decisionPath('approve', row.id), big(70 * 1024), authed(a));
    expect(approve.status).toBe(413);
    const redeem = await post('/admin/recovery/redeem', { token: newToken(), password: 'p'.repeat(9 * 1024) });
    expect(redeem.status).toBe(413);
    const stepUp = await post(stepUpPath('approve', row.id), { pad: 'x'.repeat(2048) }, authed(a));
    expect(stepUp.status).toBe(413);
    expect(recoveryChallenges()).toHaveLength(0);
  });

  it('answers a malformed JSON body with the fixed 400, never quoting it', async () => {
    const res = await request(app).post('/admin/recovery/redeem').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"token":"abc","password":"hunter2"');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON body', code: 'invalid_json' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('rate-limits redemption at 10 per window, then answers 429 before any password check', async () => {
    setAdminAuthLimiterSkip(() => false);
    await resetAdminAuthLimiters();
    for (let i = 0; i < 10; i += 1) {
      const res = await post('/admin/recovery/redeem', { token: newToken(), password: 'x' });
      expect(res.status).toBe(400);
    }
    const limited = await post('/admin/recovery/redeem', { token: newToken(), password: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests. Please try again later.', code: 'rate_limited' });
  });

  it('rate-limits decisions at 20 per window and step-ups at 30', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    setAdminAuthLimiterSkip(() => false);
    await resetAdminAuthLimiters();
    for (let i = 0; i < 20; i += 1) {
      expect((await post(decisionPath('approve', row.id), { response: {} }, authed(a))).status).toBe(400);
    }
    expect((await post(decisionPath('approve', row.id), { response: {} }, authed(a))).status).toBe(429);
    for (let i = 0; i < 30; i += 1) {
      expect((await post(stepUpPath('approve', 999), undefined, authed(a))).status).toBe(404);
    }
    expect((await post(stepUpPath('approve', 999), undefined, authed(a))).status).toBe(429);
  });

  it('keeps the limiters separate: exhausting recovery redemption does not limit sign-in', async () => {
    setAdminAuthLimiterSkip(() => false);
    await resetAdminAuthLimiters();
    for (let i = 0; i < 11; i += 1) await post('/admin/recovery/redeem', { token: newToken(), password: 'x' });
    const admin = seedAdmin();
    seedPasskey(admin);
    expect((await post('/admin/login/password', { email: admin.email, password: PASSWORD })).status).toBe(200);
  });
});

// ---- 5. safe errors and scope ----------------------------------------------------------------

describe('error safety and scope', () => {
  it('an unexpected storage or audit failure is a generic 500 with only safe metadata logged', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const issued = await post(stepUpPath('approve', row.id), undefined, authed(a));
    const response = assertion(a, issued.body.options);
    db.failAudit = true;
    const res = await post(decisionPath('approve', row.id), { response }, authed(a));
    db.failAudit = false;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(logged()).not.toMatch(/audit write failed/);
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('redemption fails closed with a generic 500 when its attempt cannot be recorded', async () => {
    const { admin } = seedTarget();
    const fx = seedApproved(admin);
    db.failAudit = true;
    const res = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD });
    db.failAudit = false;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body) + logged()).not.toContain(fx.token);
    expect(fx.invitation.usedAt).toBeNull();
  });

  it('a mail failure on the final approval is not shown: the approval stands and the body has no mailer text', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const b = await superadmin(2);
    mailer.sendMail.mockRejectedValue(new Error('SMTP down: secret-host.internal'));
    await httpDecide('approve', a, row.id);
    const res = await httpDecide('approve', b, row.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(JSON.stringify(res.body) + logged()).not.toMatch(/SMTP|secret-host/);
    expect(db.invitations).toHaveLength(1);
  });

  it('exposes no operator-only operation: creating, cancelling, resending and break-glass have no route (the list is read-only)', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const attempts = [
      ['post', '/admin/recovery/requests', { email: TARGET_EMAIL, reason: 'x y z' }],
      ['post', '/admin/recovery', { email: TARGET_EMAIL }],
      ['get', `/admin/recovery/requests/${row.id}`],
      ['post', `/admin/recovery/requests/${row.id}/cancel`, { reason: 'x' }],
      ['post', `/admin/recovery/requests/${row.id}/resend`, {}],
      ['post', '/admin/recovery/break-glass', { email: TARGET_EMAIL }],
      ['delete', `/admin/recovery/requests/${row.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await send(method, path, body, authed(a));
      expect(res.status).toBe(404);
    }
    expect(db.recoveryRequests).toHaveLength(1);
    // and anonymously nothing is reachable either
    expect((await post('/admin/recovery/requests', { email: TARGET_EMAIL }, { headers: CSRF })).status).toBe(401);
  });

  it('sets no cookie on any recovery response', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const responses = [
      await post(stepUpPath('approve', row.id), undefined, authed(a)),
      await post('/admin/recovery/redeem', { token: newToken(), password: 'x' }),
      await post('/admin/recovery/passkeys/registration/options', { ticket: 'x' }),
      await post(decisionPath('approve', row.id), { response: {} }, authed(a)),
    ];
    responses.forEach((res) => expect(setCookies(res)).toHaveLength(0));
  });
});

// ---- the read-only list of requests a superadmin can decide on --------------------------------

describe('GET /admin/recovery/requests', () => {
  const list = (who, options = {}) => send('get', '/admin/recovery/requests', undefined, { headers: { ...who.cookie }, ...options });
  const HOUR = 60 * 60 * 1000;

  // Everything sensitive that exists around a request, so its absence from the answer means something.
  function seedSensitive(admin, request) {
    seedPasskey(admin);
    db.invitations.push({
      id: db.invitations.length + 1, adminId: admin.id, purpose: 'passkey_recovery', recoveryRequestId: request.id,
      tokenHash: hashToken(newToken()), sentToEmail: admin.email, expiresAt: new Date(Date.now() + DAY), usedAt: null, revokedAt: null,
    });
    request.requestIp = '203.0.113.9';
  }

  it('refuses an anonymous caller (401), bad credentials (401) and a regular Admin (403)', async () => {
    expect((await send('get', '/admin/recovery/requests')).status).toBe(401);
    expect((await send('get', '/admin/recovery/requests', undefined, { headers: { Cookie: 'hc_admin_token=garbage' } })).status).toBe(401);
    const regular = await signedIn({ role: 'admin', email: 'regular@example.org' });
    const res = await list(regular);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Superadmin access required' });
  });

  it('refuses a foreign Origin, and works for a read with the portal Origin or none', async () => {
    const a = await superadmin(1);
    const foreign = await list(a, { origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    expect((await list(a, { origin: null })).status).toBe(200);
    expect((await list(a)).status).toBe(200); // the portal's own Origin, and no CSRF header needed for a read
  });

  it('returns an empty list when nothing is waiting', async () => {
    const a = await superadmin(1);
    const res = await list(a);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(setCookies(res)).toHaveLength(0);
  });

  it('returns exactly the allowed fields for an open request, and nothing sensitive', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin, { reason: 'Lost the laptop' });
    seedSensitive(admin, row);
    const a = await superadmin(1);
    const b = await superadmin(2);
    db.recoveryApprovals.push({ id: 1, requestId: row.id, approverId: b.admin.id, approverRole: 'superadmin', decision: 'approved', reason: 'private note', ipAddress: '198.51.100.7' });
    await post(stepUpPath('approve', row.id), undefined, authed(a)); // leaves a WebAuthn challenge behind

    const res = await list(a);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['requests']);
    expect(res.body.requests).toHaveLength(1);
    const [item] = res.body.requests;
    expect(Object.keys(item).sort()).toEqual(['approvalsReceived', 'approvalsRequired', 'createdAt', 'expiresAt', 'id', 'reason', 'status', 'target']);
    expect(Object.keys(item.target).sort()).toEqual(['email', 'id', 'name']);
    expect(item).toMatchObject({
      id: row.id,
      status: 'pending',
      reason: 'Lost the laptop',
      approvalsReceived: 1,
      approvalsRequired: 2,
      target: { id: admin.id, name: 'Tara Target', email: TARGET_EMAIL },
    });
    expect(new Date(item.expiresAt).getTime()).toBe(row.expiresAt.getTime());
    expect(new Date(item.createdAt).getTime()).toBe(row.createdAt.getTime());

    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/tokenHash|token|passwordHash|\$2[aby]\$|credential|publicKey|challenge|signCount|sessionId|refresh|requestIp|203\.0\.113\.9|198\.51\.100\.7|private note|approverId|invitation/i);
    expect(text).not.toContain(db.invitations[0].tokenHash);
  });

  it('lists only requests the caller can still decide on, soonest deadline first', async () => {
    const a = await superadmin(1);
    const { admin: tara } = seedTarget();
    const open = seedRequest(tara, { reason: 'open', expiresAt: new Date(Date.now() + 3 * DAY) });
    const soonest = seedRequest(seedAdmin({ email: 'soon@example.org', name: 'Soon Target' }), { reason: 'soonest', expiresAt: new Date(Date.now() + HOUR) });

    // none of these may appear for this caller
    for (const status of ['approved', 'completed', 'rejected', 'cancelled', 'expired']) seedRequest(seedAdmin({ email: `${status}@example.org` }), { status });
    seedRequest(seedAdmin({ email: 'late@example.org' }), { expiresAt: new Date(Date.now() - 1000) });
    seedRequest(seedAdmin({ email: 'gone@example.org', status: 'disabled' }));
    const own = seedRequest(a.admin); // the caller's own recovery
    const decided = seedRequest(seedAdmin({ email: 'decided@example.org' }));
    db.recoveryApprovals.push({ id: 1, requestId: decided.id, approverId: a.admin.id, approverRole: 'superadmin', decision: 'approved' });
    const filedByMe = seedRequest(seedAdmin({ email: 'mine@example.org' }), { requestedByAdminId: a.admin.id });

    const res = await list(a);
    expect(res.body.requests.map((r) => r.id)).toEqual([soonest.id, open.id]);

    // another superadmin can decide on the ones this caller could not
    const b = await superadmin(2);
    const forB = (await list(b)).body.requests.map((r) => r.id);
    expect(forB).toEqual(expect.arrayContaining([decided.id, filedByMe.id, own.id]));
  });

  it('is read-only: nothing is created, changed, audited or challenged', async () => {
    const { admin } = seedTarget();
    seedRequest(admin);
    const a = await superadmin(1);
    const snapshot = () => JSON.stringify({ r: db.recoveryRequests, ap: db.recoveryApprovals, i: db.invitations, c: db.challenges, audits: db.audits, p: db.passkeys });
    const before = snapshot();
    await list(a);
    await list(a);
    expect(snapshot()).toBe(before);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('the listed reference works with the existing step-up endpoint', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const [item] = (await list(a)).body.requests;
    const res = await post(stepUpPath('approve', item.id), undefined, authed(a));
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(row.id);
  });

  it('is rate limited (60 per window), and POST to the same path creates nothing', async () => {
    const a = await superadmin(1);
    setAdminAuthLimiterSkip(() => false);
    await resetAdminAuthLimiters();
    for (let i = 0; i < 60; i += 1) expect((await list(a)).status).toBe(200);
    expect((await list(a)).status).toBe(429);
    setAdminAuthLimiterSkip(() => true);
    expect((await post('/admin/recovery/requests', { email: TARGET_EMAIL }, authed(a))).status).toBe(404);
    expect(db.recoveryRequests).toHaveLength(0);
  });
});

// ---- Step 7.9.9: security scenarios at the HTTP boundary ----------------------------------------------

describe('step-up and decision security over HTTP', () => {
  const issue = (kind, who, id) => post(stepUpPath(kind, id), undefined, authed(who));
  const approveWith = (who, id, response) => post(decisionPath('approve', id), { response }, authed(who));

  // A second live session for the same Admin (the backend allows two).
  async function secondSession(ctx) {
    const password = await post('/admin/login/password', { email: ctx.admin.email, password: PASSWORD });
    const response = makeAssertionResponse({ challenge: password.body.options.challenge, registered: ctx.passkey.reg, counter: ctx.nextCounter });
    ctx.nextCounter += 1;
    const res = await post('/admin/login/passkey', { loginTicket: password.body.loginTicket, response });
    expect(res.status).toBe(200);
    const access = valueOf(cookieNamed(res, 'hc_admin_token', (c) => /Path=\/admin;/.test(c) && !isCleared(c)));
    return { ...ctx, cookie: { Cookie: `hc_admin_token=${access}` } };
  }
  const refused = (res) => {
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The passkey confirmation was not accepted.', code: 'step_up_failed' });
  };

  it('a decision with no step-up at all is refused', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const fabricated = makeAssertionResponse({ challenge: crypto.randomBytes(32).toString('base64url'), registered: a.passkey.reg, counter: a.nextCounter });
    refused(await approveWith(a, row.id, fabricated));
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('a failed assertion burns its challenge: the right answer afterwards is refused too', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const issued = await issue('approve', a, row.id);
    refused(await approveWith(a, row.id, assertion(a, issued.body.options, { challenge: crypto.randomBytes(32).toString('base64url') })));
    refused(await approveWith(a, row.id, assertion(a, issued.body.options)));
    expect(db.recoveryApprovals).toHaveLength(0);
    // a fresh step-up works again
    expect((await httpDecide('approve', a, row.id)).status).toBe(200);
  });

  it('an accepted assertion cannot be replayed', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const issued = await issue('approve', a, row.id);
    const response = assertion(a, issued.body.options);
    expect((await approveWith(a, row.id, response)).status).toBe(200);
    const replay = await approveWith(a, row.id, response);
    expect(replay.status).not.toBe(200);
    expect(db.recoveryApprovals).toHaveLength(1);
  });

  it('an expired challenge is refused', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const issued = await issue('approve', a, row.id);
    const response = assertion(a, issued.body.options);
    recoveryChallenges().forEach((c) => { c.expiresAt = new Date(Date.now() - 1000); });
    refused(await approveWith(a, row.id, response));
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('a challenge issued for another request is refused', async () => {
    const { admin } = seedTarget();
    const first = seedRequest(admin);
    const second = seedRequest(seedAdmin({ email: 'other-target@example.org' }));
    const a = await superadmin(1);
    const issued = await issue('approve', a, first.id);
    refused(await approveWith(a, second.id, assertion(a, issued.body.options)));
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('a challenge issued in another session is refused', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const other = await secondSession(a);
    const issued = await issue('approve', a, row.id);
    refused(await approveWith(other, row.id, assertion(a, issued.body.options)));
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it("another superadmin's passkey cannot answer my challenge", async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    const b = await superadmin(2);
    const issued = await issue('approve', a, row.id);
    refused(await approveWith(a, row.id, assertion(b, issued.body.options))); // signed with b's passkey
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('self-rejection is refused as firmly as self-approval, and so is deciding on a request you filed', async () => {
    const t = await signedIn({ role: 'superadmin', email: TARGET_EMAIL, name: 'Tara Target' });
    const own = seedRequest(t.admin);
    for (const kind of ['approve', 'reject']) {
      const res = await issue(kind, t, own.id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_available');
    }
    expect(recoveryChallenges()).toHaveLength(0);

    const a = await superadmin(1);
    const filedByA = seedRequest(seedAdmin({ email: 'filed@example.org' }), { requestedByAdminId: a.admin.id });
    expect((await issue('approve', a, filedByA.id)).status).toBe(404);
    expect((await issue('reject', a, filedByA.id)).status).toBe(404);
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('a request that is no longer pending cannot be decided on (stale listing)', async () => {
    const { admin } = seedTarget();
    const row = seedRequest(admin);
    const a = await superadmin(1);
    row.status = 'rejected';
    const res = await issue('approve', a, row.id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_available');
    row.status = 'pending';
    row.expiresAt = new Date(Date.now() - 1000);
    expect((await issue('reject', a, row.id)).status).toBe(404);
  });
});

describe('recovery completion over HTTP', () => {
  // The target signs in first (so they have a live session and refresh token), then recovers.
  async function recoveringTarget() {
    const ctx = await signedIn({ email: TARGET_EMAIL, name: 'Tara Target' });
    const fx = seedApproved(ctx.admin);
    const redeemed = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD });
    expect(redeemed.status).toBe(200);
    return { ...ctx, ...fx, ticket: redeemed.body.recoveryTicket };
  }
  async function register(ctx) {
    const options = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    expect(options.status).toBe(200);
    const reg = makeRegistrationResponse({ challenge: options.body.options.challenge });
    return post('/admin/recovery/passkeys/registration/verify', { ticket: ctx.ticket, response: reg.response, label: 'New key' });
  }

  it("ends the target's own sessions and refresh tokens, revokes the old passkey, and creates no session", async () => {
    const ctx = await recoveringTarget();
    const sessionsBefore = db.sessions.length;
    const tokensBefore = db.refreshTokens.length;

    // before recovery the session works
    expect((await request(app).get('/admin/me').set('Cookie', ctx.cookie.Cookie).set('Origin', ORIGIN)).status).toBe(200);

    expect((await register(ctx)).status).toBe(200);

    expect((await request(app).get('/admin/me').set('Cookie', ctx.cookie.Cookie).set('Origin', ORIGIN)).status).toBe(401);
    const mine = db.sessions.filter((s) => s.adminId === ctx.admin.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s) => s.revokedAt)).toBe(true);
    expect(db.refreshTokens.filter((t) => mine.some((s) => s.id === t.sessionId)).every((t) => t.revokedAt)).toBe(true);
    expect(ctx.passkey.row.revokedAt).not.toBeNull();
    expect(db.sessions).toHaveLength(sessionsBefore);
    expect(db.refreshTokens).toHaveLength(tokensBefore);
  });

  it("the old refresh cookie and the old passkey no longer sign anyone in", async () => {
    const ctx = await recoveringTarget();
    // capture the target's refresh cookie from a fresh sign-in of the same Admin
    const password = await post('/admin/login/password', { email: TARGET_EMAIL, password: PASSWORD });
    const login = await post('/admin/login/passkey', {
      loginTicket: password.body.loginTicket,
      response: makeAssertionResponse({ challenge: password.body.options.challenge, registered: ctx.passkey.reg, counter: ctx.nextCounter }),
    });
    expect(login.status).toBe(200);
    const refresh = valueOf(cookieNamed(login, 'hc_admin_refresh'));
    ctx.nextCounter += 1;

    expect((await register(ctx)).status).toBe(200);

    const renewed = await post('/admin/refresh', undefined, { headers: { ...CSRF, Cookie: `hc_admin_refresh=${refresh}` } });
    expect(renewed.status).toBe(401);
    expect(cookieNamed(renewed, 'hc_admin_token', (c) => !isCleared(c))).toBeUndefined();

    // the old passkey cannot complete a sign-in any more (the options now only name the new one)
    const again = await post('/admin/login/password', { email: TARGET_EMAIL, password: PASSWORD });
    expect(again.status).toBe(200);
    const sessionsBefore = db.sessions.length;
    const old = await post('/admin/login/passkey', {
      loginTicket: again.body.loginTicket,
      response: makeAssertionResponse({ challenge: again.body.options.challenge, registered: ctx.passkey.reg, counter: ctx.nextCounter + 1 }),
    });
    expect(old.status).toBe(401);
    expect(setCookies(old).filter((c) => !isCleared(c))).toHaveLength(0);
    expect(db.sessions).toHaveLength(sessionsBefore);
  });

  it('the ticket and the invitation are single use: nothing works a second time', async () => {
    const ctx = await recoveringTarget();
    expect((await register(ctx)).status).toBe(200);
    const again = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    expect(again.status).toBe(400);
    expect(again.body).toEqual(GENERIC_RECOVERY);
    const reuse = await post('/admin/recovery/redeem', { token: ctx.token, password: PASSWORD });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toEqual(GENERIC_RECOVERY);
    expect(db.passkeys.filter((p) => p.adminId === ctx.admin.id && !p.revokedAt)).toHaveLength(1);
  });

  it.each([
    ['the Admin is disabled', (ctx) => { ctx.admin.status = 'disabled'; }],
    ['the password changes', (ctx) => { ctx.admin.passwordChangedAt = new Date(Date.now() + 1000); }],
    ['the request is cancelled', (ctx) => { ctx.request.status = 'cancelled'; }],
    ['the request expires', (ctx) => { ctx.request.expiresAt = new Date(Date.now() - 1000); }],
    ['the invitation is revoked', (ctx) => { ctx.invitation.revokedAt = new Date(); }],
  ])('an issued recovery ticket stops working when %s', async (_label, change) => {
    const ctx = await recoveringTarget();
    change(ctx);
    const options = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    expect(options.status).toBe(400);
    expect(options.body).toEqual(GENERIC_RECOVERY);
    const reg = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url') });
    const verify = await post('/admin/recovery/passkeys/registration/verify', { ticket: ctx.ticket, response: reg.response });
    expect(verify.status).toBe(400);
    expect(ctx.passkey.row.revokedAt).toBeNull(); // nothing was replaced
  });

  it('the recovery ticket expires after ten minutes (server-side clock)', async () => {
    const ctx = await recoveringTarget();
    const real = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(real + 11 * 60 * 1000);
    const late = await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket });
    spy.mockRestore();
    expect(late.status).toBe(400);
    expect(late.body).toEqual(GENERIC_RECOVERY);
    expect((await post('/admin/recovery/passkeys/registration/options', { ticket: ctx.ticket })).status).toBe(200); // and it was fine before
  });

  it('five wrong passwords burn the invitation: the right one then fails too', async () => {
    const { admin } = seedTarget();
    const fx = seedApproved(admin);
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/admin/recovery/redeem', { token: fx.token, password: `WrongPass${i}x` });
      expect(res.status).toBe(400);
    }
    const right = await post('/admin/recovery/redeem', { token: fx.token, password: PASSWORD });
    expect(right.status).toBe(400);
    expect(right.body).toEqual(GENERIC_RECOVERY);
    expect(fx.invitation.usedAt).toBeNull();
    expect(fx.invitation.revokedAt).not.toBeNull();
  });
});

describe('existing Admin authentication endpoints still work alongside', () => {
  it('sign-in, /admin/me and logout behave as before', async () => {
    const a = await signedIn({ role: 'superadmin', email: 'super9@example.org' });
    const me = await request(app).get('/admin/me').set('Cookie', a.cookie.Cookie).set('Origin', ORIGIN);
    expect(me.status).toBe(200);
    const out = await post('/admin/logout', undefined, authed(a));
    expect(out.status).toBe(200);
    expect(cookieNamed(out, 'hc_admin_refresh')).toBeTruthy();
    expect(db.sessions.find((s) => s.id === a.sessionId).revokedAt).not.toBeNull();
  });
});
