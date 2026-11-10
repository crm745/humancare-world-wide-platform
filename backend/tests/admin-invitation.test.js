// Admin invitation lifecycle (Step 7.6): inspect, accept + password setup, operator resend and
// revoke, and the CLI. No database: Prisma is the in-memory stand-in from admin-lock-fake-db.js,
// and mail never leaves the process.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fake = require('./admin-lock-fake-db');
const mailer = require('../src/lib/mailer');
const { hashToken } = require('../src/common/utils/token-hash');
const {
  inspectActivationInvitation,
  acceptActivationInvitation,
  InvitationError,
} = require('../src/modules/admin/auth/admin-invitation.service');
const {
  resendActivationInvitation,
  revokeActivationInvitation,
  InvitationOperatorError,
} = require('../src/modules/admin/auth/admin-invitation-operator.service');
const { parseArgs } = require('../scripts/admin-invitation');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const PORTAL = 'https://admin.example.org';
const GOOD_PASSWORD = 'Sunrise2027x';
const ENV_KEYS = ['ADMIN_PORTAL_URL', 'NODE_ENV', 'JWT_ACCESS_SECRET', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const newToken = () => crypto.randomBytes(32).toString('base64url');

function seedAdmin(overrides = {}) {
  const admin = {
    id: db.admins.length + 1,
    name: 'Asha Rao',
    email: 'asha@example.org',
    role: 'admin',
    status: 'invited',
    passwordHash: null,
    passwordChangedAt: null,
    emailVerifiedAt: null,
    failedLoginCount: 0,
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
    purpose: 'activation',
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR),
    usedAt: null,
    revokedAt: null,
    ...overrides,
  };
  db.invitations.push(invitation);
  return { token, invitation };
}

