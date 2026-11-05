// Operator command "begin-enrollment": moves an EXISTING active Admin/Superadmin that has a password
// and no passkey to "pending_passkey" and issues a passkey-enrollment invitation. No database:
// Prisma is the in-memory stand-in from admin-lock-fake-db.js; mail never leaves the process.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fake = require('./admin-lock-fake-db');
const mailer = require('../src/lib/mailer');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const { beginPasskeyEnrollment, resendPasskeyEnrollmentInvitation } = require('../src/modules/admin/auth/admin-invitation-operator.service');
const { redeemAdminPasskeyEnrollmentInvitation } = require('../src/modules/admin/auth/admin-invitation.service');
const { generateAdminPasskeyRegistrationOptions, verifyAdminPasskeyRegistration } = require('../src/modules/admin/auth/admin-webauthn-registration.service');
const { parseArgs } = require('../scripts/admin-invitation');
const jwt = require('jsonwebtoken');
const { loginAdmin } = require('../src/modules/admin/admin.service');
const { requireAdminAuth } = require('../src/modules/admin/auth/admin-session.middleware');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { signAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { disableAdminAccount, enableAdminAccount } = require('../src/modules/admin/auth/admin-account.service');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const HOUR = 3600 * 1000;
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const PASSWORD = 'CurrentPass2027x';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const PORTAL = 'https://admin.example.org';
const EMAIL = 'root@example.org';
const ENV_KEYS = ['ADMIN_PASSKEY_ENFORCEMENT', 'JWT_REFRESH_SECRET', 'ADMIN_PORTAL_URL', 'JWT_ACCESS_SECRET', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME', 'NODE_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A legacy account as seed-admin.js creates it: active, password hash, no timestamps.
function seedAdmin(overrides = {}) {
  const admin = {
    id: db.admins.length + 1,
    name: 'Root Admin',
    email: EMAIL,
    role: 'superadmin',
    status: 'active',
    passwordHash: PASSWORD_HASH,
    passwordChangedAt: null,
    emailVerifiedAt: null,
    failedLoginCount: 0,
    updatedAt: null,
    ...overrides,
  };
  db.admins.push(admin);
  return admin;
}

function seedSession(admin, overrides = {}) {
  const session = { id: db.sessions.length + 1, adminId: admin.id, revokedAt: null, revokedReason: null, ...overrides };
  db.sessions.push(session);
  const token = { id: db.refreshTokens.length + 1, sessionId: session.id, revokedAt: null, usedAt: null };
  db.refreshTokens.push(token);
  return { session, token };
}

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  process.env.ADMIN_PORTAL_URL = PORTAL;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-begin-enrollment';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-begin-enrollment';
  delete process.env.ADMIN_PASSKEY_ENFORCEMENT; // legacy login is open unless the Admin's status or passkey stops it
  process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
  process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const begin = (overrides = {}) => beginPasskeyEnrollment({ email: EMAIL, now: NOW, ...overrides });
const sentToken = () => mailer.sendMail.mock.calls.at(-1)[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];

describe('beginPasskeyEnrollment', () => {
  it('moves an active, passkey-less Superadmin to pending_passkey and issues one invitation', async () => {
    const admin = seedAdmin();
    const result = await begin({ email: ` ${EMAIL.toUpperCase()} ` });
    expect(admin.status).toBe('pending_passkey');
    expect(result).toMatchObject({
      admin: { id: admin.id, email: EMAIL, role: 'superadmin', status: 'pending_passkey' },
      passwordChangedAtInitialized: true,
      emailDelivered: true,
      emailError: null,
    });
    expect(db.invitations).toHaveLength(1);
    expect(db.invitations[0]).toMatchObject({ adminId: admin.id, purpose: 'passkey_enrollment', sentToEmail: EMAIL, usedAt: null, revokedAt: null });
    expect(db.invitations[0].expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    expect(db.admins).toHaveLength(1); // no second account
  });

  it('keeps id, name, email, role and the exact password hash; initialises passwordChangedAt only when NULL', async () => {
    const admin = seedAdmin();
    const before = { ...admin };
    await begin();
    expect({ ...admin, status: null, passwordChangedAt: null, updatedAt: null }).toEqual({ ...before, status: null, passwordChangedAt: null, updatedAt: null });
    expect(admin.passwordHash).toBe(PASSWORD_HASH);
    expect(admin.passwordChangedAt).toEqual(NOW);
  });

  it('never overwrites an existing passwordChangedAt', async () => {
    const existing = new Date('2027-01-01T00:00:00.000Z');
    const admin = seedAdmin({ passwordChangedAt: existing });
    const result = await begin();
    expect(admin.passwordChangedAt).toBe(existing);
    expect(result.passwordChangedAtInitialized).toBe(false);
  });

  it('also works for a regular Admin', async () => {
    const admin = seedAdmin({ role: 'admin' });
    await begin();
    expect(admin).toMatchObject({ role: 'admin', status: 'pending_passkey' });
  });

  it('refuses an Admin who has a live passkey, and changes nothing', async () => {
    const admin = seedAdmin();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialIdHash: 'a'.repeat(64), revokedAt: null });
    await expect(begin()).rejects.toMatchObject({ name: 'InvitationOperatorError', code: 'has_passkey' });
    expect(admin.status).toBe('active');
    expect(admin.passwordChangedAt).toBeNull();
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('is not blocked by revoked passkeys or another Admin\'s passkeys', async () => {
    const admin = seedAdmin();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialIdHash: 'a'.repeat(64), revokedAt: NOW });
    db.passkeys.push({ id: 2, adminId: admin.id + 1, credentialIdHash: 'b'.repeat(64), revokedAt: null });
    await expect(begin()).resolves.toMatchObject({ emailDelivered: true });
  });

  it.each([
    ['unknown email', null, 'admin_not_found'],
    ['an invited Admin', { status: 'invited', passwordHash: null }, 'not_active'],
    ['a disabled Admin', { status: 'disabled' }, 'not_active'],
    ['an already pending Admin', { status: 'pending_passkey' }, 'not_active'],
    ['an unknown status', { status: 'suspended' }, 'not_active'],
  ])('refuses %s', async (_name, overrides, code) => {
    const admin = overrides ? seedAdmin(overrides) : null;
    await expect(begin()).rejects.toMatchObject({ name: 'InvitationOperatorError', code });
    if (admin) expect(admin.status).toBe(overrides.status);
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it.each([[null], ['']])('refuses an active Admin with no password hash (%p)', async (hash) => {
    const admin = seedAdmin({ passwordHash: hash });
    await expect(begin()).rejects.toMatchObject({ code: 'no_password' });
    expect(admin.status).toBe('active');
    expect(admin.passwordChangedAt).toBeNull();
    expect(db.invitations).toHaveLength(0);
  });

  it('refuses while a passkey-recovery request is open', async () => {
    const admin = seedAdmin();
    db.recoveryRequests.push({ id: 1, adminId: admin.id, status: 'pending' });
    await expect(begin()).rejects.toMatchObject({ code: 'recovery_open' });
    expect(admin.status).toBe('active');
    expect(db.invitations).toHaveLength(0);
  });

  it('revokes every live session and refresh token of the Admin, and only that Admin', async () => {
    const admin = seedAdmin();
    const other = seedAdmin({ email: 'other@example.org', role: 'admin' });
    const live = seedSession(admin);
    const live2 = seedSession(admin);
    const alreadyRevoked = seedSession(admin, { revokedAt: new Date(NOW.getTime() - HOUR), revokedReason: 'logout' });
    const othersSession = seedSession(other);
    const result = await begin();
    for (const s of [live, live2]) {
      expect(s.session).toMatchObject({ revokedAt: NOW, revokedReason: 'passkey_enrollment_required' });
      expect(s.token.revokedAt).toEqual(NOW);
    }
    expect(alreadyRevoked.session.revokedReason).toBe('logout'); // untouched
    expect(alreadyRevoked.token.revokedAt).toEqual(NOW); // a leftover token on it is still ended
    expect(othersSession.session.revokedAt).toBeNull();
    expect(othersSession.token.revokedAt).toBeNull();
    expect(result).toMatchObject({ revokedSessions: 2, revokedRefreshTokens: 3 });
  });

  it('revokes earlier open enrollment invitations so exactly one stays open', async () => {
    const admin = seedAdmin();
    db.invitations.push({ id: 1, adminId: admin.id, purpose: 'passkey_enrollment', tokenHash: 'x'.repeat(64), sentToEmail: EMAIL, expiresAt: later(3600), usedAt: null, revokedAt: null });
    await begin();
    expect(db.invitations.filter((i) => !i.revokedAt && !i.usedAt)).toHaveLength(1);
    expect(db.invitations[0].revokedAt).toEqual(NOW);
  });

  it('uses a fresh 32-byte token, stores only its SHA-256, and never prints or audits it', async () => {
    seedAdmin();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    await begin();
    expect(randomBytes).toHaveBeenCalledWith(32);
    const token = sentToken();
    expect(db.invitations[0].tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db)).not.toContain(token);
    expect(JSON.stringify([log.mock.calls, err.mock.calls])).not.toContain(token);
    expect(mailer.sendMail.mock.calls[0][0].sensitive).toBe(true);
  });

  it('records one operator audit event with ids and counts only', async () => {
    const admin = seedAdmin();
    seedSession(admin);
    await begin();
    const events = db.audits.filter((a) => a.event === 'admin_passkey_enrollment_begun');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'operator',
      identifier: EMAIL,
      detail: {
        adminId: admin.id,
        previousStatus: 'active',
        newStatus: 'pending_passkey',
        timestampInitialized: true,
        revokedSessionCount: 1,
        revokedRefreshCount: 1,
      },
    });
    expect(JSON.stringify(db.audits)).not.toContain(PASSWORD_HASH);
  });

  it('commits state before sending, and a mail failure does not corrupt or roll it back', async () => {
    const admin = seedAdmin();
    mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); throw new Error('smtp down'); });
    const result = await begin();
    expect(db.events.indexOf('commit')).toBeLessThan(db.events.indexOf('email'));
    expect(result).toMatchObject({ emailDelivered: false, emailError: 'smtp down' });
    expect(admin.status).toBe('pending_passkey');
    expect(admin.passwordHash).toBe(PASSWORD_HASH);
    expect(db.invitations).toHaveLength(1);
    expect(db.audits.map((a) => a.event)).toEqual(expect.arrayContaining(['admin_passkey_enrollment_begun', 'admin_passkey_enrollment_invitation_delivery_failed']));
    // The documented recovery from a failed email works.
    mailer.sendMail.mockReset().mockImplementation(async () => {});
    await expect(resendPasskeyEnrollmentInvitation({ email: EMAIL, now: later(60) })).resolves.toMatchObject({ emailDelivered: true });
    expect(db.invitations.filter((i) => !i.revokedAt)).toHaveLength(1);
  });

  it('rolls everything back if the audit write fails, and sends nothing', async () => {
    const admin = seedAdmin();
    const session = seedSession(admin);
    db.failAudit = true;
    await expect(begin()).rejects.toThrow('audit write failed');
    expect(admin).toMatchObject({ status: 'active', passwordChangedAt: null });
    expect(session.session.revokedAt).toBeNull();
    expect(session.token.revokedAt).toBeNull();
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('refuses before changing anything when ADMIN_PORTAL_URL is missing', async () => {
    const admin = seedAdmin();
    delete process.env.ADMIN_PORTAL_URL;
    await expect(begin()).rejects.toThrow('ADMIN_PORTAL_URL');
    expect(admin.status).toBe('active');
    expect(db.invitations).toHaveLength(0);
  });

  it('handles a duplicate run safely: the second is refused and only one invitation exists', async () => {
    const admin = seedAdmin();
    await begin();
    await expect(begin()).rejects.toMatchObject({ code: 'not_active' });
    expect(db.invitations).toHaveLength(1);
    expect(admin.status).toBe('pending_passkey');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  it('handles concurrent runs safely: exactly one wins, one invitation, one email', async () => {
    const admin = seedAdmin();
    const results = await Promise.allSettled([begin(), begin(), begin()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason).toMatchObject({ code: 'not_active' });
    expect(db.invitations).toHaveLength(1);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(admin.status).toBe('pending_passkey');
    expect(db.audits.filter((a) => a.event === 'admin_passkey_enrollment_begun')).toHaveLength(1);
  });

  it('decides from the row as it is under the lock: an Admin disabled after the id lookup is refused', async () => {
    const admin = seedAdmin();
    db.afterRead = async (table) => { if (table === 'admins') { admin.status = 'disabled'; db.afterRead = null; } };
    await expect(begin()).rejects.toMatchObject({ code: 'not_active', message: 'Only an active admin can begin passkey enrollment.' });
    expect(admin.status).toBe('disabled');
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('keeps the password the Admin has under the lock: a change after the id lookup is neither lost nor overwritten', async () => {
    const admin = seedAdmin();
    const changedHash = bcrypt.hashSync('Another2027x', 4);
    db.afterRead = async (table) => { if (table === 'admins') { admin.passwordHash = changedHash; db.afterRead = null; } };
    await begin();
    expect(admin.passwordHash).toBe(changedHash);
    expect(admin.status).toBe('pending_passkey');
  });

  it('names an already-pending Admin accurately, pointing to resend-enrollment', async () => {
    seedAdmin({ status: 'pending_passkey' });
    await expect(begin()).rejects.toMatchObject({ code: 'not_active', message: expect.stringContaining('resend-enrollment') });
  });

  it('locks the Admin row FIRST: the first statement in the transaction is the conditional update, before any read', async () => {
    seedAdmin();
    const calls = [];
    const root = fake.prisma;
    const original = root.$transaction;
    jest.spyOn(root, '$transaction').mockImplementation((fn) => original.call(root, (tx) => fn(new Proxy(tx, {
      get(target, model) {
        const delegate = target[model];
        if (!delegate || typeof delegate !== 'object') return delegate;
        return new Proxy(delegate, {
          get(d, op) {
            const member = d[op];
            return typeof member === 'function' ? (...args) => { calls.push(`${model}.${op}`); return member.apply(d, args); } : member;
          },
        });
      },
    }))));
    await begin();
    expect(calls[0]).toBe('adminUser.updateMany');
    const firstRead = calls.findIndex((c) => /\.(findUnique|findMany|findFirst|count)$/.test(c));
    expect(firstRead).toBeGreaterThan(0);
    // The precondition reads (passkeys, recovery requests) all come after the lock.
    expect(calls.indexOf('adminPasskey.count')).toBeGreaterThan(0);
    expect(calls.indexOf('adminRecoveryRequest.count')).toBeGreaterThan(0);
  });
});

describe('after begin-enrollment the legacy password-only access is closed', () => {
  const legacyToken = (admin) => jwt.sign({ sub: admin.id, role: 'admin', adminRole: admin.role }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  const run = async (token) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const next = jest.fn();
    await requireAdminAuth(['admin'])(req, res, next);
    return { req, res, next };
  };

  it('loginAdmin rejects the correct password once the Admin is pending_passkey, while it worked before', async () => {
    const admin = seedAdmin();
    await expect(loginAdmin(EMAIL, PASSWORD)).resolves.toMatchObject({ admin: { id: admin.id, role: 'superadmin' } }); // the hole being closed
    await begin();
    await expect(loginAdmin(EMAIL, PASSWORD)).resolves.toBeNull();
  });

  it('a legacy Admin access token issued before is refused by the Admin middleware afterwards', async () => {
    const admin = seedAdmin();
    const { token } = await loginAdmin(EMAIL, PASSWORD);
    const before = await run(token);
    expect(before.next).toHaveBeenCalledWith();
    expect(before.req.user).toMatchObject({ id: admin.id, adminRole: 'superadmin' });

    await begin();
    const after = await run(token);
    expect(after.res.statusCode).toBe(401);
    expect(after.next).not.toHaveBeenCalled();
  });

  it('stays refused with enforcement on or off, and until a passkey is registered', async () => {
    const admin = seedAdmin();
    const { token } = await loginAdmin(EMAIL, PASSWORD);
    await begin();
    expect((await run(token)).res.statusCode).toBe(401);
    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    expect((await run(token)).res.statusCode).toBe(401);
    expect(admin.status).toBe('pending_passkey');
  });

  it('does not affect another active Admin: their permitted legacy token and their database session token still work', async () => {
    seedAdmin();
    const other = seedAdmin({ email: 'other@example.org', role: 'admin' });
    const withPasskey = seedAdmin({ email: 'keyed@example.org', role: 'admin' });
    db.passkeys.push({ id: 1, adminId: withPasskey.id, credentialIdHash: 'c'.repeat(64), revokedAt: null });
    const created = await fake.prisma.$transaction((tx) => createAdminSession(tx, { admin: withPasskey, now: new Date() }));
    const sessionToken = signAdminAccessToken({ adminId: withPasskey.id, role: withPasskey.role, sessionId: created.sessionId });

    await begin(); // converts only the first Admin

    const viaLegacy = await run(legacyToken(other));
    expect(viaLegacy.next).toHaveBeenCalledWith();
    expect(viaLegacy.req.user).toMatchObject({ id: other.id });
    const viaSession = await run(sessionToken);
    expect(viaSession.next).toHaveBeenCalledWith();
    expect(viaSession.req.user).toMatchObject({ id: withPasskey.id, sessionId: created.sessionId });
    await expect(loginAdmin('other@example.org', PASSWORD)).resolves.not.toBeNull();
    expect(other.status).toBe('active');
    expect(withPasskey.status).toBe('active');
  });
});

describe('disable and re-enable of an Admin converted by begin-enrollment', () => {
  it('returns to pending_passkey, never active, and the password-only door stays shut', async () => {
    const admin = seedAdmin();
    await begin();
    const hashBefore = admin.passwordHash;

    await disableAdminAccount({ email: EMAIL, reason: 'Paused during enrollment', now: later(120) });
    expect(admin.status).toBe('disabled');
    const result = await enableAdminAccount({ email: EMAIL, now: later(180) });

    expect(result).toMatchObject({ admin: { id: admin.id, email: EMAIL, status: 'pending_passkey' }, previousStatus: 'disabled', statusSource: 'audit_trail' });
    expect(admin.status).toBe('pending_passkey');
    expect(admin.status).not.toBe('active');
    expect(admin.passwordHash).toBe(hashBefore);
    expect(admin.role).toBe('superadmin');
    await expect(loginAdmin(EMAIL, PASSWORD)).resolves.toBeNull();
  });

  it('after re-enable, a fresh resend-enrollment link still works (the Admin can finish enrolling)', async () => {
    seedAdmin();
    await begin();
    await disableAdminAccount({ email: EMAIL, reason: 'Paused during enrollment', now: later(120) });
    await enableAdminAccount({ email: EMAIL, now: later(180) });
    await expect(resendPasskeyEnrollmentInvitation({ email: EMAIL, now: later(240) })).resolves.toMatchObject({ emailDelivered: true });
    const { enrollmentTicket } = await redeemAdminPasskeyEnrollmentInvitation({ token: sentToken(), password: PASSWORD, now: later(300) });
    expect(enrollmentTicket).toEqual(expect.any(String));
  });
});

describe('redemption after begin-enrollment', () => {
  const redeem = (password, seconds = 60) => redeemAdminPasskeyEnrollmentInvitation({ token: sentToken(), password, now: later(seconds) });

  it('still requires the existing password', async () => {
    const admin = seedAdmin();
    await begin();
    await expect(redeem('WrongPassword2027x')).rejects.toMatchObject({ code: 'invalid_invitation' });
    expect(db.invitations[0].usedAt).toBeNull();
    expect(admin.status).toBe('pending_passkey');
    await expect(redeem(PASSWORD)).resolves.toMatchObject({ status: 'pending_passkey', nextStep: 'passkey_enrollment' });
  });

  it('gives no dashboard access before a passkey exists: only a verified registration makes the Admin active, password intact', async () => {
    const admin = seedAdmin();
    await begin();
    const { enrollmentTicket } = await redeem(PASSWORD);
    expect(admin.status).toBe('pending_passkey'); // the password alone activated nothing
    expect(db.sessions).toHaveLength(0);
    const opts = await generateAdminPasskeyRegistrationOptions({ ticket: enrollmentTicket, now: later(65) });
    const { response } = makeRegistrationResponse({ challenge: opts.challenge });
    await expect(verifyAdminPasskeyRegistration({ ticket: enrollmentTicket, response, now: later(70) })).resolves.toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(admin).toMatchObject({ status: 'active', role: 'superadmin', passwordHash: PASSWORD_HASH });
    expect(db.passkeys).toHaveLength(1);
    expect(db.sessions).toHaveLength(0); // sign-in is a separate, two-factor step
  });
});

describe('CLI arguments', () => {
  it('accepts begin-enrollment with --email and rejects unknown options', () => {
    expect(parseArgs(['begin-enrollment', '--email', ' Root@Example.org '])).toEqual({ command: 'begin-enrollment', email: 'root@example.org' });
    expect(() => parseArgs(['begin-enrollment', '--password', 'x'])).toThrow('Unknown argument');
    expect(() => parseArgs(['begin-enrollment'])).toThrow('--email is required');
  });
});
