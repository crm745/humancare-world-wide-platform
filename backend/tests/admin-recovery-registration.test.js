// Redeeming an approved recovery invitation and replacing the lost passkey (Step 7.9.5): the
// invitation + password -> recovery ticket, the registration options, and the verification that
// stores the new passkey and revokes the old one in one transaction. Service layer only. No
// database: Prisma is the in-memory stand-in from admin-lock-fake-db.js; the REAL
// @simplewebauthn/server verifies genuine registrations built by the software authenticator.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { makeRegistrationResponse, makeAssertionResponse, FLAG } = require('./admin-webauthn-test-authenticator');
const { hashToken } = require('../src/common/utils/token-hash');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { issueAdminWebAuthnChallenge } = require('../src/modules/admin/auth/admin-webauthn-challenge.service');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminLoginTicket, ADMIN_LOGIN_FLOWS } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { signAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { signAdminRecoveryTicket, readAdminRecoveryTicket } = require('../src/modules/admin/auth/admin-recovery-ticket.service');
const { redeemAdminPasskeyEnrollmentInvitation, InvitationError } = require('../src/modules/admin/auth/admin-invitation.service');
const { generateAdminPasskeyRegistrationOptions, verifyAdminPasskeyRegistration, PasskeyRegistrationError } = require('../src/modules/admin/auth/admin-webauthn-registration.service');
const { AdminLoginError, completeAdminPasskeyLogin } = require('../src/modules/admin/auth/admin-login.service');
const { createRecoveryRequest } = require('../src/modules/admin/auth/admin-recovery-request.service');
const { issueRecoveryStepUp, approveRecoveryRequest } = require('../src/modules/admin/auth/admin-recovery-decision.service');
const {
  redeemRecoveryInvitation,
  generateRecoveryRegistrationOptions,
  verifyRecoveryPasskeyRegistration,
  RecoveryRegistrationError,
} = require('../src/modules/admin/auth/admin-recovery-registration.service');

const { db, fake, NOW, PASSWORD, PASSWORD_HASH, PCA, seedAdmin, seedPasskey } = kit;
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TARGET_EMAIL = 'target@example.org';
const WRONG = 'WrongPass2027x';

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
});

// ---- fixtures ------------------------------------------------------------------------------

const startSession = (admin, now = NOW) => fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now }));
const newToken = () => crypto.randomBytes(32).toString('base64url');
const auditsOf = (event) => db.audits.filter((a) => a.event === event);

// An active Admin with an old passkey, two sessions (one already revoked) and a failed-login count,
// whose recovery request is approved, with a recovery invitation waiting to be redeemed.
async function approvedRecovery(overrides = {}) {
  const admin = seedAdmin({ email: TARGET_EMAIL, name: 'Tara Target', failedLoginCount: 3, lockedUntil: null, ...overrides.admin });
  const oldPasskey = seedPasskey(admin, { signCount: 4 });
  const live = await startSession(admin);
  const ended = await startSession(admin);
  db.sessions.find((s) => s.id === ended.sessionId).revokedAt = at(-60);
  const bystander = seedAdmin({ email: 'bystander@example.org' });
  const bystanderSession = await startSession(bystander);

  const request = {
    id: db.recoveryRequests.length + 1,
    adminId: admin.id,
    requestedByAdminId: null,
    requestedVia: 'operator',
    requestIp: null,
    reason: 'Lost laptop',
    status: 'approved',
    approvalsRequired: 2,
    approvedAt: at(-3600),
    completedAt: null,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    createdAt: at(-7200),
    ...overrides.request,
  };
  db.recoveryRequests.push(request);

  const token = newToken();
  const invitation = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'passkey_recovery',
    recoveryRequestId: request.id,
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(NOW.getTime() + DAY),
    usedAt: null,
    revokedAt: null,
    createdAt: at(-3600),
    ...overrides.invitation,
  };
  db.invitations.push(invitation);
  return { admin, oldPasskey, live, bystander, bystanderSession, request, token, invitation };
}

const redeem = (fx, overrides = {}) => redeemRecoveryInvitation({ token: fx.token, password: PASSWORD, now: at(1), ...overrides });

async function toTicket(fx) {
  return (await redeem(fx)).recoveryTicket;
}

async function toOptions(fx) {
  const ticket = await toTicket(fx);
  const options = await generateRecoveryRegistrationOptions({ ticket, now: at(2) });
  return { ticket, options };
}

const register = (options, overrides = {}) => makeRegistrationResponse({ challenge: options.challenge, ...overrides });
const verify = (ticket, reg, extra = {}) => verifyRecoveryPasskeyRegistration({ ticket, response: reg.response, label: 'New key', now: at(3), ...extra });

async function refusedWith(promise, reason, ErrorClass = RecoveryRegistrationError) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(ErrorClass);
  if (ErrorClass === RecoveryRegistrationError) {
    expect(error).toMatchObject({ code: 'invalid_recovery', message: 'This passkey recovery session is not valid. Please start again.' });
    expect(Object.keys(error).sort()).toEqual(['code', 'name']); // the reason is never serialised
  }
  if (reason) expect(error.reason).toBe(reason);
  return error;
}