beforeEach(() => {
  fake.reset();
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  process.env.ADMIN_PORTAL_URL = PORTAL;
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-invitation-tests';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('inspectActivationInvitation', () => {
  it('returns only safe display information for a valid invitation', async () => {
    const admin = seedAdmin({ passwordHash: null });
    const { token, invitation } = seedInvitation(admin);
    const result = await inspectActivationInvitation(token, { now: NOW });
    expect(result).toEqual({
      valid: true,
      state: 'valid',
      adminName: 'Asha Rao',
      maskedEmail: 'as•••@example.org',
      purpose: 'activation',
      expiresAt: invitation.expiresAt,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).not.toContain(invitation.tokenHash);
    expect(text).not.toContain('asha@example.org');
    expect(db.audits).toHaveLength(0); // inspecting is not audited (noise)
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a string', 12345],
    ['too short', 'abc'],
    ['wrong characters', `${'a'.repeat(42)}!`],
    ['too long', 'a'.repeat(200)],
  ])('treats a %s token as invalid without touching the database', async (_name, token) => {
    seedInvitation(seedAdmin());
    const result = await inspectActivationInvitation(token, { now: NOW });
    expect(result).toEqual({ valid: false, state: 'invalid' });
    expect(db.events).toEqual([]);
  });

  it('treats an unknown (well-formed) token as invalid', async () => {
    seedInvitation(seedAdmin());
    expect(await inspectActivationInvitation(newToken(), { now: NOW })).toEqual({ valid: false, state: 'invalid' });
  });

  it.each([
    ['expired', { expiresAt: new Date(NOW.getTime() - 1000) }, 'expired'],
    ['expiring exactly now', { expiresAt: NOW }, 'expired'],
    ['already used', { usedAt: new Date(NOW.getTime() - HOUR) }, 'used'],
    ['revoked', { revokedAt: new Date(NOW.getTime() - HOUR) }, 'revoked'],
    ['for another purpose', { purpose: 'passkey_enrollment' }, 'invalid'],
    ['for another email than the admin', { sentToEmail: 'someone.else@example.org' }, 'invalid'],
  ])('rejects an invitation that is %s, revealing no account details', async (_name, overrides, state) => {
    const admin = seedAdmin();
    const { token } = seedInvitation(admin, overrides);
    expect(await inspectActivationInvitation(token, { now: NOW })).toEqual({ valid: false, state });
  });

  it.each([
    ['pending_passkey', { status: 'pending_passkey' }],
    ['active', { status: 'active' }],
    ['disabled', { status: 'disabled' }],
    ['already holding a password', { passwordHash: 'x' }],
  ])('rejects when the admin is %s', async (_name, adminOverrides) => {
    const { token } = seedInvitation(seedAdmin(adminOverrides));
    expect(await inspectActivationInvitation(token, { now: NOW })).toEqual({ valid: false, state: 'invalid' });
  });

  it('rejects an invitation whose admin is missing', async () => {
    const { token } = seedInvitation({ id: 99, email: 'ghost@example.org' });
    expect(await inspectActivationInvitation(token, { now: NOW })).toEqual({ valid: false, state: 'invalid' });
  });

  it('compares the invitation email to the admin email case-insensitively', async () => {
    const { token } = seedInvitation(seedAdmin(), { sentToEmail: 'ASHA@example.org' });
    expect((await inspectActivationInvitation(token, { now: NOW })).valid).toBe(true);
  });
});

describe('acceptActivationInvitation', () => {
  it('sets the password, timestamps and pending_passkey status, and marks the invitation used', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    const result = await acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW });

    expect(result).toEqual({ status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: expect.any(String), ticketExpiresInSeconds: 600 });
    expect(admin.status).toBe('pending_passkey');
    expect(admin.passwordChangedAt).toEqual(NOW);
    expect(admin.emailVerifiedAt).toEqual(NOW);
    expect(admin.passwordHash).toEqual(expect.any(String));
    expect(admin.passwordHash).not.toContain(GOOD_PASSWORD);
    expect(await bcrypt.compare(GOOD_PASSWORD, admin.passwordHash)).toBe(true);
    expect(invitation.usedAt).toEqual(NOW);
    expect(invitation.revokedAt).toBeNull();
  });

  it('issues no token or session of any kind', async () => {
    const { token } = seedInvitation(seedAdmin());
    const result = await acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW });
    expect(Object.keys(result).sort()).toEqual(['enrollmentTicket', 'nextStep', 'status', 'ticketExpiresInSeconds']);
    for (const key of Object.keys(result)) expect(key).not.toMatch(/access|refresh|session|cookie|jwt|bearer|password|hash|adminId|challenge/i);
  });

  it('writes the audit event in the same transaction, without secrets', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    await acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW, context: { ipAddress: '203.0.113.5', userAgent: 'jest' } });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      event: 'admin_invitation_accepted',
      actorType: 'admin',
      actorId: admin.id,
      identifier: 'as•••@example.org',
      ipAddress: '203.0.113.5',
      userAgent: 'jest',
      detail: { invitationId: invitation.id, newStatus: 'pending_passkey' },
    });
    const text = JSON.stringify(db.audits);
    expect(text).not.toContain(token);
    expect(text).not.toContain(invitation.tokenHash);
    expect(text).not.toContain(GOOD_PASSWORD);
    expect(text).not.toContain(admin.passwordHash);
    // audit sits between the state changes and the commit
    expect(db.events.slice(-2)).toEqual(['audit.create', 'commit']);
  });

  it.each([
    ['too short', 'Ab1'],
    ['no digit', 'OnlyLettersHere'],
    ['no letter', '1234567890'],
    ['over 72 bytes', `Aa1${'x'.repeat(75)}`],
    ['missing', undefined],
    ['not a string', 12345678],
  ])('rejects a password that is %s and leaves the invitation usable', async (_name, password) => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    await expect(acceptActivationInvitation({ token, password, now: NOW })).rejects.toMatchObject({ code: 'weak_password' });
    expect(admin.status).toBe('invited');
    expect(admin.passwordHash).toBeNull();
    expect(invitation.usedAt).toBeNull();
    expect(db.events).toEqual([]);
  });

  it('is single-use: a second acceptance with the same link fails and changes nothing', async () => {
    const admin = seedAdmin();
    const { token } = seedInvitation(admin);
    await acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW });
    const hashAfterFirst = admin.passwordHash;
    const error = await acceptActivationInvitation({ token, password: 'Different2027y', now: NOW }).catch((e) => e);
    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({ code: 'invalid_invitation', state: 'used' });
    expect(admin.passwordHash).toBe(hashAfterFirst);
  });

  it.each([
    ['unknown', null, 'invalid'],
    ['expired', { expiresAt: new Date(NOW.getTime() - 1) }, 'expired'],
    ['used', { usedAt: new Date(NOW.getTime() - HOUR) }, 'used'],
    ['revoked', { revokedAt: new Date(NOW.getTime() - HOUR) }, 'revoked'],
    ['for another purpose', { purpose: 'passkey_recovery' }, 'invalid'],
    ['for a mismatched email', { sentToEmail: 'other@example.org' }, 'invalid'],
  ])('rejects a %s invitation without changing the admin', async (_name, overrides, state) => {
    const admin = seedAdmin();
    const { token } = overrides ? seedInvitation(admin, overrides) : { token: newToken() };
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ code: 'invalid_invitation', state });
    expect(admin.status).toBe('invited');
    expect(admin.passwordHash).toBeNull();
  });

  it('rejects an admin whose status is not invited', async () => {
    const admin = seedAdmin({ status: 'disabled' });
    const { token } = seedInvitation(admin);
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ state: 'invalid' });
    expect(admin.status).toBe('disabled');
  });

  it('serialises concurrent acceptances: exactly one wins, once', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    const results = await Promise.allSettled([
      acceptActivationInvitation({ token, password: 'FirstChoice2027a', now: NOW }),
      acceptActivationInvitation({ token, password: 'SecondChoice2027b', now: NOW }),
      acceptActivationInvitation({ token, password: 'ThirdChoice2027c', now: NOW }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(2);
    for (const loser of losers) expect(loser.reason).toMatchObject({ code: 'invalid_invitation' });
    expect(db.audits.filter((a) => a.event === 'admin_invitation_accepted')).toHaveLength(1);
    expect(invitation.usedAt).toEqual(NOW);
    expect(admin.status).toBe('pending_passkey');
    // the stored password is the winner's, whichever it was
    const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
    const winnerPassword = ['FirstChoice2027a', 'SecondChoice2027b', 'ThirdChoice2027c'][winnerIndex];
    expect(await bcrypt.compare(winnerPassword, admin.passwordHash)).toBe(true);
  });

  it('loses cleanly when the invitation is taken between the read and the claim (race window)', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    // Right after the in-transaction read (the second read of the invitation), another request
    // consumes it - so the read said "valid" but the conditional claim must find it taken.
    let reads = 0;
    db.afterRead = async (table) => {
      if (table !== 'invitations') return;
      reads += 1;
      if (reads === 2) invitation.usedAt = NOW;
    };
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ code: 'invalid_invitation' });
    expect(admin.status).toBe('invited');
    expect(admin.passwordHash).toBeNull();
    expect(db.audits.filter((a) => a.event === 'admin_invitation_accepted')).toHaveLength(0);
  });

  it('rolls back every change when the audit write fails', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    db.failAudit = true;
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toThrow('audit write failed');
    expect(admin.status).toBe('invited');
    expect(admin.passwordHash).toBeNull();
    expect(admin.passwordChangedAt).toBeNull();
    expect(admin.emailVerifiedAt).toBeNull();
    expect(invitation.usedAt).toBeNull();
    expect(db.events).toContain('rollback');
    // and the invitation still works once audit recovers
    db.failAudit = false;
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).resolves.toBeDefined();
  });

  it('revokes any other open activation invitation of the same admin', async () => {
    const admin = seedAdmin();
    const { token } = seedInvitation(admin);
    const { invitation: stray } = seedInvitation(admin);
    await acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW });
    expect(stray.revokedAt).toEqual(NOW);
  });

  describe('rejected attempts', () => {
    it('audit a rejected attempt on a real invitation, with reason and ids only', async () => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin, { revokedAt: new Date(NOW.getTime() - HOUR) });
      await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ state: 'revoked' });
      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({
        event: 'admin_invitation_accept_failed',
        actorType: 'admin',
        actorId: admin.id,
        detail: { reason: 'revoked', invitationId: invitation.id },
      });
      const text = JSON.stringify(db.audits);
      expect(text).not.toContain(token);
      expect(text).not.toContain(invitation.tokenHash);
      expect(text).not.toContain(GOOD_PASSWORD);
    });

    it('do not audit unknown or malformed tokens (no log flooding)', async () => {
      seedInvitation(seedAdmin());
      await expect(acceptActivationInvitation({ token: newToken(), password: GOOD_PASSWORD, now: NOW })).rejects.toBeInstanceOf(InvitationError);
      await expect(acceptActivationInvitation({ token: 'junk', password: GOOD_PASSWORD, now: NOW })).rejects.toBeInstanceOf(InvitationError);
      expect(db.audits).toHaveLength(0);
    });

    it('stay denied, with the same error, even if the audit write fails', async () => {
      const { token } = seedInvitation(seedAdmin(), { usedAt: new Date(NOW.getTime() - HOUR) });
      db.failAudit = true;
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ code: 'invalid_invitation', state: 'used' });
      expect(error.mock.calls.flat().join(' ')).not.toContain(token);
    });

    it('never report acceptance, and never hash a password, for a bad link', async () => {
      const hashSpy = jest.spyOn(bcrypt, 'hash');
      await expect(acceptActivationInvitation({ token: newToken(), password: GOOD_PASSWORD, now: NOW })).rejects.toBeInstanceOf(InvitationError);
      expect(hashSpy).not.toHaveBeenCalled();
    });
  });
});

