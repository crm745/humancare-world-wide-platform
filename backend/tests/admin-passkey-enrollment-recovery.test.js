// Pending-Admin passkey-enrollment recovery (Step 7.7.7): operator issuance of a
// "passkey_enrollment" invitation, redemption with the current password, and the registration
// services accepting the resulting ticket. No database: Prisma is the in-memory stand-in from
// admin-lock-fake-db.js; mail never leaves the process.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fake = require('./admin-lock-fake-db');
const mailer = require('../src/lib/mailer');
const { hashToken } = require('../src/common/utils/token-hash');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const {
  resendPasskeyEnrollmentInvitation,
  InvitationOperatorError,
} = require('../src/modules/admin/auth/admin-invitation-operator.service');
const {
  redeemAdminPasskeyEnrollmentInvitation,
  inspectActivationInvitation,
  acceptActivationInvitation,
  InvitationError,
} = require('../src/modules/admin/auth/admin-invitation.service');
const {
  generateAdminPasskeyRegistrationOptions,
  verifyAdminPasskeyRegistration,
  PasskeyRegistrationError,
} = require('../src/modules/admin/auth/admin-webauthn-registration.service');
const { readAdminEnrollmentTicket, enrollmentTicketMatches } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { readAdminLoginTicket, ADMIN_LOGIN_FLOWS } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { verifyAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { parseArgs } = require('../scripts/admin-invitation');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const PCA = new Date('2027-02-28T09:00:00.000Z');
const HOUR = 3600 * 1000;
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const PASSWORD = 'CurrentPass2027x';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const PORTAL = 'https://admin.example.org';
const ENV_KEYS = ['ADMIN_PORTAL_URL', 'JWT_ACCESS_SECRET', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME', 'NODE_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const GENERIC_MESSAGE = 'This invitation link is not valid.';

const newToken = () => crypto.randomBytes(32).toString('base64url');

function seedAdmin(overrides = {}) {
  const admin = {
    id: db.admins.length + 1,
    name: 'Asha Rao',
    email: 'asha@example.org',
    role: 'admin',
    status: 'pending_passkey',
    passwordHash: PASSWORD_HASH,
    passwordChangedAt: PCA,
    emailVerifiedAt: PCA,
    failedLoginCount: 0,
    updatedAt: null,
    ...overrides,
  };
  db.admins.push(admin);
  return admin;
}

function seedInvitation(admin, overrides = {}) {
  const token = newToken();
  const invitation = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'passkey_enrollment',
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: later(24 * 3600),
    usedAt: null,
    revokedAt: null,
    createdAt: later(-3600),
    ...overrides,
  };
  db.invitations.push(invitation);
  return { token, invitation };
}

// The invitation that originally activated the account: used, as acceptance leaves it.
const seedAcceptedActivation = (admin) => seedInvitation(admin, { purpose: 'activation', usedAt: PCA, createdAt: new Date(PCA.getTime() - HOUR) }).invitation;

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  process.env.ADMIN_PORTAL_URL = PORTAL;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-enrollment-recovery';
  process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
  process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const sentToken = () => mailer.sendMail.mock.calls.at(-1)[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];

describe('operator: resendPasskeyEnrollmentInvitation', () => {
  const resend = (overrides = {}) => resendPasskeyEnrollmentInvitation({ email: 'asha@example.org', now: NOW, ...overrides });

  it('issues a passkey-enrollment invitation to a pending Admin, reusing the account', async () => {
    const admin = seedAdmin();
    const result = await resend({ email: ' ASHA@Example.org ' });
    expect(db.admins).toEqual([admin]); // no second account
    expect(result).toMatchObject({ admin: { id: admin.id, email: 'asha@example.org' }, revokedCount: 0, emailDelivered: true, emailError: null });
    expect(db.invitations).toHaveLength(1);
    expect(db.invitations[0]).toMatchObject({ adminId: admin.id, purpose: 'passkey_enrollment', sentToEmail: 'asha@example.org', usedAt: null, revokedAt: null });
  });

  it('stores the approved 24-hour recovery lifetime', async () => {
    seedAdmin();
    const result = await resend();
    expect(db.invitations[0].expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    expect(result.invitation.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
  });

  it('uses a fresh 32-byte random token and stores only its SHA-256', async () => {
    seedAdmin();
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    await resend();
    expect(randomBytes).toHaveBeenCalledWith(32);
    const token = sentToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(db.invitations[0].tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db)).not.toContain(token); // not stored anywhere, audit included
  });

  it('does not change the password or its timestamp, or anything else about the Admin', async () => {
    const admin = seedAdmin();
    const before = { ...admin };
    await resend();
    expect({ ...admin, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    expect(admin.passwordHash).toBe(PASSWORD_HASH);
    expect(admin.passwordChangedAt).toBe(PCA);
  });

  it.each([
    ['unknown email', null, 'admin_not_found'],
    ['an invited Admin', { status: 'invited', passwordHash: null }, 'not_pending_passkey'],
    ['an active Admin', { status: 'active' }, 'not_pending_passkey'],
    ['a disabled Admin', { status: 'disabled' }, 'not_pending_passkey'],
  ])('refuses %s', async (_name, overrides, code) => {
    if (overrides) seedAdmin(overrides);
    await expect(resend()).rejects.toMatchObject({ name: 'InvitationOperatorError', code });
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('refuses a pending Admin with no password hash', async () => {
    seedAdmin({ passwordHash: null });
    await expect(resend()).rejects.toMatchObject({ code: 'no_password' });
    expect(db.invitations).toHaveLength(0);
  });

  it('refuses an Admin who has an unrevoked passkey (that is lost-passkey recovery, a different process)', async () => {
    const admin = seedAdmin();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialIdHash: 'a'.repeat(64), revokedAt: null });
    await expect(resend()).rejects.toMatchObject({ code: 'has_passkey' });
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('is not blocked by revoked passkeys or another Admin\'s passkeys', async () => {
    const admin = seedAdmin();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialIdHash: 'a'.repeat(64), revokedAt: NOW });
    db.passkeys.push({ id: 2, adminId: admin.id + 1, credentialIdHash: 'b'.repeat(64), revokedAt: null });
    await expect(resend()).resolves.toMatchObject({ emailDelivered: true });
  });

  it('revokes earlier open passkey-enrollment invitations', async () => {
    const admin = seedAdmin();
    const { invitation: first } = seedInvitation(admin);
    const { invitation: second } = seedInvitation(admin);
    const result = await resend();
    expect(result.revokedCount).toBe(2);
    expect(first.revokedAt).toEqual(NOW);
    expect(second.revokedAt).toEqual(NOW);
    expect(db.invitations.filter((i) => i.purpose === 'passkey_enrollment' && !i.usedAt && !i.revokedAt)).toHaveLength(1);
  });

  it('leaves activation, passkey-recovery, used and other Admins\' invitations alone', async () => {
    const admin = seedAdmin();
    const other = seedAdmin({ email: 'other@example.org' });
    const { invitation: openActivation } = seedInvitation(admin, { purpose: 'activation' });
    const { invitation: recovery } = seedInvitation(admin, { purpose: 'passkey_recovery' });
    const { invitation: used } = seedInvitation(admin, { usedAt: PCA });
    const { invitation: alreadyRevoked } = seedInvitation(admin, { revokedAt: new Date(PCA.getTime() + 1) });
    const { invitation: others } = seedInvitation(other);
    await resend();
    expect(openActivation.revokedAt).toBeNull();
    expect(recovery.revokedAt).toBeNull();
    expect(used.revokedAt).toBeNull();
    expect(alreadyRevoked.revokedAt).toEqual(new Date(PCA.getTime() + 1));
    expect(others.revokedAt).toBeNull();
  });

  it('writes its audit event in the same transaction, without secrets', async () => {
    const admin = seedAdmin();
    seedInvitation(admin);
    await resend();
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ event: 'admin_passkey_enrollment_invitation_created', actorType: 'operator', actorId: null, identifier: 'asha@example.org' });
    expect(db.audits[0].detail).toMatchObject({ adminId: admin.id, revokedInvitationCount: 1 });
    expect(Object.keys(db.audits[0].detail.operator).sort()).toEqual(['hostname', 'username']);
    const token = sentToken();
    const text = JSON.stringify(db.audits);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashToken(token));
    expect(text).not.toContain('enroll-passkey');
  });

  it('rolls everything back, and sends nothing, when the audit write fails', async () => {
    const admin = seedAdmin();
    const { invitation: old } = seedInvitation(admin);
    db.failAudit = true;
    await expect(resend()).rejects.toThrow('audit write failed');
    expect(old.revokedAt).toBeNull();
    expect(db.invitations).toHaveLength(1);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('emails only after the commit, as a sensitive message with the link in the fragment', async () => {
    seedAdmin();
    await resend();
    expect(db.events.slice(-3)).toEqual(['audit.create', 'commit', 'email']);
    const message = mailer.sendMail.mock.calls[0][0];
    expect(message.sensitive).toBe(true);
    expect(message.to).toBe('asha@example.org');
    expect(message.text).toContain(`${PORTAL}/enroll-passkey#token=${sentToken()}`);
    expect(message.text).not.toContain('?token');
    expect(message.text).toMatch(/current password/);
    expect(message.subject).toMatch(/passkey/i);
  });

  it('keeps the new invitation when delivery fails, without exposing the token, and a later resend replaces it', async () => {
    const admin = seedAdmin();
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    mailer.sendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const result = await resend();
    expect(result).toMatchObject({ emailDelivered: false, emailError: 'SMTP connection refused' });
    expect(db.invitations).toHaveLength(1);
    expect(db.events).not.toContain('rollback');
    expect(db.audits.map((a) => a.event)).toEqual(['admin_passkey_enrollment_invitation_created', 'admin_passkey_enrollment_invitation_delivery_failed']);
    expect(db.audits[1]).toMatchObject({ actorType: 'operator', detail: { adminId: admin.id, invitationId: result.invitation.id } });
    expect(JSON.stringify(db.audits[1])).not.toContain('SMTP');

    const output = spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n') + JSON.stringify(result);
    expect(output).not.toContain('enroll-passkey');
    expect(output).not.toMatch(/[A-Za-z0-9_-]{43}/);

    const second = await resend({ now: later(60) });
    expect(second.revokedCount).toBe(1);
    expect(db.invitations[0].revokedAt).toEqual(later(60));
    expect(db.invitations.filter((i) => !i.revokedAt && !i.usedAt)).toHaveLength(1);
  });

  it('refuses an invalid ADMIN_PORTAL_URL before changing anything', async () => {
    const admin = seedAdmin();
    const { invitation } = seedInvitation(admin);
    delete process.env.ADMIN_PORTAL_URL;
    await expect(resend()).rejects.toThrow('ADMIN_PORTAL_URL');
    expect(invitation.revokedAt).toBeNull();
    expect(db.events).toEqual([]);
  });

  it('simultaneous resends leave exactly one outstanding invitation', async () => {
    seedAdmin();
    await Promise.all([1, 2, 3, 4].map((i) => resend({ now: later(i) })));
    expect(db.invitations).toHaveLength(4);
    expect(db.invitations.filter((i) => !i.revokedAt && !i.usedAt)).toHaveLength(1);
  });

  it('a resend racing with a registration cannot issue an invitation to an activated Admin', async () => {
    const admin = seedAdmin();
    const winner = fake.prisma.$transaction(async (tx) => {
      await tx.adminUser.updateMany({ where: { id: admin.id }, data: { status: 'active' } });
      await tx.adminPasskey.create({ data: { adminId: admin.id, credentialIdHash: 'c'.repeat(64) } });
    });
    await winner;
    await expect(resend()).rejects.toMatchObject({ name: 'InvitationOperatorError' });
    expect(db.invitations).toHaveLength(0);
  });

  describe('command line', () => {
    it('accepts resend-enrollment with a normalized email', () => {
      expect(parseArgs(['resend-enrollment', '--email', ' Asha@Example.org '])).toEqual({ command: 'resend-enrollment', email: 'asha@example.org' });
      expect(parseArgs(['resend-enrollment', '--email=asha@example.org'])).toEqual({ command: 'resend-enrollment', email: 'asha@example.org' });
    });

    it.each([
      ['no email', ['resend-enrollment']],
      ['a password option', ['resend-enrollment', '--email', 'a@b.co', '--password', 'secret']],
      ['a token option', ['resend-enrollment', '--email', 'a@b.co', '--token', 'x']],
      ['a repeated email', ['resend-enrollment', '--email', 'a@b.co', '--email', 'c@d.co']],
      ['a stray argument', ['resend-enrollment', '--email', 'a@b.co', 'extra']],
      ['an invalid email', ['resend-enrollment', '--email', 'nope']],
      ['an unknown command', ['resend-passkey', '--email', 'a@b.co']],
    ])('rejects %s', (_name, argv) => {
      expect(() => parseArgs(argv)).toThrow();
    });

    it('does not echo a rejected password option value', () => {
      try { parseArgs(['resend-enrollment', '--email', 'a@b.co', '--password', 'hunter2hunter2']); } catch (err) { expect(err.message).not.toContain('hunter2'); }
    });
  });
});

describe('redeemAdminPasskeyEnrollmentInvitation', () => {
  const redeem = (token, overrides = {}) => redeemAdminPasskeyEnrollmentInvitation({ token, password: PASSWORD, now: NOW, ...overrides });
  const expectGeneric = async (promise) => {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({ code: 'invalid_invitation', state: 'invalid', message: GENERIC_MESSAGE });
    expect(error).not.toHaveProperty('enrollmentTicket');
    return error;
  };

  async function pending() {
    const admin = seedAdmin();
    const accepted = seedAcceptedActivation(admin);
    const { token, invitation } = seedInvitation(admin);
    return { admin, accepted, token, invitation };
  }

  it('redeems the right token with the current password for a 600-second ticket', async () => {
    const { admin, token, invitation } = await pending();
    const result = await redeem(token);
    expect(result).toEqual({ status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: expect.any(String), ticketExpiresInSeconds: 600 });
    expect(invitation.usedAt).toEqual(NOW);
    expect(admin.status).toBe('pending_passkey');
    const decoded = jwt.decode(result.enrollmentTicket);
    expect(decoded.exp - decoded.iat).toBe(600);
  });

  it('binds the ticket to the Admin, the redeemed invitation and the unchanged password timestamp', async () => {
    const { admin, token, invitation } = await pending();
    const { enrollmentTicket } = await redeem(token);
    const claims = readAdminEnrollmentTicket(enrollmentTicket);
    expect(claims).toMatchObject({ adminId: admin.id, invitationId: invitation.id, passwordChangedAt: PCA });
    expect(Object.keys(jwt.decode(enrollmentTicket)).sort()).toEqual(['aud', 'exp', 'flow', 'iat', 'inv', 'iss', 'jti', 'pca', 'sub']);
    expect(enrollmentTicketMatches(claims, { admin, invitationId: invitation.id })).toBe(true);
  });

  it('does not change the password or its timestamp', async () => {
    const { admin, token } = await pending();
    await redeem(token);
    expect(admin.passwordHash).toBe(PASSWORD_HASH);
    expect(admin.passwordChangedAt).toBe(PCA);
    expect(admin.emailVerifiedAt).toBe(PCA);
  });

  it('is not an access token or a login ticket', async () => {
    const { token } = await pending();
    const { enrollmentTicket } = await redeem(token);
    expect(verifyAdminAccessToken(enrollmentTicket)).toBeNull();
    for (const flow of Object.values(ADMIN_LOGIN_FLOWS)) expect(readAdminLoginTicket(enrollmentTicket, flow)).toBeNull();
  });

  describe('every refusal is the same generic error', () => {
    it('wrong password (and the invitation stays usable)', async () => {
      const { token, invitation } = await pending();
      await expectGeneric(redeem(token, { password: 'WrongPass2027y' }));
      expect(invitation.usedAt).toBeNull();
      expect(invitation.revokedAt).toBeNull();
    });

    it.each([[undefined], [null], [''], [12345], [{}], ['x'.repeat(100)]])('unusable password %p', async (password) => {
      const { token, invitation } = await pending();
      await expectGeneric(redeem(token, { password }));
      expect(invitation.usedAt).toBeNull();
    });

    it.each([[undefined], [null], [''], ['junk'], ['A'.repeat(43) + '!'], [12345]])('invalid token %p', async (token) => {
      await pending();
      await expectGeneric(redeem(token));
    });

    it('an unknown (well-formed) token', async () => {
      await pending();
      await expectGeneric(redeem(newToken()));
    });

    it.each([
      ['expired', { expiresAt: later(-1) }],
      ['expiring exactly now', { expiresAt: NOW }],
      ['already used', { usedAt: later(-60) }],
      ['revoked', { revokedAt: later(-60) }],
      ['an activation invitation', { purpose: 'activation' }],
      ['a passkey-recovery invitation', { purpose: 'passkey_recovery' }],
      ['sent to another address', { sentToEmail: 'someone.else@example.org' }],
    ])('an invitation that is %s', async (_name, overrides) => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin, overrides);
      const before = { usedAt: db.invitations[0].usedAt, revokedAt: db.invitations[0].revokedAt };
      await expectGeneric(redeem(token));
      expect({ usedAt: db.invitations[0].usedAt, revokedAt: db.invitations[0].revokedAt }).toEqual(before);
    });

    it('an invitation pointing at an Admin it was not sent to', async () => {
      const owner = seedAdmin();
      const other = seedAdmin({ email: 'other@example.org' });
      const { token } = seedInvitation(owner, { adminId: other.id }); // sentToEmail is the owner's
      await expectGeneric(redeem(token));
    });

    it.each(['invited', 'active', 'disabled', 'something_else'])('an Admin whose status is %s', async (status) => {
      const admin = seedAdmin({ status });
      const { token } = seedInvitation(admin);
      await expectGeneric(redeem(token));
      expect(admin.status).toBe(status);
    });

    it('an Admin with no password hash, without throwing', async () => {
      const admin = seedAdmin({ passwordHash: null });
      const { token } = seedInvitation(admin);
      await expectGeneric(redeem(token));
      await expectGeneric(redeem(token, { password: 'no-account-placeholder' }));
    });

    it('an Admin with no password timestamp', async () => {
      const admin = seedAdmin({ passwordChangedAt: null });
      const { token } = seedInvitation(admin);
      await expectGeneric(redeem(token));
    });

    it('an Admin who already has an unrevoked passkey', async () => {
      const { admin, token, invitation } = await pending();
      db.passkeys.push({ id: 1, adminId: admin.id, credentialIdHash: 'd'.repeat(64), revokedAt: null });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
    });

    it('gives the same error object shape for every cause', async () => {
      const { token } = await pending();
      const shapes = new Set();
      for (const attempt of [() => redeem(token, { password: 'Wrong2027z' }), () => redeem(newToken()), () => redeem('junk')]) {
        const error = await attempt().catch((e) => e);
        shapes.add(JSON.stringify({ name: error.name, code: error.code, state: error.state, message: error.message, keys: Object.keys(error).sort() }));
      }
      expect(shapes.size).toBe(1);
    });
  });

  describe('uniform work and attempt limits', () => {
    it('runs exactly one password comparison on every path', async () => {
      const { token } = await pending();
      const compare = jest.spyOn(bcrypt, 'compare');
      compare.mockClear();
      await redeem(newToken()).catch(() => {});
      expect(compare).toHaveBeenCalledTimes(1);
      compare.mockClear();
      await redeem(token, { password: 'Wrong2027z' }).catch(() => {});
      expect(compare).toHaveBeenCalledTimes(1);
      compare.mockClear();
      await redeem(token).catch(() => {});
      expect(compare).toHaveBeenCalledTimes(1);
    });

    it('records each wrong password and burns the link after the 5th', async () => {
      const { admin, token, invitation } = await pending();
      for (let i = 1; i <= 4; i += 1) {
        await expectGeneric(redeem(token, { password: `Wrong2027${i}` }));
        expect(invitation.revokedAt).toBeNull();
      }
      await expectGeneric(redeem(token, { password: 'Wrong2027five' }));
      expect(invitation.revokedAt).toEqual(NOW); // the 5th wrong guess revoked it
      expect(db.audits.filter((a) => a.event === 'admin_passkey_enrollment_redeem_failed')).toHaveLength(5);
      // the right password no longer helps: the link is dead
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
      expect(admin.status).toBe('pending_passkey');
    });

    it('also refuses once attempts are exhausted even if the link was somehow not revoked', async () => {
      const { admin, token, invitation } = await pending();
      for (let i = 0; i < 5; i += 1) db.audits.push({ event: 'admin_passkey_enrollment_redeem_attempt', actorType: 'admin', actorId: admin.id, createdAt: NOW });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
    });

    it('does not count failures from before the invitation was issued, so a new link starts fresh', async () => {
      const { admin } = await pending();
      for (let i = 0; i < 5; i += 1) db.audits.push({ event: 'admin_passkey_enrollment_redeem_attempt', actorType: 'admin', actorId: admin.id, createdAt: later(-7200) });
      const { token: fresh } = seedInvitation(admin, { createdAt: later(-60) });
      await expect(redeem(fresh)).resolves.toMatchObject({ status: 'pending_passkey' });
    });

    it('refusals of unusable links are audited separately and are not counted as password failures', async () => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin, { revokedAt: later(-60) });
      for (let i = 0; i < 6; i += 1) await redeem(token).catch(() => {});
      expect(db.audits.every((a) => a.event === 'admin_passkey_enrollment_redeem_refused')).toBe(true);
      expect(db.audits[0].detail).toMatchObject({ reason: 'revoked' });
    });
  });

  describe('transaction safety', () => {
    it('rolls back and returns no ticket when the audit write fails', async () => {
      const { admin, token, invitation } = await pending();
      db.failAudit = true;
      const error = await redeem(token).then(() => null, (e) => e);
      expect(error.message).toBe('audit write failed');
      expect(invitation.usedAt).toBeNull();
      expect(invitation.revokedAt).toBeNull();
      expect(admin.status).toBe('pending_passkey');
      expect(db.events).toContain('rollback');
      db.failAudit = false;
      await expect(redeem(token)).resolves.toMatchObject({ status: 'pending_passkey' }); // still usable
    });

    it('rolls back and returns no ticket when the ticket cannot be signed', async () => {
      const { token, invitation } = await pending();
      delete process.env.JWT_ACCESS_SECRET;
      await expect(redeem(token)).rejects.toThrow('JWT_ACCESS_SECRET is not set');
      expect(invitation.usedAt).toBeNull();
      expect(db.audits.filter((a) => a.event === 'admin_passkey_enrollment_invitation_redeemed')).toHaveLength(0);
      process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-enrollment-recovery';
      await expect(redeem(token)).resolves.toMatchObject({ status: 'pending_passkey' });
    });

    it('returns the ticket only after the commit, and audits redemption as the Admin without secrets', async () => {
      const { admin, token, invitation } = await pending();
      const result = await redeem(token, { ipAddress: '203.0.113.8' });
      expect(db.events.slice(-2)).toEqual(['audit.create', 'commit']);
      // the reserved attempt, then the redemption itself
      expect(db.audits.map((a) => a.event)).toEqual(['admin_passkey_enrollment_redeem_attempt', 'admin_passkey_enrollment_invitation_redeemed']);
      expect(db.audits[1]).toMatchObject({
        event: 'admin_passkey_enrollment_invitation_redeemed',
        actorType: 'admin',
        actorId: admin.id,
        ipAddress: '203.0.113.8',
        detail: { invitationId: invitation.id },
      });
      const text = JSON.stringify(db.audits);
      for (const secret of [token, PASSWORD, result.enrollmentTicket, invitation.tokenHash, PASSWORD_HASH]) expect(text).not.toContain(secret);
    });

    it('requires a root Prisma client', async () => {
      const { token } = await pending();
      await expect(redeemAdminPasskeyEnrollmentInvitation({ token, password: PASSWORD, db: { adminUser: {} } })).rejects.toThrow(TypeError);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of several simultaneous redemptions win', async () => {
      const { token, invitation } = await pending();
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => redeem(token)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect(r.reason).toBeInstanceOf(InvitationError);
        expect(r.reason.message).toBe(GENERIC_MESSAGE);
      }
      expect(invitation.usedAt).toEqual(NOW);
      expect(db.audits.filter((a) => a.event === 'admin_passkey_enrollment_invitation_redeemed')).toHaveLength(1);
    });

    // The password is verified before the transaction; each of these changes the world right after
    // that check, so the transaction's own conditional updates and re-reads must catch it.
    const afterPasswordCheck = (mutate) => {
      const realCompare = bcrypt.compare.bind(bcrypt);
      jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args) => {
        const result = await realCompare(...args);
        mutate();
        return result;
      });
    };

    it('an Admin disabled right after the password check is not given a ticket', async () => {
      const { admin, token, invitation } = await pending();
      afterPasswordCheck(() => { admin.status = 'disabled'; });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
    });

    it('a password change right after the check is not honoured', async () => {
      const { admin, token, invitation } = await pending();
      afterPasswordCheck(() => { admin.passwordHash = bcrypt.hashSync('BrandNewPass2027', 4); admin.passwordChangedAt = new Date(PCA.getTime() + 5000); });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
    });

    it('a passkey registered right after the check blocks the redemption', async () => {
      const { admin, token, invitation } = await pending();
      afterPasswordCheck(() => { db.passkeys.push({ id: 9, adminId: admin.id, credentialIdHash: 'e'.repeat(64), revokedAt: null }); });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
      expect(db.events).toContain('rollback');
    });

    it('an invitation revoked right after the check cannot be redeemed', async () => {
      const { token, invitation } = await pending();
      afterPasswordCheck(() => { invitation.revokedAt = later(-1); });
      await expectGeneric(redeem(token));
      expect(invitation.usedAt).toBeNull();
    });

    it('a token cannot be redeemed for a different Admin\'s account', async () => {
      const mine = seedAdmin();
      const theirs = seedAdmin({ email: 'theirs@example.org', passwordHash: bcrypt.hashSync('TheirPass2027q', 4) });
      const { token } = seedInvitation(mine);
      const { enrollmentTicket } = await redeem(token);
      expect(readAdminEnrollmentTicket(enrollmentTicket).adminId).toBe(mine.id);
      // and the other Admin's password does not open this link
      const { token: secondToken } = seedInvitation(mine);
      await expectGeneric(redeem(secondToken, { password: 'TheirPass2027q' }));
      expect(theirs.status).toBe('pending_passkey');
    });
  });

  describe('nothing sensitive is issued or leaked', () => {
    it('issues no access token, refresh token, cookie or session', async () => {
      const { token } = await pending();
      const result = await redeem(token);
      expect(Object.keys(result).sort()).toEqual(['enrollmentTicket', 'nextStep', 'status', 'ticketExpiresInSeconds']);
      expect(db.sessions).toHaveLength(0);
      expect(db.refreshTokens).toHaveLength(0);
    });

    it('keeps the token, password and ticket out of logs and audit rows, even for refusals', async () => {
      const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
      const { token, invitation } = await pending();
      await redeem(token, { password: 'WrongGuess2027m' }).catch(() => {});
      db.failAudit = true;
      await redeem(token, { password: 'WrongGuess2027n' }).catch(() => {});
      db.failAudit = false;
      const { enrollmentTicket } = await redeem(token);
      const everywhere = JSON.stringify(db.audits) + spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
      for (const secret of [token, PASSWORD, 'WrongGuess2027m', 'WrongGuess2027n', enrollmentTicket, invitation.tokenHash, PASSWORD_HASH]) {
        expect(everywhere).not.toContain(secret);
      }
    });

    it('does not store the ticket', async () => {
      const { token } = await pending();
      const { enrollmentTicket } = await redeem(token);
      expect(JSON.stringify(db)).not.toContain(enrollmentTicket);
    });
  });
});