// Makes one operation inside the next transactions throw, to prove the whole thing rolls back.
function failIn(model, method, predicate = () => true) {
  const original = fake.prisma.$transaction.bind(fake.prisma);
  return jest.spyOn(fake.prisma, '$transaction').mockImplementation((fn) => original((tx) => {
    const target = tx[model];
    const real = target[method].bind(target);
    target[method] = async (args) => {
      if (predicate(args)) throw new Error(`${model}.${method} failed`);
      return real(args);
    };
    return fn(tx);
  }));
}

// Runs `change` just before the next transaction starts (a concurrent change at the worst moment).
function changeBeforeTransaction(change) {
  const original = fake.prisma.$transaction.bind(fake.prisma);
  return jest.spyOn(fake.prisma, '$transaction').mockImplementation(async (fn) => {
    await change();
    return original(fn);
  });
}

const snapshotOf = (fx) => JSON.stringify({
  admin: db.admins.find((a) => a.id === fx.admin.id),
  passkeys: db.passkeys,
  sessions: db.sessions,
  tokens: db.refreshTokens,
  request: db.recoveryRequests.find((r) => r.id === fx.request.id),
}, (k, v) => (k === 'updatedAt' ? undefined : v));

// ---- 1. redeeming the invitation -----------------------------------------------------------