describe('resendActivationInvitation', () => {
  it('revokes the open invitations, stores only the hash of a fresh 32-byte token, and expires in 72 hours', async () => {
    const admin = seedAdmin();
    const { token: oldToken, invitation: old } = seedInvitation(admin);
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    const result = await resendActivationInvitation({ email: ' ASHA@Example.org ', now: NOW });

    expect(randomBytes).toHaveBeenCalledWith(32);
    const token = randomBytes.mock.results.find((r) => r.value.length === 32).value.toString('base64url');
    expect(db.admins).toHaveLength(1); // no second account
    expect(old.revokedAt).toEqual(NOW);
    expect(result.revokedCount).toBe(1);
    const fresh = db.invitations.find((i) => i !== old);
    expect(fresh).toMatchObject({
      adminId: admin.id, purpose: 'activation', sentToEmail: 'asha@example.org', usedAt: null, revokedAt: null,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(NOW.getTime() + 72 * HOUR),
    });
    expect(fresh.tokenHash).not.toBe(old.tokenHash);
    expect(JSON.stringify(db)).not.toContain(token);
    expect(result).toMatchObject({ emailDelivered: true, emailError: null });

    // the old link is dead, the new one works
    expect((await inspectActivationInvitation(oldToken, { now: NOW })).state).toBe('revoked');
    expect((await inspectActivationInvitation(token, { now: NOW })).valid).toBe(true);
  });

  it('emails the new link (fragment form, sensitive) only after the commit', async () => {
    seedAdmin();
    await resendActivationInvitation({ email: 'asha@example.org', now: NOW });
    expect(db.events.slice(-3)).toEqual(['audit.create', 'commit', 'email']);
    const message = mailer.sendMail.mock.calls[0][0];
    expect(message.sensitive).toBe(true);
    expect(message.to).toBe('asha@example.org');
    expect(message.text).toMatch(new RegExp(`${PORTAL}/accept-invite#token=[A-Za-z0-9_-]{43}`));
    expect(message.text).not.toContain('?token');
  });

  it('audits the resend in the same transaction, as an operator, without secrets', async () => {
    const admin = seedAdmin();
    seedInvitation(admin);
    await resendActivationInvitation({ email: admin.email, now: NOW });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ event: 'admin_invitation_resent', actorType: 'operator', actorId: null });
    expect(db.audits[0].detail).toMatchObject({ adminId: admin.id, revokedInvitationCount: 1 });
    expect(Object.keys(db.audits[0].detail.operator).sort()).toEqual(['hostname', 'username']);
    const sent = mailer.sendMail.mock.calls[0][0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    expect(JSON.stringify(db.audits)).not.toContain(sent);
    expect(JSON.stringify(db.audits)).not.toContain(hashToken(sent));
  });

  it('rolls everything back, and sends nothing, when the audit write fails', async () => {
    const admin = seedAdmin();
    const { invitation: old } = seedInvitation(admin);
    db.failAudit = true;
    await expect(resendActivationInvitation({ email: admin.email, now: NOW })).rejects.toThrow('audit write failed');
    expect(old.revokedAt).toBeNull();
    expect(db.invitations).toHaveLength(1);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('keeps the new invitation when the email fails, and reports it', async () => {
    const admin = seedAdmin();
    const { invitation: old } = seedInvitation(admin);
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));
    const result = await resendActivationInvitation({ email: admin.email, now: NOW });
    expect(result).toMatchObject({ emailDelivered: false, emailError: 'SMTP connection refused' });
    expect(db.invitations).toHaveLength(2);
    expect(old.revokedAt).toEqual(NOW);
    expect(db.events).not.toContain('rollback');
  });

  it('works for an admin with no earlier invitation', async () => {
    seedAdmin();
    const result = await resendActivationInvitation({ email: 'asha@example.org', now: NOW });
    expect(result.revokedCount).toBe(0);
    expect(db.invitations).toHaveLength(1);
  });

  it.each([
    ['unknown', null, 'admin_not_found'],
    ['pending_passkey', { status: 'pending_passkey' }, 'not_invited'],
    ['active', { status: 'active' }, 'not_invited'],
    ['disabled', { status: 'disabled' }, 'not_invited'],
  ])('refuses an admin that is %s', async (_name, overrides, code) => {
    if (overrides) seedAdmin(overrides);
    await expect(resendActivationInvitation({ email: 'asha@example.org', now: NOW })).rejects.toMatchObject({ name: 'InvitationOperatorError', code });
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('refuses an invalid ADMIN_PORTAL_URL before changing anything', async () => {
    const admin = seedAdmin();
    const { invitation } = seedInvitation(admin);
    delete process.env.ADMIN_PORTAL_URL;
    await expect(resendActivationInvitation({ email: admin.email, now: NOW })).rejects.toThrow('ADMIN_PORTAL_URL');
    expect(invitation.revokedAt).toBeNull();
    expect(db.events).toEqual([]);
  });

  it('never logs the raw token or the link', async () => {
    seedAdmin();
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    mailer.sendMail.mockRejectedValue(new Error('boom'));
    const result = await resendActivationInvitation({ email: 'asha@example.org', now: NOW });
    const output = spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n') + JSON.stringify(result);
    expect(output).not.toContain('accept-invite');
    expect(output).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});

describe('revokeActivationInvitation', () => {
  it('revokes the open invitation but keeps the history and the admin', async () => {
    const admin = seedAdmin();
    const { invitation } = seedInvitation(admin);
    const { invitation: used } = seedInvitation(admin, { usedAt: new Date(NOW.getTime() - HOUR) });
    const result = await revokeActivationInvitation({ email: ' Asha@Example.org', now: NOW });
    expect(result).toEqual({ admin: { id: admin.id, name: 'Asha Rao', email: 'asha@example.org', role: 'admin' }, revokedCount: 1 });
    expect(invitation.revokedAt).toEqual(NOW);
    expect(used.revokedAt).toBeNull(); // history untouched
    expect(db.invitations).toHaveLength(2);
    expect(db.admins).toEqual([admin]);
    expect(admin.status).toBe('invited');
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('makes the revoked link unusable', async () => {
    const admin = seedAdmin();
    const { token } = seedInvitation(admin);
    await revokeActivationInvitation({ email: admin.email, now: NOW });
    expect((await inspectActivationInvitation(token, { now: NOW })).state).toBe('revoked');
    await expect(acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW })).rejects.toMatchObject({ state: 'revoked' });
  });

  it('audits as an operator in the same transaction, with ids only', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    await revokeActivationInvitation({ email: admin.email, now: NOW });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ event: 'admin_invitation_revoked', actorType: 'operator', actorId: null });
    expect(db.audits[0].detail).toMatchObject({ adminId: admin.id, invitationIds: [invitation.id], revokedInvitationCount: 1 });
    const text = JSON.stringify(db.audits);
    expect(text).not.toContain(token);
    expect(text).not.toContain(invitation.tokenHash);
    expect(db.events.slice(-2)).toEqual(['audit.create', 'commit']);
  });

  it('rolls the revocation back when the audit write fails', async () => {
    const admin = seedAdmin();
    const { invitation } = seedInvitation(admin);
    db.failAudit = true;
    await expect(revokeActivationInvitation({ email: admin.email, now: NOW })).rejects.toThrow('audit write failed');
    expect(invitation.revokedAt).toBeNull();
  });

  it.each([
    ['unknown admin', null, [], 'admin_not_found'],
    ['already activated', { status: 'pending_passkey' }, [{}], 'not_invited'],
    ['nothing outstanding', {}, [], 'no_open_invitation'],
    ['only a used invitation', {}, [{ usedAt: new Date(NOW.getTime() - HOUR) }], 'no_open_invitation'],
    ['only a revoked invitation', {}, [{ revokedAt: new Date(NOW.getTime() - HOUR) }], 'no_open_invitation'],
  ])('rejects: %s', async (_name, adminOverrides, invitations, code) => {
    if (adminOverrides) {
      const admin = seedAdmin(adminOverrides);
      invitations.forEach((o) => seedInvitation(admin, o));
    }
    const before = JSON.stringify(db.invitations);
    await expect(revokeActivationInvitation({ email: 'asha@example.org', now: NOW })).rejects.toMatchObject({ name: 'InvitationOperatorError', code });
    expect(JSON.stringify(db.invitations)).toBe(before);
    expect(db.audits).toHaveLength(0);
  });
});