describe('registration accepts the redeemed enrollment invitation', () => {
  async function redeemedContext() {
    const admin = seedAdmin();
    seedAcceptedActivation(admin);
    const { token, invitation } = seedInvitation(admin);
    const { enrollmentTicket } = await redeemAdminPasskeyEnrollmentInvitation({ token, password: PASSWORD, now: NOW });
    return { admin, invitation, ticket: enrollmentTicket };
  }
  const options = (ticket, seconds = 5) => generateAdminPasskeyRegistrationOptions({ ticket, now: later(seconds) });
  const verify = (ticket, response, seconds = 10) => verifyAdminPasskeyRegistration({ ticket, response, now: later(seconds) });
  const expectRefused = async (promise) => {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(PasskeyRegistrationError);
    expect(error.code).toBe('invalid_enrollment');
  };

  it('still supports the original activation invitation', async () => {
    process.env.ADMIN_PORTAL_URL = PORTAL;
    const admin = seedAdmin({ status: 'invited', passwordHash: null, passwordChangedAt: null, emailVerifiedAt: null });
    const { token } = seedInvitation(admin, { purpose: 'activation' });
    const { enrollmentTicket } = await acceptActivationInvitation({ token, password: PASSWORD, now: NOW });
    const opts = await options(enrollmentTicket);
    const done = await verify(enrollmentTicket, makeRegistrationResponse({ challenge: opts.challenge }).response);
    expect(done).toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(admin.status).toBe('active');
  });

  it('generates options from a ticket for a redeemed passkey-enrollment invitation', async () => {
    const { admin, invitation, ticket } = await redeemedContext();
    const opts = await options(ticket);
    expect(opts.user.name).toBe(admin.email);
    expect(db.challenges[0]).toMatchObject({ adminId: admin.id, purpose: 'registration', invitationId: invitation.id, consumedAt: null });
  });

  it('verifies a registration with the same ticket and activates the Admin', async () => {
    const { admin, ticket } = await redeemedContext();
    const opts = await options(ticket);
    const auth = makeRegistrationResponse({ challenge: opts.challenge });
    await expect(verify(ticket, auth.response)).resolves.toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(admin.status).toBe('active');
    expect(db.passkeys).toHaveLength(1);
    expect(db.audits.at(-1)).toMatchObject({ event: 'admin_passkey_registered', detail: { invitationId: expect.any(Number) } });
  });

  it('works end to end from the operator command through to an active Admin', async () => {
    const admin = seedAdmin();
    seedAcceptedActivation(admin);
    await resendPasskeyEnrollmentInvitation({ email: admin.email, now: NOW });
    const token = sentToken();
    const { enrollmentTicket } = await redeemAdminPasskeyEnrollmentInvitation({ token, password: PASSWORD, now: later(60) });
    const opts = await options(enrollmentTicket, 65);
    await verify(enrollmentTicket, makeRegistrationResponse({ challenge: opts.challenge }).response, 70);
    expect(admin.status).toBe('active');
    expect(admin.passwordHash).toBe(PASSWORD_HASH); // the password was never changed along the way
  });

  it('refuses a ticket that names a passkey_recovery invitation, in options and verification', async () => {
    const { admin, invitation, ticket } = await redeemedContext();
    invitation.purpose = 'passkey_recovery';
    await expectRefused(options(ticket));
    invitation.purpose = 'passkey_enrollment';
    const opts = await options(ticket);
    const auth = makeRegistrationResponse({ challenge: opts.challenge });
    invitation.purpose = 'passkey_recovery';
    await expectRefused(verify(ticket, auth.response));
    expect(admin.status).toBe('pending_passkey');
    expect(db.passkeys).toHaveLength(0);
    expect(db.challenges[0].consumedAt).toBeNull(); // refused before the challenge was touched
  });

  it('refuses a ticket naming an unknown or differently-purposed invitation', async () => {
    const { invitation, ticket } = await redeemedContext();
    for (const purpose of ['passkey_recovery', 'Passkey_Enrollment', 'admin', '']) {
      invitation.purpose = purpose;
      await expectRefused(options(ticket));
    }
  });

  it('a changed password marker invalidates the ticket', async () => {
    const { admin, ticket } = await redeemedContext();
    admin.passwordChangedAt = new Date(PCA.getTime() + 1);
    await expectRefused(options(ticket));
  });

  it('a revoked invitation invalidates the ticket', async () => {
    const { invitation, ticket } = await redeemedContext();
    invitation.revokedAt = later(1);
    await expectRefused(options(ticket));
  });

  it('an unused invitation invalidates the ticket', async () => {
    const { invitation, ticket } = await redeemedContext();
    invitation.usedAt = null;
    await expectRefused(options(ticket));
  });

  it('an invitation belonging to another Admin invalidates the ticket', async () => {
    const { invitation, ticket } = await redeemedContext();
    invitation.adminId = 999;
    await expectRefused(options(ticket));
  });

  it('a redeemed enrollment invitation cannot be used by an Admin who has gone active or disabled', async () => {
    const { admin, ticket } = await redeemedContext();
    for (const status of ['active', 'disabled', 'invited']) {
      admin.status = status;
      await expectRefused(options(ticket));
    }
  });

  it('a new passkey-enrollment link redeemed later supersedes nothing it should not: the earlier ticket still needs its own state to hold', async () => {
    const { admin, ticket: first } = await redeemedContext();
    const { token: secondToken } = seedInvitation(admin, { createdAt: later(30) });
    const { enrollmentTicket: second } = await redeemAdminPasskeyEnrollmentInvitation({ token: secondToken, password: PASSWORD, now: later(40) });
    const optsSecond = await options(second, 45);
    await expect(verify(second, makeRegistrationResponse({ challenge: optsSecond.challenge }).response, 50)).resolves.toMatchObject({ status: 'active' });
    // After activation the earlier ticket is useless too: the Admin is no longer pending.
    await expectRefused(options(first, 60));
  });
});