describe('redeemRecoveryInvitation', () => {
  it('turns the link and the current password into a recovery ticket, creating no session or token', async () => {
    const fx = await approvedRecovery();
    const sessions = db.sessions.length;
    const tokens = db.refreshTokens.length;
    const result = await redeem(fx);

    expect(result).toEqual({ status: 'approved', nextStep: 'passkey_registration', recoveryTicket: expect.any(String), ticketExpiresInSeconds: 600 });
    expect(readAdminRecoveryTicket(result.recoveryTicket)).toMatchObject({
      adminId: fx.admin.id, recoveryRequestId: fx.request.id, invitationId: fx.invitation.id, passwordChangedAt: PCA,
    });
    expect(jwt.decode(result.recoveryTicket)).toMatchObject({ aud: 'humancare-admin-recovery-ticket', flow: 'passkey_recovery' });
    expect(fx.invitation.usedAt).toEqual(at(1));
    expect(fx.request.status).toBe('approved'); // not completed by redeeming
    expect(db.sessions).toHaveLength(sessions);
    expect(db.refreshTokens).toHaveLength(tokens);
    expect(Object.keys(result).join()).not.toMatch(/access|refresh|session/i);
    expect(auditsOf('admin_recovery_invitation_redeemed')).toHaveLength(1);
    expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(1);
  });

  it('changes neither the password, nor the failed-login counter, nor the old passkeys', async () => {
    const fx = await approvedRecovery();
    const frozen = () => JSON.stringify({ a: fx.admin, p: db.passkeys }, (k, v) => (k === 'updatedAt' ? undefined : v));
    const before = frozen();
    await redeem(fx);
    expect(frozen()).toBe(before);
    expect(fx.admin).toMatchObject({ failedLoginCount: 3, passwordHash: PASSWORD_HASH, passwordChangedAt: PCA, lockedUntil: null });
  });

  it.each([
    ['nothing', undefined], ['a number', 12], ['an empty string', ''], ['a short string', 'abc'], ['a non-base64url string', `${'a'.repeat(42)}!`], ['an over-long string', 'a'.repeat(44)],
  ])('refuses %s as a token without any database work or attempt', async (_label, token) => {
    const fx = await approvedRecovery();
    await refusedWith(redeemRecoveryInvitation({ token, password: PASSWORD, now: at(1) }), 'invalid');
    expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(0);
    expect(fx.invitation.usedAt).toBeNull();
  });

  it('refuses an unknown token', async () => {
    await approvedRecovery();
    await refusedWith(redeemRecoveryInvitation({ token: newToken(), password: PASSWORD, now: at(1) }), 'invalid');
  });

  it('finds the invitation only by the hash of the token', async () => {
    const fx = await approvedRecovery();
    expect(JSON.stringify(db.invitations)).not.toContain(fx.token);
    await expect(redeem(fx)).resolves.toHaveProperty('recoveryTicket');
  });

  it.each(['activation', 'passkey_enrollment', 'Passkey_Recovery', 'other'])('refuses a %s invitation: only passkey_recovery is redeemable here', async (purpose) => {
    const fx = await approvedRecovery({ invitation: { purpose } });
    await refusedWith(redeem(fx), 'invalid');
    expect(fx.invitation.usedAt).toBeNull();
    expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(0);
  });

  it('refuses an invitation that belongs to another Admin than its request\'s target, or another address', async () => {
    const other = seedAdmin({ email: 'other@example.org' });
    const wrongAdmin = await approvedRecovery({ invitation: { adminId: other.id, sentToEmail: other.email } });
    await refusedWith(redeem(wrongAdmin), 'request_mismatch');

    fake.reset();
    db.auditClock = NOW;
    const mismatch = await approvedRecovery({ invitation: { sentToEmail: 'someone-else@example.org' } });
    await refusedWith(redeem(mismatch), 'email_mismatch');
  });

  it('refuses an invitation with no recovery request (not a normal recovery) or a dangling one', async () => {
    const none = await approvedRecovery({ invitation: { recoveryRequestId: null } });
    await refusedWith(redeem(none), 'no_request');
    fake.reset();
    db.auditClock = NOW;
    const dangling = await approvedRecovery({ invitation: { recoveryRequestId: 999 } });
    await refusedWith(redeem(dangling), 'no_request');
  });

  it('refuses an expired invitation (at exactly its expiry too), a revoked one and a used one', async () => {
    for (const [invitation, reason, now] of [
      [{ expiresAt: at(1) }, 'expired', at(1)],
      [{ expiresAt: at(0) }, 'expired', at(1)],
      [{ revokedAt: at(-10) }, 'revoked', at(1)],
      [{ usedAt: at(-10) }, 'used', at(1)],
    ]) {
      fake.reset();
      db.auditClock = NOW;
      const fx = await approvedRecovery({ invitation });
      await refusedWith(redeem(fx, { now }), reason);
      expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(0);
    }
  });

  it.each([
    ['pending', { status: 'pending' }],
    ['rejected', { status: 'rejected' }],
    ['completed', { status: 'completed' }],
    ['cancelled', { status: 'cancelled' }],
    ['expired', { status: 'expired' }],
    ['approved but past its deadline', { expiresAt: at(0) }],
    ['approved at its deadline', { expiresAt: at(1) }],
  ])('refuses when the recovery request is %s', async (_label, request) => {
    const fx = await approvedRecovery({ request });
    const error = await refusedWith(redeem(fx));
    expect(['request_status', 'request_expired']).toContain(error.reason);
    expect(fx.invitation.usedAt).toBeNull();
    expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(0);
  });

  it.each([
    ['disabled', { status: 'disabled' }],
    ['invited', { status: 'invited' }],
    ['pending_passkey', { status: 'pending_passkey' }],
  ])('refuses a %s Admin', async (_label, admin) => {
    const fx = await approvedRecovery({ admin });
    await refusedWith(redeem(fx), 'admin_status');
    expect(fx.invitation.usedAt).toBeNull();
  });

  it('refuses an Admin with no password', async () => {
    const fx = await approvedRecovery({ admin: { passwordHash: null } });
    await refusedWith(redeem(fx), 'no_password');
  });

  describe('the current password', () => {
    it('is required: a wrong, missing or unusable one is refused and counted', async () => {
      const fx = await approvedRecovery();
      for (const password of [WRONG, '', undefined, 12, 'x'.repeat(73)]) {
        await refusedWith(redeem(fx, { password }), 'wrong_password');
      }
      expect(fx.invitation.usedAt).toBeNull();
      expect(auditsOf('admin_recovery_redeem_attempt')).toHaveLength(5);
      expect(auditsOf('admin_recovery_redeem_failed')).toHaveLength(5);
    });

    it('is guessed at most five times: the fifth wrong one burns the link, and the right one then fails', async () => {
      const fx = await approvedRecovery();
      for (let i = 0; i < 5; i += 1) await refusedWith(redeem(fx, { password: `${WRONG}${i}` }), 'wrong_password');
      expect(fx.invitation.revokedAt).not.toBeNull();
      await refusedWith(redeem(fx), 'revoked');
      expect(fx.request.status).toBe('approved'); // the request itself is untouched
    });

    it('cannot be guessed in parallel beyond five attempts', async () => {
      const fx = await approvedRecovery();
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => redeem(fx, { password: `${WRONG}${i}` })));
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(auditsOf('admin_recovery_redeem_attempt').length).toBeLessThanOrEqual(5);
    });

    it('is not checked at all if the attempt cannot be recorded (fail closed)', async () => {
      const fx = await approvedRecovery();
      db.failAudit = true;
      await expect(redeem(fx)).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(fx.invitation.usedAt).toBeNull();
    });
  });

  it('simultaneous redemptions: exactly one gets a ticket', async () => {
    const fx = await approvedRecovery();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => redeem(fx)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason).toBeInstanceOf(RecoveryRegistrationError));
    expect(fx.invitation.usedAt).not.toBeNull();
    expect(auditsOf('admin_recovery_invitation_redeemed')).toHaveLength(1);
  });

  it('a replay of the link after success is refused', async () => {
    const fx = await approvedRecovery();
    await redeem(fx);
    await refusedWith(redeem(fx, { now: at(5) }), 'used');
  });

  it('a failure while recording the redemption leaves the invitation usable', async () => {
    const fx = await approvedRecovery();
    failIn('securityEvent', 'create', (args) => args.data.event === 'admin_recovery_invitation_redeemed');
    await expect(redeem(fx)).rejects.toThrow('securityEvent.create failed');
    jest.restoreAllMocks();
    expect(fx.invitation.usedAt).toBeNull();
    await expect(redeem(fx, { now: at(9) })).resolves.toHaveProperty('recoveryTicket');
  });

  it('is not possible through ordinary enrollment, and enrollment links are not redeemable here', async () => {
    const fx = await approvedRecovery();
    const error = await redeemAdminPasskeyEnrollmentInvitation({ token: fx.token, password: PASSWORD, now: at(1) }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(InvitationError);
    expect(error.code).toBe('invalid_invitation');
    expect(fx.invitation.usedAt).toBeNull();

    const enrollment = await approvedRecovery({ invitation: { purpose: 'passkey_enrollment' } });
    await refusedWith(redeem(enrollment), 'invalid');
  });

  it('needs a root Prisma client', async () => {
    const fx = await approvedRecovery();
    await expect(redeemRecoveryInvitation({ token: fx.token, password: PASSWORD, db: { adminInvitation: {} } })).rejects.toThrow(TypeError);
  });
});