describe('scripts/admin-invitation.js', () => {
  it('parses resend and revoke, normalising the email', () => {
    expect(parseArgs(['resend', '--email', ' Asha@Example.org '])).toEqual({ command: 'resend', email: 'asha@example.org' });
    expect(parseArgs(['revoke', '--email=asha@example.org'])).toEqual({ command: 'revoke', email: 'asha@example.org' });
  });

  it.each([
    ['no arguments', []],
    ['an unknown command', ['delete', '--email', 'a@b.co']],
    ['no email', ['resend']],
    ['an email option without a value', ['resend', '--email']],
    ['a repeated email', ['resend', '--email', 'a@b.co', '--email', 'c@d.co']],
    ['an unknown option', ['resend', '--email', 'a@b.co', '--token', 'x']],
    ['an invalid email', ['revoke', '--email', 'nope']],
  ])('rejects %s', (_name, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('never prints a token, hash or link when run end to end through the services', async () => {
    seedAdmin();
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    await resendActivationInvitation({ email: 'asha@example.org', now: NOW });
    await revokeActivationInvitation({ email: 'asha@example.org', now: NOW });
    const output = spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
    expect(output).not.toContain('accept-invite');
    expect(output).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(InvitationOperatorError).toBeDefined();
  });
});

describe('enrollment ticket issued by acceptance', () => {
  const jwt = require('jsonwebtoken');
  const { readAdminEnrollmentTicket, enrollmentTicketMatches } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
  const { readAdminLoginTicket, ADMIN_LOGIN_FLOWS } = require('../src/modules/admin/auth/admin-login-ticket.service');
  const { verifyAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');

  const accept = (token, overrides = {}) => acceptActivationInvitation({ token, password: GOOD_PASSWORD, now: NOW, ...overrides });
  const expectInvalid = async (promise, state) => {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({ code: 'invalid_invitation', ...(state ? { state } : {}) });
    expect(error).not.toHaveProperty('enrollmentTicket');
  };

  it('returns a 600-second ticket bound to the Admin, the accepted invitation and the persisted password timestamp', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    const result = await accept(token);

    const decoded = jwt.decode(result.enrollmentTicket);
    expect(decoded.exp - decoded.iat).toBe(600);
    expect(result.ticketExpiresInSeconds).toBe(600);
    expect(Object.keys(decoded).sort()).toEqual(['aud', 'exp', 'flow', 'iat', 'inv', 'iss', 'jti', 'pca', 'sub']);
    expect(decoded).toMatchObject({ flow: 'passkey_enrollment', sub: String(admin.id), inv: invitation.id, pca: admin.passwordChangedAt.getTime() });

    const claims = readAdminEnrollmentTicket(result.enrollmentTicket);
    expect(claims).toMatchObject({ adminId: admin.id, invitationId: invitation.id, passwordChangedAt: admin.passwordChangedAt });
    expect(enrollmentTicketMatches(claims, { admin, invitationId: invitation.id })).toBe(true);
    expect(invitation.usedAt).toEqual(NOW); // the invitation the ticket names is the one that was accepted
  });

  it('carries the timestamp exactly as persisted, to the millisecond', async () => {
    const admin = seedAdmin();
    const { token } = seedInvitation(admin);
    const withMillis = new Date('2027-03-01T10:00:00.123Z');
    const { enrollmentTicket } = await accept(token, { now: withMillis });
    expect(admin.passwordChangedAt.getTime()).toBe(withMillis.getTime());
    expect(readAdminEnrollmentTicket(enrollmentTicket).passwordChangedAt.getTime()).toBe(withMillis.getTime());
  });

  it('uses the value the database holds, not the clock the caller passed', async () => {
    const admin = seedAdmin();
    const { token, invitation } = seedInvitation(admin);
    // A database with coarser precision would store a rounded value; the ticket must follow the stored one.
    const realTransaction = fake.prisma.$transaction;
    fake.prisma.$transaction = (fn) => realTransaction((tx) => {
      const update = tx.adminUser.updateMany;
      tx.adminUser.updateMany = async (args) => {
        if (args.data && args.data.passwordChangedAt) {
          const rounded = new Date(Math.floor(args.data.passwordChangedAt.getTime() / 1000) * 1000);
          args = { ...args, data: { ...args.data, passwordChangedAt: rounded } };
        }
        return update(args);
      };
      return fn(tx);
    });
    let result;
    try {
      result = await accept(token, { now: new Date('2027-03-01T10:00:00.789Z') });
    } finally {
      fake.prisma.$transaction = realTransaction;
    }
    const claims = readAdminEnrollmentTicket(result.enrollmentTicket);
    expect(claims.passwordChangedAt.getTime()).toBe(admin.passwordChangedAt.getTime());
    expect(claims.passwordChangedAt.getTime()).toBe(new Date('2027-03-01T10:00:00.000Z').getTime());
    expect(enrollmentTicketMatches(claims, { admin, invitationId: invitation.id })).toBe(true);
  });

  it('is not an access token and not a login ticket', async () => {
    const { token } = seedInvitation(seedAdmin());
    const { enrollmentTicket } = await accept(token);
    expect(verifyAdminAccessToken(enrollmentTicket)).toBeNull();
    expect(() => jwt.verify(enrollmentTicket, process.env.JWT_ACCESS_SECRET)).toThrow();
    for (const flow of Object.values(ADMIN_LOGIN_FLOWS)) expect(readAdminLoginTicket(enrollmentTicket, flow)).toBeNull();
  });

  it('expires after 600 seconds', async () => {
    const { token } = seedInvitation(seedAdmin());
    const { enrollmentTicket } = await accept(token);
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 599 * 1000);
    expect(readAdminEnrollmentTicket(enrollmentTicket)).not.toBeNull();
    Date.now.mockReturnValue(start + 601 * 1000);
    expect(readAdminEnrollmentTicket(enrollmentTicket)).toBeNull();
  });

  it("is bound to the invitation that was accepted: another Admin's ticket does not match", async () => {
    const first = seedAdmin();
    const second = seedAdmin({ email: 'second@example.org' });
    const { token: firstToken, invitation: firstInvitation } = seedInvitation(first);
    const { token: secondToken, invitation: secondInvitation } = seedInvitation(second);
    const { enrollmentTicket } = await accept(firstToken);
    await accept(secondToken);
    const claims = readAdminEnrollmentTicket(enrollmentTicket);
    expect(claims.adminId).toBe(first.id);
    expect(enrollmentTicketMatches(claims, { admin: first, invitationId: firstInvitation.id })).toBe(true);
    expect(enrollmentTicketMatches(claims, { admin: second, invitationId: secondInvitation.id })).toBe(false);
    expect(enrollmentTicketMatches(claims, { admin: first, invitationId: secondInvitation.id })).toBe(false);
  });

  describe('no ticket without a successful acceptance', () => {
    it.each([
      ['expired', { expiresAt: new Date(NOW.getTime() - 1) }, 'expired'],
      ['revoked', { revokedAt: new Date(NOW.getTime() - HOUR) }, 'revoked'],
      ['already used', { usedAt: new Date(NOW.getTime() - HOUR) }, 'used'],
      ['for another purpose', { purpose: 'passkey_enrollment' }, 'invalid'],
      ["sent to a different address than the Admin's", { sentToEmail: 'someone.else@example.org' }, 'invalid'],
    ])('rejects a %s invitation', async (_name, overrides, state) => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin, overrides);
      await expectInvalid(accept(token), state);
      expect(admin.status).toBe('invited');
    });

    it('rejects an unknown token', async () => {
      seedInvitation(seedAdmin());
      await expectInvalid(accept(newToken()), 'invalid');
    });

    it.each(['pending_passkey', 'active', 'disabled'])('rejects an Admin whose status is %s', async (status) => {
      const admin = seedAdmin({ status });
      const { token } = seedInvitation(admin);
      await expectInvalid(accept(token), 'invalid');
      expect(admin.status).toBe(status);
    });

    it('rejects an invitation that points at an Admin it was not sent to (cannot mint a ticket for another Admin)', async () => {
      const owner = seedAdmin();
      const other = seedAdmin({ email: 'other@example.org' });
      const { token } = seedInvitation(owner, { adminId: other.id }); // sentToEmail is the owner's
      await expectInvalid(accept(token), 'invalid');
      expect(other.status).toBe('invited');
      expect(owner.status).toBe('invited');
    });

    it.each([[null], [undefined], [''], ['short1'], ['nodigitsatall'], [12345678], [{}]])('rejects password %p without touching the invitation', async (password) => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      await expect(accept(token, { password })).rejects.toMatchObject({ code: 'weak_password' });
      expect(invitation.usedAt).toBeNull();
      expect(admin.status).toBe('invited');
      expect(db.events).toEqual([]);
    });

    it('rolls back and returns no ticket when the Admin activation fails', async () => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      const realTransaction = fake.prisma.$transaction;
      fake.prisma.$transaction = (fn) => realTransaction((tx) => {
        const update = tx.adminUser.updateMany;
        tx.adminUser.updateMany = async (args) => (args.data && args.data.status === 'pending_passkey' ? { count: 0 } : update(args));
        return fn(tx);
      });
      try {
        await expectInvalid(accept(token));
      } finally {
        fake.prisma.$transaction = realTransaction;
      }
      expect(invitation.usedAt).toBeNull(); // the claim was rolled back
      expect(admin.status).toBe('invited');
      expect(admin.passwordHash).toBeNull();
      expect(db.events).toContain('rollback');
    });

    it('rolls back and returns no ticket when the audit write fails', async () => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      db.failAudit = true;
      const error = await accept(token).then(() => null, (e) => e);
      expect(error.message).toBe('audit write failed');
      expect(error).not.toHaveProperty('enrollmentTicket');
      expect(invitation.usedAt).toBeNull();
      expect(admin.status).toBe('invited');
      expect(admin.passwordHash).toBeNull();
      expect(admin.passwordChangedAt).toBeNull();
    });

    it('rolls back everything when the ticket cannot be signed, leaving the invitation usable', async () => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      delete process.env.JWT_ACCESS_SECRET; // signing fails
      await expect(accept(token)).rejects.toThrow('JWT_ACCESS_SECRET is not set');
      expect(invitation.usedAt).toBeNull();
      expect(invitation.revokedAt).toBeNull();
      expect(admin.status).toBe('invited');
      expect(admin.passwordHash).toBeNull();
      expect(admin.emailVerifiedAt).toBeNull();
      expect(db.audits).toHaveLength(0); // no "accepted" audit row for an acceptance that did not happen
      expect(db.events).toContain('rollback');
      // Fixing the fault lets the same link work: nothing was consumed.
      process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-invitation-tests';
      const result = await accept(token);
      expect(result.enrollmentTicket).toEqual(expect.any(String));
      expect(admin.status).toBe('pending_passkey');
    });

    it('does not hand out a ticket until the transaction has committed', async () => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin);
      const realTransaction = fake.prisma.$transaction;
      let committedWhenTransactionReturned = false;
      fake.prisma.$transaction = async (fn) => {
        const value = await realTransaction(fn);
        committedWhenTransactionReturned = db.events.at(-1) === 'commit';
        return value;
      };
      try {
        await accept(token);
      } finally {
        fake.prisma.$transaction = realTransaction;
      }
      expect(committedWhenTransactionReturned).toBe(true);
    });
  });

  describe('concurrency and replay', () => {
    it('lets exactly one of several simultaneous acceptances win, and only the winner gets a ticket', async () => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin);
      const passwords = ['FirstChoice2027a', 'SecondChoice2027b', 'ThirdChoice2027c', 'FourthChoice2027d'];
      const results = await Promise.allSettled(passwords.map((password) => accept(token, { password })));
      const winners = results.filter((r) => r.status === 'fulfilled');
      const losers = results.filter((r) => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(winners[0].value.enrollmentTicket).toEqual(expect.any(String));
      expect(losers).toHaveLength(3);
      for (const loser of losers) {
        expect(loser.reason).toBeInstanceOf(InvitationError);
        expect(loser.reason).toMatchObject({ code: 'invalid_invitation' });
        expect(loser.reason).not.toHaveProperty('enrollmentTicket');
        expect(loser.reason.message).toBe('This invitation link is not valid.');
      }
      expect(db.audits.filter((a) => a.event === 'admin_invitation_accepted')).toHaveLength(1);
    });

    it('cannot be replayed: a second acceptance of the same link gets no ticket', async () => {
      const admin = seedAdmin();
      const { token } = seedInvitation(admin);
      await accept(token);
      const hashAfterFirst = admin.passwordHash;
      await expectInvalid(accept(token, { password: 'Different2027y' }), 'used');
      expect(admin.passwordHash).toBe(hashAfterFirst);
    });

    it('a ticket from an earlier acceptance dies when the password marker changes', async () => {
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      const { enrollmentTicket } = await accept(token);
      admin.passwordChangedAt = new Date(admin.passwordChangedAt.getTime() + 1);
      expect(enrollmentTicketMatches(readAdminEnrollmentTicket(enrollmentTicket), { admin, invitationId: invitation.id })).toBe(false);
    });
  });

  describe('nothing sensitive leaks', () => {
    it('creates no access token, refresh token, cookie or session', async () => {
      const { token } = seedInvitation(seedAdmin());
      const result = await accept(token);
      expect(Object.keys(result).sort()).toEqual(['enrollmentTicket', 'nextStep', 'status', 'ticketExpiresInSeconds']);
      expect(db.sessions).toHaveLength(0);
      expect(db.refreshTokens).toHaveLength(0);
      expect(verifyAdminAccessToken(result.enrollmentTicket)).toBeNull();
    });

    it('keeps the raw token, the password and the ticket out of audit rows and logs', async () => {
      const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
      const admin = seedAdmin();
      const { token, invitation } = seedInvitation(admin);
      const { enrollmentTicket } = await accept(token, { context: { ipAddress: '203.0.113.5', userAgent: 'jest' } });
      // and a refused attempt on the now-used link, whose audit write fails
      db.failAudit = true;
      await accept(token).catch(() => {});
      const everywhere = JSON.stringify(db.audits) + spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
      for (const secret of [token, GOOD_PASSWORD, enrollmentTicket, invitation.tokenHash, admin.passwordHash]) {
        expect(everywhere).not.toContain(secret);
      }
    });

    it('does not store the ticket anywhere', async () => {
      const { token } = seedInvitation(seedAdmin());
      const { enrollmentTicket } = await accept(token);
      expect(JSON.stringify(db)).not.toContain(enrollmentTicket);
    });
  });

  it('end to end: the issued ticket drives passkey registration and activation', async () => {
    process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
    process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
    process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
    const { generateAdminPasskeyRegistrationOptions, verifyAdminPasskeyRegistration } = require('../src/modules/admin/auth/admin-webauthn-registration.service');
    const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');

    const admin = seedAdmin();
    const { token } = seedInvitation(admin);
    const { enrollmentTicket } = await accept(token, { now: new Date('2027-03-01T10:00:00.456Z') });
    expect(admin.status).toBe('pending_passkey'); // accepted, but not yet usable

    const options = await generateAdminPasskeyRegistrationOptions({ ticket: enrollmentTicket, now: new Date('2027-03-01T10:00:05.000Z') });
    const auth = makeRegistrationResponse({ challenge: options.challenge });
    const done = await verifyAdminPasskeyRegistration({ ticket: enrollmentTicket, response: auth.response, now: new Date('2027-03-01T10:00:10.000Z') });
    expect(done).toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(admin.status).toBe('active');
    expect(db.passkeys).toHaveLength(1);
  });
});