describe('inspect does not treat passkey-enrollment invitations as activation links', () => {
  it('reports a passkey_enrollment token as invalid', async () => {
    const admin = seedAdmin({ status: 'invited', passwordHash: null });
    const { token } = seedInvitation(admin); // purpose passkey_enrollment
    expect(await inspectActivationInvitation(token, { now: NOW })).toEqual({ valid: false, state: 'invalid' });
  });

  it('refuses to accept (set a password with) a passkey_enrollment token', async () => {
    const admin = seedAdmin({ status: 'invited', passwordHash: null, passwordChangedAt: null });
    const { token } = seedInvitation(admin);
    await expect(acceptActivationInvitation({ token, password: PASSWORD, now: NOW })).rejects.toMatchObject({ code: 'invalid_invitation' });
    expect(admin.status).toBe('invited');
  });
});

// Hardening of the failed-password limit: attempts are RESERVED (recorded under a lock on the
// invitation) before any password is checked, so parallel guesses cannot exceed the limit and an
// attempt that cannot be recorded is not allowed to proceed.
describe('failed-password attempt limit', () => {
  const ATTEMPT = 'admin_passkey_enrollment_redeem_attempt';
  const redeem = (token, overrides = {}) => redeemAdminPasskeyEnrollmentInvitation({ token, password: PASSWORD, now: NOW, ...overrides });
  const wrong = (token, n = 0) => redeem(token, { password: `WrongGuess2027-${n}` });
  const attempts = () => db.audits.filter((a) => a.event === ATTEMPT);
  const settle = (promises) => Promise.allSettled(promises);
  const expectGenericRejection = (result) => {
    expect(result.status).toBe('rejected');
    expect(result.reason).toBeInstanceOf(InvitationError);
    expect(result.reason).toMatchObject({ code: 'invalid_invitation', state: 'invalid', message: GENERIC_MESSAGE });
  };
  const realHashChecks = (compare) => compare.mock.calls.filter(([, hash]) => hash === PASSWORD_HASH).length;

  async function setup() {
    const admin = seedAdmin();
    seedAcceptedActivation(admin);
    const { token, invitation } = seedInvitation(admin);
    return { admin, token, invitation };
  }

  it('five sequential wrong passwords revoke the invitation, and the right password then fails', async () => {
    const { admin, token, invitation } = await setup();
    for (let i = 1; i <= 4; i += 1) {
      expectGenericRejection((await settle([wrong(token, i)]))[0]);
      expect(invitation.revokedAt).toBeNull(); // still open until the 5th
    }
    expectGenericRejection((await settle([wrong(token, 5)]))[0]);
    expect(invitation.revokedAt).toEqual(NOW);
    expect(attempts()).toHaveLength(5);

    expectGenericRejection((await settle([redeem(token)]))[0]); // correct password, dead link
    expect(invitation.usedAt).toBeNull();
    expect(admin.status).toBe('pending_passkey');
    expect(attempts()).toHaveLength(5); // an unusable link is refused without a new attempt
  });

  it('a correct password still succeeds before the threshold', async () => {
    const { token, invitation } = await setup();
    for (let i = 1; i <= 4; i += 1) await settle([wrong(token, i)]);
    expect(attempts()).toHaveLength(4);
    await expect(redeem(token)).resolves.toMatchObject({ status: 'pending_passkey', nextStep: 'passkey_enrollment' }); // the 5th attempt
    expect(invitation.usedAt).toEqual(NOW);
    expect(attempts()).toHaveLength(5);
  });

  it('a correct password on the first attempt records exactly one attempt', async () => {
    const { token } = await setup();
    await redeem(token);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0].detail).toMatchObject({ attempt: 1 });
  });

  it('parallel wrong passwords cannot get more than five attempts through', async () => {
    const { token, invitation } = await setup();
    const compare = jest.spyOn(bcrypt, 'compare');
    const results = await settle(Array.from({ length: 25 }, (_, i) => wrong(token, i)));
    results.forEach(expectGenericRejection);
    expect(attempts()).toHaveLength(5); // never more than the limit, however many arrive at once
    expect(realHashChecks(compare)).toBe(5); // only five guesses were ever checked against the real hash
    expect(invitation.revokedAt).not.toBeNull();
    expect(invitation.usedAt).toBeNull();
    // and the link is unusable even for the right password
    expectGenericRejection((await settle([redeem(token)]))[0]);
    expect(invitation.usedAt).toBeNull();
  });

  it('a burst that includes the right password still uses at most five attempts in total', async () => {
    const { token, invitation } = await setup();
    const compare = jest.spyOn(bcrypt, 'compare');
    for (let i = 1; i <= 4; i += 1) await settle([wrong(token, i)]);
    const results = await settle([redeem(token), ...Array.from({ length: 6 }, (_, i) => wrong(token, 10 + i))]);
    expect(attempts()).toHaveLength(5); // 4 earlier + exactly 1 more reserved
    expect(realHashChecks(compare)).toBe(5);
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeLessThanOrEqual(1);
    results.filter((r) => r.status === 'rejected').forEach(expectGenericRejection);
    // whichever got the last slot, the link cannot be used again
    expectGenericRejection((await settle([redeem(token)]))[0]);
    expect(invitation.usedAt === null || successes.length === 1).toBe(true);
  });

  it('parallel correct passwords never exceed the limit either (one wins, the rest are refused)', async () => {
    const { token, invitation } = await setup();
    const results = await settle(Array.from({ length: 12 }, () => redeem(token)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts().length).toBeLessThanOrEqual(5);
    expect(invitation.usedAt).toEqual(NOW);
  });

  describe('when the attempt cannot be recorded', () => {
    it('fails closed: no password is checked and no redemption can succeed, even with the right password', async () => {
      const { admin, token, invitation } = await setup();
      const compare = jest.spyOn(bcrypt, 'compare');
      db.failAudit = true;
      for (let i = 0; i < 12; i += 1) {
        const error = await (i % 3 === 0 ? redeem(token) : wrong(token, i)).then(() => null, (e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('audit write failed'); // surfaced, not silently ignored
      }
      expect(realHashChecks(compare)).toBe(0); // the real password hash was never even consulted
      expect(invitation.usedAt).toBeNull();
      expect(admin.status).toBe('pending_passkey');
      expect(attempts()).toHaveLength(0);
      expect(db.events).toContain('rollback');
    });

    it('does not let a storage outage reset or skip the count that was already recorded', async () => {
      const { token, invitation } = await setup();
      for (let i = 1; i <= 3; i += 1) await settle([wrong(token, i)]);
      db.failAudit = true;
      for (let i = 0; i < 5; i += 1) await settle([wrong(token, 50 + i)]);
      db.failAudit = false;
      expect(attempts()).toHaveLength(3); // the outage neither added nor erased any
      await settle([wrong(token, 60)]);
      await settle([wrong(token, 61)]);
      expect(attempts()).toHaveLength(5);
      expect(invitation.revokedAt).not.toBeNull();
    });

    it('also fails closed when counting the attempts fails', async () => {
      const { token, invitation } = await setup();
      const compare = jest.spyOn(bcrypt, 'compare');
      const realTransaction = fake.prisma.$transaction;
      fake.prisma.$transaction = (fn) => realTransaction((tx) => {
        tx.securityEvent.count = async () => { throw new Error('count failed'); };
        return fn(tx);
      });
      try {
        await expect(redeem(token)).rejects.toThrow('count failed');
      } finally {
        fake.prisma.$transaction = realTransaction;
      }
      expect(realHashChecks(compare)).toBe(0);
      expect(invitation.usedAt).toBeNull();
    });

    it('a failed informational record after a wrong password does not weaken the limit', async () => {
      const { token } = await setup();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      // The informational rows are written outside a transaction; make exactly those fail.
      const realRoot = fake.prisma.securityEvent.create;
      fake.prisma.securityEvent.create = async () => { throw new Error('audit write failed'); };
      try {
        for (let i = 1; i <= 5; i += 1) await settle([wrong(token, i)]);
      } finally {
        fake.prisma.securityEvent.create = realRoot;
      }
      expect(attempts()).toHaveLength(5); // reservations are what count, and they committed
      expectGenericRejection((await settle([redeem(token)]))[0]);
    });

    it('still refuses by count when revoking the exhausted link fails', async () => {
      const { token, invitation } = await setup();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const real = fake.prisma.adminInvitation.updateMany;
      fake.prisma.adminInvitation.updateMany = async (args) => {
        if (args.data && args.data.revokedAt instanceof Date) throw new Error('revoke failed');
        return real(args);
      };
      try {
        for (let i = 1; i <= 7; i += 1) expectGenericRejection((await settle([wrong(token, i)]))[0]);
        expectGenericRejection((await settle([redeem(token)]))[0]);
      } finally {
        fake.prisma.adminInvitation.updateMany = real;
      }
      expect(invitation.revokedAt).toBeNull(); // the link was never revoked...
      expect(invitation.usedAt).toBeNull(); // ...but it can no longer be used
      expect(attempts()).toHaveLength(5);
    });
  });

  describe('scope and fresh starts', () => {
    it('does not reserve or count attempts for links that are unusable anyway', async () => {
      const admin = seedAdmin();
      const { token: revoked } = seedInvitation(admin, { revokedAt: later(-60) });
      const { token: expired } = seedInvitation(admin, { expiresAt: later(-1) });
      const { token: used } = seedInvitation(admin, { usedAt: later(-60) });
      for (const t of [revoked, expired, used, newToken(), 'junk']) await settle([redeem(t)]);
      expect(attempts()).toHaveLength(0);
    });

    it('a revoked invitation cannot be redeemed, whatever the password', async () => {
      const { admin, token, invitation } = await setup();
      invitation.revokedAt = later(-1);
      expectGenericRejection((await settle([redeem(token)]))[0]);
      expect(invitation.usedAt).toBeNull();
      expect(admin.status).toBe('pending_passkey');
    });

    it("other Admins' attempts and older invitations' attempts do not count", async () => {
      const { admin, invitation } = await setup();
      const other = seedAdmin({ email: 'other@example.org' });
      for (let i = 0; i < 5; i += 1) db.audits.push({ event: ATTEMPT, actorType: 'admin', actorId: other.id, createdAt: NOW });
      for (let i = 0; i < 5; i += 1) db.audits.push({ event: ATTEMPT, actorType: 'admin', actorId: admin.id, createdAt: new Date(invitation.createdAt.getTime() + 1000) });
      invitation.revokedAt = later(-20);
      const { token } = seedInvitation(admin, { createdAt: later(-10) }); // issued after those attempts
      await expect(redeem(token)).resolves.toMatchObject({ status: 'pending_passkey' });
    });

    it('a new invitation after exhaustion starts a fresh count', async () => {
      const { admin, token } = await setup();
      for (let i = 1; i <= 5; i += 1) await settle([wrong(token, i)]);
      expect(attempts()).toHaveLength(5);
      db.auditClock = later(60);
      const { token: fresh } = seedInvitation(admin, { createdAt: later(120) });
      await expect(redeem(fresh, { now: later(130) })).resolves.toMatchObject({ status: 'pending_passkey' });
    });

    it('uses the policy threshold (5), not a number of its own', () => {
      const { ADMIN_LOCK_POLICY } = require('../src/modules/admin/auth/admin-lock.config');
      expect(ADMIN_LOCK_POLICY.failedLoginThreshold).toBe(5);
    });
  });

  describe('responses', () => {
    it('are identical for wrong password, exhausted, revoked, unknown and malformed', async () => {
      const { token, invitation } = await setup();
      const shapes = new Set();
      const capture = async (attempt) => {
        const error = await attempt().then(() => null, (e) => e);
        shapes.add(JSON.stringify({ name: error.name, code: error.code, state: error.state, message: error.message, keys: Object.keys(error).sort() }));
      };
      await capture(() => wrong(token, 1));
      for (let i = 2; i <= 6; i += 1) await settle([wrong(token, i)]); // exhaust
      await capture(() => redeem(token)); // exhausted/revoked, right password
      invitation.revokedAt = later(-1);
      await capture(() => redeem(token));
      await capture(() => redeem(newToken()));
      await capture(() => redeem('junk'));
      expect(shapes.size).toBe(1);
    });

    it('keep the 24-hour invitation lifetime and the 10-minute ticket lifetime', async () => {
      const admin = seedAdmin();
      seedAcceptedActivation(admin);
      await resendPasskeyEnrollmentInvitation({ email: admin.email, now: NOW });
      expect(db.invitations.at(-1).expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
      const { enrollmentTicket, ticketExpiresInSeconds } = await redeem(sentToken());
      const decoded = jwt.decode(enrollmentTicket);
      expect(decoded.exp - decoded.iat).toBe(600);
      expect(ticketExpiresInSeconds).toBe(600);
    });

    it('never write the password, token, ticket or hash into the attempt records', async () => {
      const { token, invitation } = await setup();
      await settle([wrong(token, 1)]);
      const { enrollmentTicket } = await redeem(token);
      const text = JSON.stringify(db.audits);
      for (const secret of [token, PASSWORD, 'WrongGuess2027-1', enrollmentTicket, invitation.tokenHash, PASSWORD_HASH]) expect(text).not.toContain(secret);
      expect(attempts().every((a) => Object.keys(a.detail).sort().join() === 'attempt,invitationId')).toBe(true);
    });
  });
});