// ---- 2. registration options ---------------------------------------------------------------

describe('generateRecoveryRegistrationOptions', () => {
  it('returns options for a NEW passkey with a recovery_registration challenge bound to the Admin and request', async () => {
    const fx = await approvedRecovery();
    const revoked = seedPasskey(fx.admin, { revokedAt: at(-100) });
    const { options } = await toOptions(fx);

    expect(options).toMatchObject({ rp: { id: 'localhost' }, timeout: 120000, authenticatorSelection: { userVerification: 'required' }, attestation: 'none' });
    expect(options.user.name).toBe(TARGET_EMAIL);
    expect(options.excludeCredentials).toHaveLength(2); // the old passkeys, revoked or not, cannot be registered again
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0]).toMatchObject({
      adminId: fx.admin.id, purpose: 'recovery_registration', recoveryRequestId: fx.request.id, invitationId: null, sessionId: null, consumedAt: null, expiresAt: at(122),
    });
    expect(db.challenges[0].challenge).toBe(options.challenge);
    expect(revoked.row.revokedAt).toEqual(at(-100));
  });

  it('revokes nothing: old passkeys, sessions, the request and the invitation are as they were', async () => {
    const fx = await approvedRecovery();
    const ticket = await toTicket(fx);
    const before = snapshotOf(fx);
    await generateRecoveryRegistrationOptions({ ticket, now: at(2) });
    expect(snapshotOf(fx)).toBe(before);
    expect(db.passkeys.every((p) => p.revokedAt === null)).toBe(true);
  });

  it('a newer call replaces the older challenge', async () => {
    const fx = await approvedRecovery();
    const ticket = await toTicket(fx);
    await generateRecoveryRegistrationOptions({ ticket, now: at(2) });
    await generateRecoveryRegistrationOptions({ ticket, now: at(3) });
    expect(db.challenges.map((c) => c.consumedAt === null)).toEqual([false, true]);
  });

  it('does not use or retire ordinary enrollment or login challenges', async () => {
    const fx = await approvedRecovery();
    const login = await issueAdminWebAuthnChallenge({ adminId: fx.admin.id, purpose: 'authentication', now: at(0) });
    const ticket = await toTicket(fx);
    await generateRecoveryRegistrationOptions({ ticket, now: at(2) });
    expect(db.challenges.find((c) => c.id === login.challengeId).consumedAt).toBeNull();
  });

  describe('tickets', () => {
    it.each([undefined, null, '', 'nope', 12, {}])('refuses %p', async (ticket) => {
      await approvedRecovery();
      await refusedWith(generateRecoveryRegistrationOptions({ ticket, now: at(2) }), 'invalid_ticket');
      expect(db.challenges).toHaveLength(0);
    });

    it('refuses an enrollment ticket, a login ticket, an access token and a tampered recovery ticket', async () => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      const [header, body, signature] = ticket.split('.');
      const forged = [header, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), rid: 99 })).toString('base64url'), signature].join('.');
      for (const bad of [
        signAdminEnrollmentTicket({ adminId: fx.admin.id, invitationId: fx.invitation.id, passwordChangedAt: PCA }),
        signAdminLoginTicket({ adminId: fx.admin.id, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN }),
        signAdminAccessToken({ adminId: fx.admin.id, role: 'admin', sessionId: 1 }),
        forged,
      ]) {
        await refusedWith(generateRecoveryRegistrationOptions({ ticket: bad, now: at(2) }), 'invalid_ticket');
      }
      expect(db.challenges).toHaveLength(0);
    });

    it('expires 600 seconds after it was issued', async () => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      const real = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(real + 599 * 1000);
      await expect(generateRecoveryRegistrationOptions({ ticket, now: at(2) })).resolves.toBeTruthy();
      Date.now.mockReturnValue(real + 601 * 1000);
      await refusedWith(generateRecoveryRegistrationOptions({ ticket, now: at(3) }), 'invalid_ticket');
    });

    it('is not accepted by ordinary enrollment or by the login', async () => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      await expect(generateAdminPasskeyRegistrationOptions({ ticket, now: at(2) })).rejects.toBeInstanceOf(PasskeyRegistrationError);
      await expect(verifyAdminPasskeyRegistration({ ticket, response: register({ challenge: 'x' }).response, now: at(3) })).rejects.toBeInstanceOf(PasskeyRegistrationError);
      await expect(completeAdminPasskeyLogin({ loginTicket: ticket, response: {}, now: at(3) })).rejects.toBeInstanceOf(AdminLoginError);
      expect(db.passkeys).toHaveLength(1);
      expect(db.challenges).toHaveLength(0);
    });
  });

  describe('the ticket stops working when the database no longer agrees', () => {
    it.each([
      ['the request has expired', (fx) => { fx.request.expiresAt = at(2); }],
      ['the request is cancelled', (fx) => { fx.request.status = 'cancelled'; }],
      ['the request is rejected', (fx) => { fx.request.status = 'rejected'; }],
      ['the request is completed', (fx) => { fx.request.status = 'completed'; }],
      ['the invitation is revoked', (fx) => { fx.invitation.revokedAt = at(1); }],
      ['the Admin is disabled', (fx) => { fx.admin.status = 'disabled'; }],
      ['the password changed', (fx) => { fx.admin.passwordChangedAt = new Date(PCA.getTime() + 1000); }],
      ['the invitation is gone from the request', (fx) => { fx.invitation.recoveryRequestId = 999; }],
    ])('when %s', async (_label, change) => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      change(fx);
      await refusedWith(generateRecoveryRegistrationOptions({ ticket, now: at(2) }), 'state_changed');
      expect(db.challenges).toHaveLength(0);
    });
  });

  it('fails as a server fault, not a refusal, without WebAuthn configuration', async () => {
    const fx = await approvedRecovery();
    const ticket = await toTicket(fx);
    delete process.env.ADMIN_WEBAUTHN_RP_NAME;
    await expect(generateRecoveryRegistrationOptions({ ticket, now: at(2) })).rejects.toThrow(/Invalid Admin Lock WebAuthn configuration/);
  });
});

// ---- 3. verification and completion --------------------------------------------------------

describe('verifyRecoveryPasskeyRegistration', () => {
  it('stores the new passkey, revokes the old, ends every session of the target and completes the request', async () => {
    const fx = await approvedRecovery();
    const other = seedPasskey(fx.admin, { signCount: 1 }); // a second live passkey
    const { ticket, options } = await toOptions(fx);
    const reg = register(options);
    db.events.length = 0;

    const result = await verify(ticket, reg);
    expect(result).toEqual({ status: 'recovered', nextStep: 'sign_in' });
    expect(JSON.stringify(result)).not.toMatch(/token|session|access|refresh|jwt/i);

    // the new passkey
    const added = db.passkeys.filter((p) => !p.revokedAt);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ adminId: fx.admin.id, label: 'New key', signCount: 0, revokedAt: null });
    expect(Buffer.from(added[0].credentialId).equals(Buffer.from(reg.credentialId))).toBe(true);
    // the old ones
    for (const old of [fx.oldPasskey.row, other.row]) {
      expect(old).toMatchObject({ revokedAt: at(3), revokedReason: 'recovery', revokedBy: null });
    }
    // every session and refresh token of the target; nobody else's
    expect(db.sessions.filter((s) => s.adminId === fx.admin.id).every((s) => s.revokedAt)).toBe(true);
    expect(db.sessions.find((s) => s.id === fx.live.sessionId)).toMatchObject({ revokedAt: at(3), revokedReason: 'passkey_recovery', revokedBy: null });
    expect(db.refreshTokens.filter((t) => db.sessions.find((s) => s.id === t.sessionId).adminId === fx.admin.id).every((t) => t.revokedAt)).toBe(true);
    expect(db.sessions.find((s) => s.id === fx.bystanderSession.sessionId).revokedAt).toBeNull();
    expect(db.refreshTokens.find((t) => t.sessionId === fx.bystanderSession.sessionId).revokedAt).toBeNull();
    // the request
    expect(fx.request).toMatchObject({ status: 'completed', completedAt: at(3) });
    // the audit
    expect(auditsOf('admin_passkey_recovered')).toEqual([expect.objectContaining({
      actorType: 'admin',
      actorId: fx.admin.id,
      detail: expect.objectContaining({ recoveryRequestId: fx.request.id, invitationId: fx.invitation.id, newPasskeyId: added[0].id, revokedPasskeyCount: 2, sessionCount: 1 }),
    })]);
  });

  it('inserts the new passkey FIRST and revokes the old ones only afterwards, inside one transaction', async () => {
    const fx = await approvedRecovery();
    const { ticket, options } = await toOptions(fx);
    const reg = register(options);
    db.events.length = 0;
    await verify(ticket, reg);
    const created = db.events.indexOf('passkeys.create');
    const revoked = db.events.indexOf('passkeys.update');
    const commit = db.events.lastIndexOf('commit');
    expect(created).toBeGreaterThan(-1);
    expect(revoked).toBeGreaterThan(created);
    expect(commit).toBeGreaterThan(revoked);
    expect(db.events.indexOf('commit')).toBeGreaterThan(revoked); // no commit between the insert and the revoke
  });

  it('creates no session or token, and changes neither the password nor the failed-login counter', async () => {
    const fx = await approvedRecovery();
    const { ticket, options } = await toOptions(fx);
    const sessions = db.sessions.length;
    const tokens = db.refreshTokens.length;
    await verify(ticket, register(options));
    expect(db.sessions).toHaveLength(sessions);
    expect(db.refreshTokens).toHaveLength(tokens);
    expect(fx.admin).toMatchObject({ failedLoginCount: 3, lockedUntil: null, passwordHash: PASSWORD_HASH, passwordChangedAt: PCA, status: 'active' });
    expect(fx.request.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY)); // the 7-day deadline is untouched
    expect(fx.invitation.expiresAt).toEqual(new Date(NOW.getTime() + DAY));
  });

  it('afterwards the Admin signs in with the NEW passkey only', async () => {
    const fx = await approvedRecovery();
    const { ticket, options } = await toOptions(fx);
    const reg = register(options);
    await verify(ticket, reg);

    await expect(kit.login(fx.admin, fx.oldPasskey)).rejects.toBeInstanceOf(AdminLoginError); // the old one is revoked
    const fresh = await kit.login(fx.admin, { reg }, { counter: 1 });
    expect(fresh).toHaveProperty('accessToken');
    expect(db.sessions.filter((s) => s.adminId === fx.admin.id && !s.revokedAt)).toHaveLength(1);
  });

  describe('the registration is checked', () => {
    const cases = [
      ['a wrong origin', { origin: 'https://evil.example' }],
      ['a wrong RP ID', { rpId: 'evil.example' }],
      ['no user verification', { flags: FLAG.UP | FLAG.AT }],
      ['no user presence', { flags: FLAG.UV | FLAG.AT }],
      ['the wrong ceremony type', { type: 'webauthn.get' }],
      ['an unsupported algorithm', { key: new Map([[1, 1], [3, -8000]]) }],
    ];

    it.each(cases)('refuses %s, burning the challenge and changing nothing', async (_label, overrides) => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const before = snapshotOf(fx);
      await refusedWith(verify(ticket, register(options, overrides)));
      expect(snapshotOf(fx)).toBe(before);
      expect(db.challenges[0].consumedAt).not.toBeNull();
      expect(fx.request.status).toBe('approved');
    });

    it('refuses a response for the wrong challenge', async () => {
      const fx = await approvedRecovery();
      const { ticket } = await toOptions(fx);
      await refusedWith(verify(ticket, register({ challenge: crypto.randomBytes(32).toString('base64url') })), 'verification_failed');
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
    });

    it('refuses malformed responses and labels before burning the challenge', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const good = register(options).response;
      for (const response of [undefined, null, 'x', {}, { ...good, type: 'other' }, { ...good, response: { ...good.response, attestationObject: '' } }]) {
        await refusedWith(verifyRecoveryPasskeyRegistration({ ticket, response, now: at(3) }), 'invalid_response');
      }
      await refusedWith(verifyRecoveryPasskeyRegistration({ ticket, response: good, label: 12, now: at(3) }), 'invalid_response');
      expect(db.challenges[0].consumedAt).toBeNull();
      await expect(verifyRecoveryPasskeyRegistration({ ticket, response: good, now: at(3) })).resolves.toMatchObject({ status: 'recovered' });
    });

    it('refuses a credential that is already registered - the Admin\'s own old one, or anyone else\'s - and changes nothing', async () => {
      const fx = await approvedRecovery();
      const elsewhere = seedPasskey(fx.bystander);
      for (const existing of [fx.oldPasskey, elsewhere]) {
        fake.prisma.$transaction.mockRestore?.();
        const { ticket, options } = await toOptions({ ...fx, token: fx.token });
        // the first loop pass redeems; later passes need a fresh invitation
        const reg = register(options, { credentialId: Buffer.from(existing.row.credentialId) });
        const before = snapshotOf(fx);
        await refusedWith(verify(ticket, reg), 'duplicate_credential');
        expect(snapshotOf(fx)).toBe(before);
        fx.invitation.usedAt = null;
        fx.token = newToken();
        fx.invitation.tokenHash = hashToken(fx.token);
        db.challenges.length = 0;
      }
    });
  });

  describe('the challenge', () => {
    it('is consumed once: a replay of the same response finds nothing', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      await verify(ticket, reg);
      await refusedWith(verify(ticket, reg, { now: at(4) }), 'state_changed'); // the request is already completed
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
    });

    it('cannot be an ordinary registration or login challenge', async () => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      for (const purpose of ['registration', 'authentication']) {
        const issued = await issueAdminWebAuthnChallenge({ adminId: fx.admin.id, purpose, now: at(2) });
        await refusedWith(verify(ticket, register({ challenge: issued.challenge })), 'challenge_unavailable');
        expect(db.challenges.find((c) => c.id === issued.challengeId).consumedAt).toBeNull(); // untouched
      }
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
    });

    it('must be bound to this very request', async () => {
      const fx = await approvedRecovery();
      const ticket = await toTicket(fx);
      const elsewhere = await issueAdminWebAuthnChallenge({ adminId: fx.admin.id, purpose: 'recovery_registration', recoveryRequestId: 999, now: at(2) });
      await refusedWith(verify(ticket, register({ challenge: elsewhere.challenge })), 'challenge_unavailable');
    });

    it('expires after 120 seconds', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      await refusedWith(verify(ticket, register(options), { now: at(122) }), 'challenge_unavailable');
    });

    it('a newer set of options retires the older challenge', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const newer = await generateRecoveryRegistrationOptions({ ticket, now: at(2) });
      await refusedWith(verify(ticket, register(options)), 'verification_failed'); // consumed the newer, signed the older
      expect(newer.challenge).not.toBe(options.challenge);
    });
  });

  describe('the ticket is checked again when the registration arrives', () => {
    it.each([
      ['the request has expired', (fx) => { fx.request.expiresAt = at(3); }],
      ['the request was cancelled', (fx) => { fx.request.status = 'cancelled'; }],
      ['the invitation was revoked', (fx) => { fx.invitation.revokedAt = at(2); }],
      ['the Admin was disabled', (fx) => { fx.admin.status = 'disabled'; }],
      ['the password changed', (fx) => { fx.admin.passwordChangedAt = new Date(PCA.getTime() + 1) ; }],
    ])('when %s: refused, the challenge kept, nothing changed', async (_label, change) => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      change(fx);
      const before = snapshotOf(fx);
      await refusedWith(verify(ticket, reg), 'state_changed');
      expect(snapshotOf(fx)).toBe(before);
      expect(db.challenges[0].consumedAt).toBeNull();
    });

    it('a change that lands after the check, before the final transaction, is still caught', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      changeBeforeTransaction(() => { fx.admin.status = 'disabled'; });
      await refusedWith(verify(ticket, reg), 'state_changed');
      jest.restoreAllMocks();
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
      expect(db.passkeys.find((p) => p.id === fx.oldPasskey.row.id).revokedAt).toBeNull();
      expect(db.sessions.find((s) => s.id === fx.live.sessionId).revokedAt).toBeNull();
      expect(fx.request.status).toBe('approved');
    });

    it('an expiry that lands in that window is caught too', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      changeBeforeTransaction(() => { fx.request.expiresAt = at(3); });
      await refusedWith(verify(ticket, reg), 'state_changed');
      jest.restoreAllMocks();
      expect(fx.request.status).toBe('approved');
      expect(db.passkeys).toHaveLength(1);
    });
  });

  describe('rollback: nothing is half done', () => {
    const untouched = (fx) => {
      expect(db.passkeys).toHaveLength(1);
      expect(db.passkeys[0]).toMatchObject({ id: fx.oldPasskey.row.id, revokedAt: null });
      expect(db.sessions.find((s) => s.id === fx.live.sessionId).revokedAt).toBeNull();
      expect(db.refreshTokens.find((t) => t.sessionId === fx.live.sessionId).revokedAt).toBeNull();
      expect(fx.request).toMatchObject({ status: 'approved', completedAt: null });
      expect(auditsOf('admin_passkey_recovered')).toHaveLength(0);
    };

    it.each([
      ['inserting the new passkey', () => failIn('adminPasskey', 'create'), 'adminPasskey.create failed'],
      ['revoking the old passkeys', () => failIn('adminPasskey', 'updateMany', (a) => a.data.revokedReason === 'recovery'), 'adminPasskey.updateMany failed'],
      ['ending the sessions', () => failIn('adminSession', 'updateMany'), 'adminSession.updateMany failed'],
      ['revoking the refresh tokens', () => failIn('adminRefreshToken', 'updateMany'), 'adminRefreshToken.updateMany failed'],
      ['completing the request', () => failIn('adminRecoveryRequest', 'updateMany', (a) => a.data.status === 'completed'), 'adminRecoveryRequest.updateMany failed'],
      ['writing the audit event', () => failIn('securityEvent', 'create', (a) => a.data.event === 'admin_passkey_recovered'), 'securityEvent.create failed'],
    ])('a failure %s undoes the whole completion', async (_label, arm, message) => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      arm();
      await expect(verify(ticket, reg)).rejects.toThrow(message);
      jest.restoreAllMocks();
      untouched(fx);
      // the challenge is spent, but fresh options let the Admin try again
      const again = await generateRecoveryRegistrationOptions({ ticket, now: at(5) });
      await expect(verify(ticket, register(again), { now: at(6) })).resolves.toMatchObject({ status: 'recovered' });
    });

    it('an audit failure (the general kind) undoes it as well', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      db.failAudit = true;
      await expect(verify(ticket, reg)).rejects.toThrow('audit write failed');
      db.failAudit = false;
      untouched(fx);
    });

    it('a database failure during verification propagates and changes nothing', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      failIn('adminPasskey', 'create');
      await expect(verify(ticket, reg)).rejects.toThrow();
      jest.restoreAllMocks();
      untouched(fx);
    });
  });

  describe('completing twice', () => {
    it('the same response submitted twice at once completes the recovery once', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const reg = register(options);
      const results = await Promise.allSettled([verify(ticket, reg), verify(ticket, reg)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason).toBeInstanceOf(RecoveryRegistrationError);
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
      expect(auditsOf('admin_passkey_recovered')).toHaveLength(1);
    });

    it('a second registration with a fresh challenge and the same ticket is refused once the request is completed', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      await verify(ticket, register(options));
      const second = await issueAdminWebAuthnChallenge({ adminId: fx.admin.id, purpose: 'recovery_registration', recoveryRequestId: fx.request.id, now: at(4) });
      const before = snapshotOf(fx);
      await refusedWith(verify(ticket, register({ challenge: second.challenge }), { now: at(5) }), 'state_changed');
      expect(snapshotOf(fx)).toBe(before);
      expect(db.passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
      await refusedWith(generateRecoveryRegistrationOptions({ ticket, now: at(6) }), 'state_changed');
    });

    it('two different tickets for one request cannot both complete it', async () => {
      const fx = await approvedRecovery();
      const { ticket, options } = await toOptions(fx);
      const second = signAdminRecoveryTicket({ adminId: fx.admin.id, recoveryRequestId: fx.request.id, invitationId: fx.invitation.id, passwordChangedAt: PCA });
      const regA = register(options);
      const secondChallenge = await issueAdminWebAuthnChallenge({ adminId: fx.admin.id, purpose: 'recovery_registration', recoveryRequestId: fx.request.id, now: at(2) });
      const regB = register({ challenge: secondChallenge.challenge });
      // the later challenge retired the first one; whichever response matches the live challenge wins, never both
      const results = await Promise.allSettled([verify(ticket, regA), verify(second, regB)]);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      expect(db.passkeys.filter((p) => !p.revokedAt).length).toBeLessThanOrEqual(1);
      expect(auditsOf('admin_passkey_recovered').length).toBeLessThanOrEqual(1);
    });
  });
});

// ---- secrets, and the whole path -------------------------------------------------------------

describe('secrets', () => {
  it('no token, ticket, challenge, response or key material reaches an audit row or a log', async () => {
    const fx = await approvedRecovery();
    const { ticket, options } = await toOptions(fx);
    const reg = register(options);
    await redeem(fx, { password: WRONG, now: at(50) }).catch(() => {});
    await verify(ticket, reg);
    const everything = JSON.stringify({ audits: db.audits, invitations: db.invitations, requests: db.recoveryRequests, logs: console.error.mock.calls });
    for (const secret of [fx.token, ticket, options.challenge, reg.response.response.attestationObject, reg.response.response.clientDataJSON, PASSWORD, WRONG]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain(Buffer.from(reg.publicKey).toString('base64'));
    expect(everything).not.toContain(Buffer.from(reg.publicKey).toString('hex'));
  });
});

describe('the whole path: two approvals, redemption, a new passkey', () => {
  it('works end to end through the decision service', async () => {
    const target = seedAdmin({ email: TARGET_EMAIL, name: 'Tara Target', failedLoginCount: 2 });
    const oldPasskey = seedPasskey(target);
    await startSession(target);

    async function approver(email) {
      const admin = seedAdmin({ email, role: 'superadmin' });
      const passkey = seedPasskey(admin);
      const session = await startSession(admin);
      return { admin, passkey, sessionId: session.sessionId, counter: 1 };
    }
    const [a, b] = [await approver('a@example.org'), await approver('b@example.org')];
    process.env.ADMIN_PORTAL_URL = 'https://admin.example.org';
    const created = await createRecoveryRequest({ email: TARGET_EMAIL, reason: 'Lost laptop', now: NOW });
    const requestId = created.request.id;
    for (const [who, when] of [[a, 5], [b, 10]]) {
      const issued = await issueRecoveryStepUp({ kind: 'approve', requestId, approverId: who.admin.id, sessionId: who.sessionId, now: NOW });
      const response = makeAssertionResponse({ challenge: issued.options.challenge, registered: who.passkey.reg, counter: who.counter });
      who.counter += 1;
      await approveRecoveryRequest({ requestId, approverId: who.admin.id, sessionId: who.sessionId, response, now: at(when) });
    }
    const invitationMail = mailer.sendMail.mock.calls.map(([m]) => m).find((m) => /passkey recovery link/.test(m.subject));
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(invitationMail.text)[1];

    const { recoveryTicket } = await redeemRecoveryInvitation({ token, password: PASSWORD, now: at(60) });
    const options = await generateRecoveryRegistrationOptions({ ticket: recoveryTicket, now: at(61) });
    const reg = makeRegistrationResponse({ challenge: options.challenge });
    await expect(verifyRecoveryPasskeyRegistration({ ticket: recoveryTicket, response: reg.response, now: at(62) })).resolves.toEqual({ status: 'recovered', nextStep: 'sign_in' });

    expect(db.recoveryRequests.find((r) => r.id === requestId)).toMatchObject({ status: 'completed', completedAt: at(62) });
    expect(oldPasskey.row.revokedAt).toEqual(at(62));
    expect(target.failedLoginCount).toBe(2);
    await expect(kit.login(target, { reg }, { counter: 1 })).resolves.toHaveProperty('accessToken');
  });
});
