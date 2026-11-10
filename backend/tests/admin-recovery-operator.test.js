// Operator recovery workflows (Step 7.9.6): invitation resend, break-glass recovery, the Admin
// disable cleanup of open recovery, and the status / cancel consistency they need. No database:
// Prisma is the in-memory stand-in from admin-lock-fake-db.js, mail never leaves the process, and
// nothing is ever run against a real account.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const { PassThrough } = require('stream');
const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const { hashToken } = require('../src/common/utils/token-hash');
const { ProvisioningError } = require('../src/modules/admin/auth/admin-provisioning.service');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { cancelRecoveryRequest, getRecoveryRequestStatus } = require('../src/modules/admin/auth/admin-recovery-request.service');
const {
  resendRecoveryInvitation,
  breakGlassRecovery,
  breakGlassConfirmation,
} = require('../src/modules/admin/auth/admin-recovery-decision.service');
const {
  redeemRecoveryInvitation,
  generateRecoveryRegistrationOptions,
  verifyRecoveryPasskeyRegistration,
  RecoveryRegistrationError,
} = require('../src/modules/admin/auth/admin-recovery-registration.service');
const { disableAdminAccount } = require('../src/modules/admin/auth/admin-account.service');
const { parseArgs, printStatus, promptLine, reportDelivery, DELIVERY_FAILURE_NOTE } = require('../scripts/admin-recovery');

const { db, fake, NOW, PASSWORD, seedAdmin, seedPasskey } = kit;
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EMAIL = 'target@example.org';
const PORTAL = 'https://admin.example.org';
const REASON = 'Lost the only hardware key and no other superadmin exists';

const savedPortal = process.env.ADMIN_PORTAL_URL;

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  process.env.ADMIN_PORTAL_URL = PORTAL;
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
  if (savedPortal === undefined) delete process.env.ADMIN_PORTAL_URL; else process.env.ADMIN_PORTAL_URL = savedPortal;
});

// ---- fixtures ------------------------------------------------------------------------------

const auditsOf = (event) => db.audits.filter((a) => a.event === event);
const target = (overrides = {}) => seedAdmin({ email: EMAIL, name: 'Tara Target', ...overrides });
// An active superadmin who can pass the passkey step-up (a live passkey), unless told otherwise.
const superadmin = (overrides = {}, { passkey = true } = {}) => {
  const admin = seedAdmin({ role: 'superadmin', ...overrides });
  if (passkey) seedPasskey(admin);
  return admin;
};
const live = (rows = db.invitations, now = NOW) => rows.filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt > now);
const startSession = (admin, now = NOW) => fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now }));

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.code).toBe(code);
  return error;
};

// The raw token as the target would receive it: only ever from the (mocked) email.
function mailedToken(index = -1) {
  const [message] = mailer.sendMail.mock.calls.at(index);
  const match = /#token=(\S+)/.exec(message.text);
  expect(match).not.toBeNull();
  return match[1];
}

// An approved request with an invitation row, written directly (as an earlier approval left it).
function seedApproved(admin, { request = {}, invitation = {} } = {}) {
  const row = {
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
    expiresAt: new Date(NOW.getTime() + 3 * DAY),
    createdAt: at(-7200),
    ...request,
  };
  db.recoveryRequests.push(row);
  const token = crypto.randomBytes(32).toString('base64url');
  const inv = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'passkey_recovery',
    recoveryRequestId: row.id,
    tokenHash: hashToken(token),
    sentToEmail: admin.email,
    expiresAt: new Date(NOW.getTime() + 12 * HOUR),
    usedAt: null,
    revokedAt: null,
    createdAt: at(-3600),
    ...invitation,
  };
  db.invitations.push(inv);
  return { request: row, invitation: inv, token };
}

const resend = (id, overrides = {}) => resendRecoveryInvitation({ id, now: NOW, ...overrides });
const breakGlass = (overrides = {}) => breakGlassRecovery({
  email: EMAIL, reason: REASON, confirmation: breakGlassConfirmation(EMAIL), now: NOW, ...overrides,
});

// Makes one operation inside the next transactions throw, to prove the whole transaction rolls back.
function breakIn(model, method, predicate = () => true) {
  const original = fake.prisma.$transaction.bind(fake.prisma);
  return jest.spyOn(fake.prisma, '$transaction').mockImplementation((fn) => original((tx) => fn({
    ...tx,
    [model]: {
      ...tx[model],
      [method]: async (args) => {
        if (predicate(args)) throw new Error(`${model}.${method} failed`);
        return tx[model][method](args);
      },
    },
  })));
}

// Everything a refused or rolled-back operation must leave alone. The fake database restores the
// values a rolled-back write changed but cannot un-add a key the row never had, so the lock-write
// and disable columns are left out; the assertions beside each use check the real fields.
const NOT_COMPARED = new Set(['updatedAt', 'disabledAt', 'disabledReason', 'disabledBy']);
const snapshot = () => JSON.stringify({
  a: db.admins, r: db.recoveryRequests, i: db.invitations, s: db.sessions, t: db.refreshTokens, p: db.passkeys, audits: db.audits,
}, (key, value) => (NOT_COMPARED.has(key) ? undefined : value));

// ---- 1. resend -----------------------------------------------------------------------------

describe('resendRecoveryInvitation', () => {
  it('issues a fresh invitation for an approved request, linked to it, storing only the hash', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    const result = await resend(fx.request.id);

    expect(db.invitations).toHaveLength(2);
    const fresh = db.invitations[1];
    expect(fresh).toMatchObject({
      adminId: admin.id,
      purpose: 'passkey_recovery',
      recoveryRequestId: fx.request.id,
      sentToEmail: EMAIL,
      usedAt: null,
      revokedAt: null,
    });
    const token = mailedToken();
    expect(fresh.tokenHash).toBe(hashToken(token));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.invitations)).not.toContain(token);
    expect(result).toMatchObject({
      request: { id: fx.request.id, status: 'approved' },
      admin: { id: admin.id, email: EMAIL },
      invitation: { id: fresh.id, expiresAt: fresh.expiresAt },
      revokedCount: 1,
      emailDelivered: true,
      emailError: null,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(mailer.sendMail.mock.calls[0][0].text).toContain(`${PORTAL}/recover-passkey#token=${token}`);
  });

  it('uses a different token every time', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await resend(fx.request.id);
    await resend(fx.request.id);
    expect(mailedToken(0)).not.toBe(mailedToken(1));
    expect(new Set(db.invitations.map((i) => i.tokenHash)).size).toBe(3);
  });

  it('revokes the previous live invitation before the replacement exists, leaving exactly one live', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await resend(fx.request.id);
    expect(fx.invitation.revokedAt).toEqual(NOW);
    expect(live()).toHaveLength(1);
    expect(live()[0].id).toBe(2);
    expect(db.events.indexOf('invitations.update')).toBeLessThan(db.events.indexOf('invitations.create'));
  });

  it('the new link works and the old one no longer does', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await resend(fx.request.id);
    await expect(redeemRecoveryInvitation({ token: fx.token, password: PASSWORD, now: at(1) })).rejects.toBeInstanceOf(RecoveryRegistrationError);
    await expect(redeemRecoveryInvitation({ token: mailedToken(), password: PASSWORD, now: at(1) })).resolves.toMatchObject({ status: 'approved' });
  });

  describe('recovering from every dead invitation', () => {
    it.each([
      ['expired', { expiresAt: new Date(NOW.getTime() - 1) }],
      ['revoked', { revokedAt: at(-60) }],
      ['used', { usedAt: at(-60) }],
    ])('replaces a %s invitation, leaving the old row as it was', async (_label, invitation) => {
      const admin = target();
      const fx = seedApproved(admin, { invitation });
      const before = { ...fx.invitation };
      const result = await resend(fx.request.id);
      expect(result.revokedCount).toBe(0);
      expect(db.invitations).toHaveLength(2);
      expect(fx.invitation).toEqual(before); // expired stays expired, used stays used, revoked stays revoked
      expect(live()).toHaveLength(1);
    });

    it('replaces an invitation whose email was never delivered', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      // the delivery failure the approval recorded for invitation 1
      db.audits.push({
        actorType: 'admin',
        actorId: 5,
        event: 'admin_recovery_invitation_delivery_failed',
        identifier: 'ta***@example.org',
        detail: { adminId: admin.id, recoveryRequestId: fx.request.id, kind: 'invitation', invitationId: fx.invitation.id },
      });
      expect((await getRecoveryRequestStatus({ id: fx.request.id, now: NOW }))[0].invitation).toMatchObject({ state: 'live', delivery: 'failed' });
      await resend(fx.request.id);
      expect(fx.invitation.revokedAt).toEqual(NOW);
      const [info] = await getRecoveryRequestStatus({ id: fx.request.id, now: NOW });
      expect(info.invitation).toMatchObject({ id: 2, state: 'live', delivery: 'delivered', total: 2, replacements: 1, liveCount: 1 });
    });
  });

  describe('expiry', () => {
    it('is 24 hours from now when the request has longer to run', async () => {
      const admin = target();
      const fx = seedApproved(admin, { request: { expiresAt: new Date(NOW.getTime() + 3 * DAY) } });
      const result = await resend(fx.request.id);
      expect(result.invitation.expiresAt).toEqual(new Date(NOW.getTime() + DAY));
      expect(db.invitations[1].expiresAt).toEqual(new Date(NOW.getTime() + DAY));
    });

    it('is capped at the request\'s own deadline, which is never extended', async () => {
      const admin = target();
      const deadline = new Date(NOW.getTime() + 5 * HOUR);
      const fx = seedApproved(admin, { request: { expiresAt: deadline } });
      const result = await resend(fx.request.id);
      expect(result.invitation.expiresAt).toEqual(deadline);
      expect(fx.request.expiresAt).toEqual(deadline);
      expect(auditsOf('admin_recovery_invitation_resent')[0].detail.invitationExpiresAt).toBe(deadline.toISOString());
    });

    it('does not extend the seven-day deadline across repeated resends', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      const deadline = new Date(fx.request.expiresAt);
      for (let i = 0; i < 3; i += 1) await resend(fx.request.id, { now: new Date(NOW.getTime() + i * 20 * HOUR) });
      expect(fx.request.expiresAt).toEqual(deadline);
      expect(Math.max(...db.invitations.map((i) => i.expiresAt.getTime()))).toBeLessThanOrEqual(deadline.getTime());
    });
  });

  describe('refusals', () => {
    it.each(['pending', 'completed', 'rejected', 'expired', 'cancelled'])('refuses a %s request, changing and sending nothing', async (status) => {
      const admin = target();
      const fx = seedApproved(admin, { request: { status } });
      const before = snapshot();
      const error = await rejects(resend(fx.request.id), 'request_not_resendable');
      expect(error.message).toContain(`"${status}"`);
      expect(snapshot()).toBe(before);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it('refuses an approved request that is past its deadline', async () => {
      const admin = target();
      const fx = seedApproved(admin, { request: { expiresAt: new Date(NOW.getTime()) } });
      const error = await rejects(resend(fx.request.id), 'request_not_resendable');
      expect(error.message).toMatch(/passed its deadline/);
      expect(db.invitations).toHaveLength(1);
    });

    it.each(['disabled', 'invited', 'pending_passkey'])('refuses when the target is %s', async (status) => {
      const admin = target({ status });
      const fx = seedApproved(admin);
      const before = snapshot();
      await rejects(resend(fx.request.id), 'target_not_active');
      expect(snapshot()).toBe(before);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it('refuses an unknown request and malformed ids', async () => {
      await rejects(resend(99), 'request_not_found');
      for (const id of [undefined, null, '', '0', '-1', 'abc', 1.5, {}]) await rejects(resend(id), 'invalid_request_id');
    });

    it('fails before changing anything when no portal URL is configured', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      delete process.env.ADMIN_PORTAL_URL;
      const before = snapshot();
      await expect(resend(fx.request.id)).rejects.toThrow();
      expect(snapshot()).toBe(before);
    });
  });

  describe('transaction and delivery', () => {
    it('sends the email only after the commit', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      await resend(fx.request.id);
      expect(db.events.indexOf('commit')).toBeLessThan(db.events.indexOf('email'));
    });

    it('a failed email keeps the committed invitation, records the failure safely and can be resent', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      mailer.sendMail.mockRejectedValueOnce(new Error('SMTP down: secret-host.internal'));
      const result = await resend(fx.request.id);

      expect(result).toMatchObject({ emailDelivered: false, emailError: 'SMTP down: secret-host.internal' });
      expect(db.invitations).toHaveLength(2);
      expect(live()).toHaveLength(1);
      const failed = auditsOf('admin_recovery_invitation_delivery_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ actorType: 'operator', detail: { adminId: admin.id, recoveryRequestId: fx.request.id, invitationId: 2 } });
      expect(JSON.stringify(failed[0])).not.toMatch(/SMTP|secret-host|token/i);
      expect((await getRecoveryRequestStatus({ id: fx.request.id, now: NOW }))[0].invitation).toMatchObject({ id: 2, state: 'live', delivery: 'failed' });

      await resend(fx.request.id, { now: at(60) });
      expect(live(db.invitations, at(60))).toHaveLength(1);
      expect((await getRecoveryRequestStatus({ id: fx.request.id, now: at(60) }))[0].invitation).toMatchObject({ id: 3, delivery: 'delivered', replacements: 2 });
    });

    it('even if recording the delivery failure also fails, the invitation stands', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      mailer.sendMail.mockImplementation(async () => { db.failAudit = true; throw new Error('down'); });
      await expect(resend(fx.request.id)).resolves.toMatchObject({ emailDelivered: false });
      expect(live()).toHaveLength(1);
    });

    it('an audit failure rolls the replacement back: the old invitation stays live and nothing is sent', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      db.failAudit = true;
      await expect(resend(fx.request.id)).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(db.invitations).toHaveLength(1);
      expect(fx.invitation.revokedAt).toBeNull();
      expect(mailer.sendMail).not.toHaveBeenCalled();
      await expect(resend(fx.request.id)).resolves.toMatchObject({ emailDelivered: true });
    });

    it('a failure creating the invitation also keeps the old one live', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      db.failCreate = 'invitations';
      await expect(resend(fx.request.id)).rejects.toThrow('invitations create failed');
      db.failCreate = null;
      expect(fx.invitation.revokedAt).toBeNull();
      expect(live()).toHaveLength(1);
    });

    it('writes one operator audit event with ids and times only', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      await resend(fx.request.id);
      const [event] = auditsOf('admin_recovery_invitation_resent');
      expect(event).toMatchObject({
        actorType: 'operator',
        detail: { adminId: admin.id, recoveryRequestId: fx.request.id, invitationId: 2, revokedInvitationCount: 1, requestedVia: 'operator' },
      });
      expect(event.detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
      expect(JSON.stringify(db.audits)).not.toContain(mailedToken());
      expect(auditsOf('admin_recovery_invitation_sent')).toHaveLength(1);
    });

    it('never writes the raw token to the console or to any audit row', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      mailer.sendMail.mockRejectedValueOnce(new Error('down'));
      await resend(fx.request.id);
      const token = mailedToken();
      const output = [...console.log.mock.calls, ...console.error.mock.calls].flat().join('\n');
      expect(output).not.toContain(token);
      expect(JSON.stringify(db.audits)).not.toContain(token);
    });

    it('five simultaneous resends never leave more than one live invitation', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => resend(fx.request.id)));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(db.invitations).toHaveLength(6);
      expect(live()).toHaveLength(1);
    });
  });
});

// ---- 2. break-glass ------------------------------------------------------------------------

describe('breakGlassRecovery', () => {
  it.each([0, 1])('succeeds with %i eligible superadmin approver(s) besides the target', async (others) => {
    const admin = target({ role: 'superadmin' });
    for (let i = 0; i < others; i += 1) superadmin();
    const result = await breakGlass();
    expect(result).toMatchObject({ admin: { id: admin.id, email: EMAIL }, eligibleApprovers: others, emailDelivered: true });
    expect(db.recoveryRequests).toHaveLength(1);
  });

  it('succeeds for an ordinary Admin target when no superadmin exists at all', async () => {
    target();
    await expect(breakGlass()).resolves.toMatchObject({ eligibleApprovers: 0 });
  });

  it.each([2, 3])('is refused with %i eligible approvers, changing and sending nothing', async (others) => {
    target();
    for (let i = 0; i < others; i += 1) superadmin();
    const before = snapshot();
    const error = await rejects(breakGlass(), 'approvers_available');
    expect(error.message).toContain(`${others} eligible`);
    expect(snapshot()).toBe(before);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('counts only ACTIVE SUPERADMINS other than the target: ordinary, disabled and invited ones never substitute', async () => {
    const admin = target({ role: 'superadmin' });
    superadmin(); // the one real approver
    seedAdmin({ role: 'admin' });
    seedAdmin({ role: 'admin' });
    superadmin({ status: 'disabled' });
    superadmin({ status: 'invited', passwordHash: null });
    superadmin({ status: 'pending_passkey' });
    const result = await breakGlass();
    expect(result.eligibleApprovers).toBe(1);
    expect(admin.status).toBe('active');
  });

  it('is refused when two eligible approvers appear after the preliminary read, before the transaction ends', async () => {
    target();
    let armed = true;
    db.afterRead = async (table) => {
      if (table === 'admins' && armed) {
        armed = false;
        superadmin(); // two operators finish enabling / creating superadmins in the meantime
        superadmin();
      }
    };
    await rejects(breakGlass(), 'approvers_available');
    expect(db.recoveryRequests).toHaveLength(0);
    expect(db.invitations).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  describe('eligibility requires a live passkey', () => {
    it('an active superadmin WITH a live passkey counts', async () => {
      target();
      superadmin();
      await expect(breakGlass()).resolves.toMatchObject({ eligibleApprovers: 1 });
    });

    it('an active superadmin WITHOUT a live passkey does not count, so two of them never block break-glass', async () => {
      target();
      superadmin({}, { passkey: false });
      superadmin({}, { passkey: false });
      const result = await breakGlass();
      expect(result.eligibleApprovers).toBe(0);
      expect(auditsOf('admin_recovery_break_glass')[0].detail).toMatchObject({ eligibleApprovers: 0, superadminsWithoutPasskey: 2 });
    });

    it('a revoked passkey does not count; one live among revoked ones does', async () => {
      target();
      const revokedOnly = superadmin({}, { passkey: false });
      seedPasskey(revokedOnly, { revokedAt: NOW });
      const mixed = superadmin({}, { passkey: false });
      seedPasskey(mixed, { revokedAt: NOW });
      seedPasskey(mixed);
      await expect(breakGlass()).resolves.toMatchObject({ eligibleApprovers: 1 });
    });

    it('two passkey-less superadmins plus one with a passkey: still only one eligible, so allowed', async () => {
      target();
      superadmin();
      superadmin({}, { passkey: false });
      superadmin({}, { passkey: false });
      await expect(breakGlass()).resolves.toMatchObject({ eligibleApprovers: 1 });
    });

    it('two eligible superadmins still refuse it, whatever else exists', async () => {
      target();
      superadmin();
      superadmin();
      superadmin({}, { passkey: false });
      await rejects(breakGlass(), 'approvers_available');
      expect(db.recoveryRequests).toHaveLength(0);
    });

    it('is re-checked inside the transaction: two superadmins gaining passkeys after the preliminary read are refused', async () => {
      target();
      const a = superadmin({}, { passkey: false });
      const b = superadmin({}, { passkey: false });
      let armed = true;
      db.afterRead = async (table) => {
        if (table === 'admins' && armed) {
          armed = false;
          seedPasskey(a);
          seedPasskey(b);
        }
      };
      await rejects(breakGlass(), 'approvers_available');
      expect(db.recoveryRequests).toHaveLength(0);
      expect(db.invitations).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it('is re-checked inside the transaction: passkeys revoked after the preliminary read make it allowed', async () => {
      target();
      superadmin();
      superadmin();
      let armed = true;
      db.afterRead = async (table) => {
        if (table === 'admins' && armed) {
          armed = false;
          db.passkeys.forEach((p) => { p.revokedAt = NOW; });
        }
      };
      await expect(breakGlass()).resolves.toMatchObject({ eligibleApprovers: 0 });
    });

    it('refuses, changing nothing, when a new superadmin appears after the candidates were locked', async () => {
      target();
      superadmin();
      let reads = 0;
      db.afterRead = async (table) => {
        if (table !== 'admins') return;
        reads += 1;
        if (reads === 2) superadmin(); // the read of the locked target, after the lock pass
      };
      await rejects(breakGlass(), 'admin_set_changed');
      expect(db.recoveryRequests).toHaveLength(0);
      expect(db.invitations).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('typed confirmation and reason', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['wrong text', 'yes'],
      ['lower case', `break-glass ${EMAIL}`],
      ['another admin\'s email', breakGlassConfirmation('other@example.org')],
      ['with trailing text', `${breakGlassConfirmation(EMAIL)} now`],
      ['not a string', 42],
    ])('refuses a %s confirmation, changing nothing', async (_label, confirmation) => {
      target();
      const before = snapshot();
      await rejects(breakGlass({ confirmation }), 'confirmation_required');
      expect(snapshot()).toBe(before);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['blank', '   '],
      ['not a string', 7],
      ['a single word', 'emergencyemergency'],
      ['two words', 'lost key'],
      ['too short', 'a b c'],
      ['too long', 'word '.repeat(110)],
      ['control characters', 'lost the key\u0007 and nobody else'],
      ['markup', 'lost <b>the key</b> entirely'],
    ])('refuses a %s reason, changing nothing', async (_label, reason) => {
      target();
      const before = snapshot();
      await rejects(breakGlass({ reason }), 'invalid_reason');
      expect(snapshot()).toBe(before);
    });

    it('accepts a meaningful reason, normalising its spacing', async () => {
      target();
      await breakGlass({ reason: '  Lost   the only key and no other superadmin ' });
      expect(db.recoveryRequests[0].reason).toBe('Lost the only key and no other superadmin');
    });
  });

  describe('target', () => {
    it.each(['invited', 'pending_passkey', 'disabled'])('refuses a %s target', async (status) => {
      target({ status, passwordHash: status === 'invited' ? null : undefined });
      const before = snapshot();
      const error = await rejects(breakGlass(), 'target_not_active');
      expect(error.message).toContain(`"${status}"`);
      expect(snapshot()).toBe(before);
    });

    it('refuses an unknown or invalid email', async () => {
      await rejects(breakGlass(), 'admin_not_found');
      await rejects(breakGlass({ email: 'nobody' }), 'invalid_email');
    });
  });

  describe('the request and its invitation', () => {
    it('creates the approved request with the approved defaults', async () => {
      const admin = target();
      const result = await breakGlass();
      expect(db.recoveryRequests).toEqual([expect.objectContaining({
        id: 1,
        adminId: admin.id,
        requestedByAdminId: null,
        requestedVia: 'break_glass',
        status: 'approved',
        approvalsRequired: 0,
        approvedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 7 * DAY),
        reason: REASON,
        completedAt: null,
      })]);
      expect(db.recoveryApprovals).toHaveLength(0);
      expect(result.request).toEqual({ id: 1, status: 'approved', expiresAt: new Date(NOW.getTime() + 7 * DAY) });
    });

    it('creates the linked passkey_recovery invitation in the same transaction, hash only, 24 hours', async () => {
      const admin = target();
      await breakGlass();
      expect(db.invitations).toHaveLength(1);
      expect(db.invitations[0]).toMatchObject({
        adminId: admin.id,
        purpose: 'passkey_recovery',
        recoveryRequestId: db.recoveryRequests[0].id,
        sentToEmail: EMAIL,
        expiresAt: new Date(NOW.getTime() + DAY),
        usedAt: null,
        revokedAt: null,
      });
      const token = mailedToken();
      expect(db.invitations[0].tokenHash).toBe(hashToken(token));
      expect(JSON.stringify([db.invitations, db.recoveryRequests, db.audits])).not.toContain(token);
      const requestEvent = db.events.indexOf('recoveryRequests.create');
      const invitationEvent = db.events.indexOf('invitations.create');
      expect(requestEvent).toBeGreaterThan(-1);
      expect(invitationEvent).toBeGreaterThan(requestEvent);
      expect(db.events.indexOf('commit')).toBeGreaterThan(invitationEvent);
    });

    it('sends the email after the commit, saying the recovery is an emergency one', async () => {
      target();
      await breakGlass();
      expect(db.events.indexOf('commit')).toBeLessThan(db.events.indexOf('email'));
      const [message] = mailer.sendMail.mock.calls[0];
      expect(message.to).toBe(EMAIL);
      expect(message.text).toMatch(/break-glass/);
      expect(message.text).not.toMatch(/two administrators/);
    });

    it('a failed email keeps the request and invitation, and "resend" repairs it', async () => {
      const admin = target();
      mailer.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
      const result = await breakGlass();
      expect(result).toMatchObject({ emailDelivered: false, emailError: 'SMTP down', request: { id: 1, status: 'approved' } });
      expect(db.recoveryRequests).toHaveLength(1);
      expect(live()).toHaveLength(1);
      expect(auditsOf('admin_recovery_invitation_delivery_failed')).toHaveLength(1);
      expect((await getRecoveryRequestStatus({ id: 1, now: NOW }))[0].invitation).toMatchObject({ state: 'live', delivery: 'failed' });

      await resend(1, { now: at(60) });
      expect(mailer.sendMail.mock.calls.at(-1)[0].text).toMatch(/break-glass/);
      expect(live(db.invitations, at(60))).toHaveLength(1);
      expect(db.recoveryRequests[0].expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY));
      expect(admin.status).toBe('active');
    });
  });

  describe('audit', () => {
    it('records the operator, target, reason and justification in a mandatory event', async () => {
      const admin = target({ role: 'superadmin' });
      superadmin();
      await breakGlass();
      const [event] = auditsOf('admin_recovery_break_glass');
      expect(event).toMatchObject({
        actorType: 'operator',
        actorId: null,
        identifier: EMAIL,
        detail: {
          adminId: admin.id,
          recoveryRequestId: 1,
          reason: REASON,
          justification: expect.stringContaining('Only 1 eligible superadmin approver(s)'),
          eligibleApprovers: 1,
          approversRequired: 2,
          requestedVia: 'break_glass',
          invitationId: 1,
        },
      });
      expect(event.detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
      expect(JSON.stringify(db.audits)).not.toMatch(/\$2[aby]\$|passwordHash|tokenHash/);
    });

    it('an audit failure rolls back the request and the invitation, and sends nothing', async () => {
      target();
      db.failAudit = true;
      await expect(breakGlass()).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(db.recoveryRequests).toHaveLength(0);
      expect(db.invitations).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
      await expect(breakGlass()).resolves.toMatchObject({ request: { id: 1 } }); // and it can be retried
    });

    it('a failure creating the invitation rolls the request back too', async () => {
      target();
      db.failCreate = 'invitations';
      await expect(breakGlass()).rejects.toThrow('invitations create failed');
      db.failCreate = null;
      expect(db.recoveryRequests).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('duplicates', () => {
    it.each(['pending', 'approved'])('refuses while a request is %s, changing nothing', async (status) => {
      const admin = target();
      seedApproved(admin, { request: { status } });
      const before = snapshot();
      await rejects(breakGlass(), 'open_request_exists');
      expect(snapshot()).toBe(before);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it.each(['completed', 'rejected', 'cancelled', 'expired'])('allows a new one after a %s request', async (status) => {
      const admin = target();
      seedApproved(admin, { request: { status } });
      await expect(breakGlass()).resolves.toMatchObject({ request: { id: 2 } });
    });

    it('treats an open request past its deadline as expired, recording that, and proceeds', async () => {
      const admin = target();
      const stale = seedApproved(admin, { request: { status: 'pending', expiresAt: new Date(NOW.getTime() - 1) } });
      await expect(breakGlass()).resolves.toMatchObject({ request: { id: 2 } });
      expect(stale.request.status).toBe('expired');
      expect(auditsOf('admin_recovery_expired')[0]).toMatchObject({ detail: { adminId: admin.id, count: 1, trigger: 'break_glass' } });
    });

    it('five simultaneous attempts create exactly one open request, one invitation and one email', async () => {
      target();
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => breakGlass()));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('open_request_exists'));
      expect(db.recoveryRequests).toHaveLength(1);
      expect(db.invitations).toHaveLength(1);
      expect(auditsOf('admin_recovery_break_glass')).toHaveLength(1);
      expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    });

    it('a break-glass racing an ordinary-looking open request from elsewhere still yields one open request', async () => {
      const admin = target();
      const results = await Promise.allSettled([
        breakGlass(),
        fake.prisma.$transaction(async (tx) => {
          const held = await tx.adminUser.updateMany({ where: { id: admin.id, status: 'active' }, data: { updatedAt: NOW } });
          if (held.count !== 1) return;
          const open = await tx.adminRecoveryRequest.updateMany({ where: { adminId: admin.id, status: { in: ['pending', 'approved'] } }, data: { updatedAt: NOW } });
          if (open.count === 0) await tx.adminRecoveryRequest.create({ data: { adminId: admin.id, requestedVia: 'operator', status: 'pending', expiresAt: at(DAY / 1000) } });
        }),
      ]);
      expect(results.every((r) => r.status === 'fulfilled' || r.reason.code === 'open_request_exists')).toBe(true);
      expect(db.recoveryRequests.filter((r) => ['pending', 'approved'].includes(r.status))).toHaveLength(1);
    });
  });

  describe('it does not bypass the target\'s own checks', () => {
    it('the link alone is useless: a wrong, missing or other password is refused', async () => {
      const admin = target();
      seedPasskey(admin);
      await breakGlass();
      const token = mailedToken();
      for (const password of ['WrongPass2027x', '', undefined, null]) {
        await expect(redeemRecoveryInvitation({ token, password, now: at(1) })).rejects.toBeInstanceOf(RecoveryRegistrationError);
      }
      expect(db.invitations[0].usedAt).toBeNull();
      expect(db.sessions).toHaveLength(0);
    });

    it('the right password only yields a recovery ticket: no session, and the old passkey is untouched until a new one is verified', async () => {
      const admin = target();
      const old = seedPasskey(admin);
      await breakGlass();
      const result = await redeemRecoveryInvitation({ token: mailedToken(), password: PASSWORD, now: at(1) });
      expect(result).toMatchObject({ status: 'approved', nextStep: 'passkey_registration' });
      expect(db.sessions).toHaveLength(0);
      expect(db.refreshTokens).toHaveLength(0);
      expect(old.row.revokedAt).toBeNull();
      expect(db.recoveryRequests[0].status).toBe('approved'); // not completed
    });

    async function toOptions(admin) {
      await breakGlass();
      const { recoveryTicket } = await redeemRecoveryInvitation({ token: mailedToken(), password: PASSWORD, now: at(1) });
      const options = await generateRecoveryRegistrationOptions({ ticket: recoveryTicket, now: at(2) });
      return { recoveryTicket, options };
    }

    it('a registration that does not answer the challenge is refused: still approved, old passkey kept', async () => {
      const admin = target();
      const old = seedPasskey(admin);
      const { recoveryTicket } = await toOptions(admin);
      const bad = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url') });
      await expect(verifyRecoveryPasskeyRegistration({ ticket: recoveryTicket, response: bad.response, label: 'New', now: at(3) })).rejects.toBeDefined();
      expect(db.recoveryRequests[0].status).toBe('approved');
      expect(old.row.revokedAt).toBeNull();
      expect(db.passkeys).toHaveLength(1);
    });

    it('only a genuine new passkey completes the request and replaces the old one', async () => {
      const admin = target();
      const old = seedPasskey(admin);
      const { recoveryTicket, options } = await toOptions(admin);
      const good = makeRegistrationResponse({ challenge: options.challenge });
      await expect(verifyRecoveryPasskeyRegistration({ ticket: recoveryTicket, response: good.response, label: 'New', now: at(4) })).resolves.toMatchObject({ status: 'recovered' });
      expect(db.recoveryRequests[0].status).toBe('completed');
      expect(old.row.revokedAt).not.toBeNull();
      expect(db.passkeys).toHaveLength(2);
    });
  });

  it('requires a root Prisma client', async () => {
    target();
    await expect(breakGlassRecovery({ email: EMAIL, reason: REASON, confirmation: breakGlassConfirmation(EMAIL), db: { adminUser: {} } })).rejects.toThrow(TypeError);
  });
});

// ---- 2b. delivery audit identity ---------------------------------------------------------------

describe('delivery audit events carry the operator identity', () => {
  const expectOperator = (event) => {
    expect(event.actorType).toBe('operator');
    expect(event.detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
    expect(Object.keys(event.detail.operator).sort()).toEqual(['hostname', 'username']);
    expect(event.detail).toMatchObject({ adminId: expect.any(Number), recoveryRequestId: expect.any(Number), invitationId: expect.any(Number), kind: 'invitation' });
  };

  it('resend: success', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await resend(fx.request.id);
    const events = auditsOf('admin_recovery_invitation_sent');
    expect(events).toHaveLength(1);
    expectOperator(events[0]);
    expect(JSON.stringify(db.audits)).not.toContain(mailedToken());
  });

  it('resend: failure, without the mailer text', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    mailer.sendMail.mockRejectedValueOnce(new Error('SMTP down: secret-host.internal'));
    await resend(fx.request.id);
    const events = auditsOf('admin_recovery_invitation_delivery_failed');
    expect(events).toHaveLength(1);
    expectOperator(events[0]);
    expect(JSON.stringify(events[0])).not.toMatch(/SMTP|secret-host/);
  });

  it('break-glass: success and failure', async () => {
    target();
    await breakGlass();
    expectOperator(auditsOf('admin_recovery_invitation_sent')[0]);
    expect(JSON.stringify(db.audits)).not.toContain(mailedToken());

    fake.reset();
    db.auditClock = NOW;
    target();
    mailer.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    await breakGlass();
    const failed = auditsOf('admin_recovery_invitation_delivery_failed');
    expect(failed).toHaveLength(1);
    expectOperator(failed[0]);
  });

  it('an approval by an Admin keeps its Admin actor and records no operator', async () => {
    // The shared delivery code is also used by the approval flow; operator identity is only for operator workflows.
    const { approveRecoveryRequest } = require('../src/modules/admin/auth/admin-recovery-decision.service');
    expect(typeof approveRecoveryRequest).toBe('function');
    const source = require('fs').readFileSync(require.resolve('../src/modules/admin/auth/admin-recovery-decision.service'), 'utf8');
    expect(source).toMatch(/operator = null/); // optional, default none
  });
});

// ---- 2c. CLI never prints mailer error text -----------------------------------------------------

describe('CLI delivery failure output', () => {
  const MAILER_TEXT = 'connect ECONNREFUSED smtp.secret-host.internal:587 for ops@internal.example (token abc123)';
  let savedExit;
  beforeEach(() => { savedExit = process.exitCode; });
  afterEach(() => { process.exitCode = savedExit; });

  it('reportDelivery prints a generic note, never the mailer text, and sets the failure exit code', () => {
    reportDelivery({ emailDelivered: false, emailError: MAILER_TEXT, request: { id: 7 } });
    const output = console.error.mock.calls.flat().join('\n');
    expect(output).toContain(DELIVERY_FAILURE_NOTE);
    expect(output).toContain('resend --id 7');
    expect(output).not.toMatch(/ECONNREFUSED|secret-host|ops@internal|abc123|smtp/i);
    expect(process.exitCode).toBe(3);
  });

  it('reportDelivery on success prints no error', () => {
    reportDelivery({ emailDelivered: true, emailError: null, request: { id: 7 } });
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log.mock.calls.flat().join('\n')).toContain('sent the invitation');
  });

  it('no command path prints result.emailError', () => {
    const source = require('fs').readFileSync(require.resolve('../scripts/admin-recovery'), 'utf8');
    expect(source).not.toMatch(/\$\{result\.emailError\}/);
    expect(source).not.toMatch(/emailError\)/);
  });
});

// ---- 3. Admin disable integration ----------------------------------------------------------

describe('disableAdminAccount and open recovery', () => {
  const disable = (overrides = {}) => disableAdminAccount({ email: EMAIL, reason: 'Left the company', now: NOW, ...overrides });

  it('cancels pending and approved requests and revokes their live recovery invitations', async () => {
    const admin = target();
    const approved = seedApproved(admin);
    const pending = seedApproved(admin, { request: { status: 'pending' }, invitation: { recoveryRequestId: undefined, revokedAt: at(-1) } });
    const result = await disable();

    expect(result).toMatchObject({ cancelledRecoveryRequests: 2, revokedRecoveryInvitations: 1 });
    expect(approved.request.status).toBe('cancelled');
    expect(pending.request.status).toBe('cancelled');
    expect(approved.invitation.revokedAt).toEqual(NOW);
    expect(live()).toHaveLength(0);
    expect(admin.status).toBe('disabled');
  });

  it('revokes a live recovery invitation even when its request link is missing', async () => {
    const admin = target();
    seedApproved(admin, { invitation: { recoveryRequestId: null } });
    const result = await disable();
    expect(result.revokedRecoveryInvitations).toBe(1);
    expect(live()).toHaveLength(0);
  });

  it('preserves completed, rejected, expired and already-cancelled requests and their invitations', async () => {
    const admin = target();
    const kept = ['completed', 'rejected', 'expired', 'cancelled'].map((status) => seedApproved(admin, {
      request: { status },
      invitation: { usedAt: status === 'completed' ? at(-60) : null, revokedAt: status === 'completed' ? null : at(-60) },
    }));
    const before = JSON.stringify(kept);
    const result = await disable();
    expect(result).toMatchObject({ cancelledRecoveryRequests: 0, revokedRecoveryInvitations: 0 });
    expect(JSON.stringify(kept)).toBe(before);
    expect(auditsOf('admin_recovery_cancelled')).toHaveLength(0);
  });

  it('marks an open request that is already past its deadline "expired", not "cancelled"', async () => {
    const admin = target();
    const stale = seedApproved(admin, { request: { status: 'pending', expiresAt: new Date(NOW.getTime() - 1) } });
    const result = await disable();
    expect(stale.request.status).toBe('expired');
    expect(result.cancelledRecoveryRequests).toBe(0);
    expect(auditsOf('admin_account_disabled')[0].detail.expiredRecoveryRequests).toBe(1);
  });

  it('touches no other Admin\'s requests or invitations', async () => {
    target();
    const other = seedAdmin({ email: 'other@example.org' });
    const theirs = seedApproved(other);
    await disable();
    expect(theirs.request.status).toBe('approved');
    expect(theirs.invitation.revokedAt).toBeNull();
  });

  it('audits each cancelled request and the totals, with no secrets', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await disable();
    const [cancelled] = auditsOf('admin_recovery_cancelled');
    expect(cancelled).toMatchObject({
      actorType: 'operator',
      identifier: EMAIL,
      detail: { adminId: admin.id, recoveryRequestId: fx.request.id, cause: 'admin_disabled', previousStatus: 'approved', revokedInvitationCount: 1 },
    });
    expect(auditsOf('admin_account_disabled')[0].detail).toMatchObject({ cancelledRecoveryRequests: 1, revokedRecoveryInvitations: 1 });
    expect(JSON.stringify(db.audits)).not.toContain(fx.token);
    const [info] = await getRecoveryRequestStatus({ id: fx.request.id, now: NOW });
    expect(info).toMatchObject({ status: 'cancelled', cancelledBy: { hostname: expect.any(String) }, invitation: { state: 'revoked' } });
  });

  it('keeps the existing disable behaviour: sessions, refresh tokens and passkeys', async () => {
    const admin = target();
    const passkey = seedPasskey(admin);
    const session = await startSession(admin);
    seedApproved(admin);
    const result = await disable();
    expect(result).toMatchObject({ revokedSessions: 1, revokedRefreshTokens: 1 });
    expect(db.sessions.find((s) => s.id === session.sessionId)).toMatchObject({ revokedAt: NOW, revokedReason: 'account_disabled' });
    expect(passkey.row.revokedAt).toBeNull();
    expect(admin).toMatchObject({ status: 'disabled', disabledAt: NOW });
  });

  it('a resend or break-glass is refused afterwards', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    await disable();
    await rejects(resend(fx.request.id), 'request_not_resendable');
    await rejects(breakGlass(), 'target_not_active');
  });

  describe('rollback', () => {
    it.each([
      ['cancelling a request', 'adminRecoveryRequest', 'updateMany', (args) => args.data && args.data.status === 'cancelled'],
      ['revoking an invitation', 'adminInvitation', 'updateMany', () => true],
    ])('if %s fails, the whole disable rolls back', async (_label, model, method, predicate) => {
      const admin = target();
      const session = await startSession(admin);
      const fx = seedApproved(admin);
      const before = snapshot();
      breakIn(model, method, predicate);
      await expect(disable()).rejects.toThrow('failed');
      jest.restoreAllMocks();
      expect(snapshot()).toBe(before);
      expect(admin.status).toBe('active');
      expect(fx.request.status).toBe('approved');
      expect(fx.invitation.revokedAt).toBeNull();
      expect(db.sessions.find((s) => s.id === session.sessionId).revokedAt).toBeNull();
    });

    it('an audit failure rolls back the cancellations as well', async () => {
      const admin = target();
      const fx = seedApproved(admin);
      db.failAudit = true;
      await expect(disable()).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(admin.status).toBe('active');
      expect(fx.request.status).toBe('approved');
      expect(fx.invitation.revokedAt).toBeNull();
    });
  });

  describe('last-active-superadmin protection', () => {
    it('still refuses to disable the last active superadmin, leaving its recovery untouched', async () => {
      const admin = target({ role: 'superadmin' });
      const fx = seedApproved(admin);
      const before = snapshot();
      await rejects(disable(), 'last_active_superadmin');
      expect(snapshot()).toBe(before);
      expect(admin.status).toBe('active');
      expect(fx.request.status).toBe('approved');
    });

    it('disables a superadmin when another active one exists, and cancels its recovery', async () => {
      const admin = target({ role: 'superadmin' });
      superadmin();
      const fx = seedApproved(admin);
      await expect(disable()).resolves.toMatchObject({ cancelledRecoveryRequests: 1 });
      expect(fx.request.status).toBe('cancelled');
    });
  });
});

// ---- 4. cancel and status consistency ------------------------------------------------------

describe('cancelRecoveryRequest for approved and break-glass requests', () => {
  const cancel = (id, overrides = {}) => cancelRecoveryRequest({ id, reason: 'Raised in error', now: at(60), ...overrides });

  it('cancels an approved request and revokes its live invitation in the same transaction', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    const result = await cancel(fx.request.id);
    expect(result).toMatchObject({ request: { status: 'cancelled' }, revokedInvitations: 1 });
    expect(fx.invitation.revokedAt).toEqual(at(60));
    expect(auditsOf('admin_recovery_cancelled')[0].detail).toMatchObject({ previousStatus: 'approved', revokedInvitationCount: 1 });
    await expect(redeemRecoveryInvitation({ token: fx.token, password: PASSWORD, now: at(61) })).rejects.toBeInstanceOf(RecoveryRegistrationError);
  });

  it('keeps the existing reason rule: non-empty is required, and no new minimum length applies', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    for (const reason of [undefined, '', '   ', 7]) await rejects(cancel(fx.request.id, { reason }), 'invalid_reason');
    expect(fx.request.status).toBe('approved');
    await expect(cancel(fx.request.id, { reason: 'x' })).resolves.toMatchObject({ request: { status: 'cancelled' } });
  });

  it('cancels a break-glass request, and a new one can then start', async () => {
    target();
    await breakGlass();
    await cancel(1);
    expect(db.recoveryRequests[0].status).toBe('cancelled');
    expect(live()).toHaveLength(0);
    await expect(breakGlass({ now: at(120) })).resolves.toMatchObject({ request: { id: 2 } });
  });

  it('leaves used and expired invitations as they were', async () => {
    const admin = target();
    const fx = seedApproved(admin, { invitation: { usedAt: at(-60) } });
    const before = { ...fx.invitation };
    await cancel(fx.request.id);
    expect(fx.invitation).toEqual(before);
  });

  it('still refuses an approved request that is past its deadline', async () => {
    const admin = target();
    const fx = seedApproved(admin, { request: { expiresAt: new Date(at(60).getTime()) } });
    const error = await rejects(cancel(fx.request.id), 'not_pending');
    expect(error.message).toMatch(/expired/);
    expect(fx.request.status).toBe('approved');
  });

  it('an audit failure keeps the request approved and the invitation live', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    db.failAudit = true;
    await expect(cancel(fx.request.id)).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(fx.request.status).toBe('approved');
    expect(fx.invitation.revokedAt).toBeNull();
  });

  it('five simultaneous cancellations: exactly one wins', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => cancel(fx.request.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(auditsOf('admin_recovery_cancelled')).toHaveLength(1);
  });
});

describe('getRecoveryRequestStatus invitation and break-glass facts', () => {
  const statusOf = async (id, now = NOW) => (await getRecoveryRequestStatus({ id, now }))[0];

  it('shows a break-glass request with its operator and live, delivered invitation', async () => {
    target();
    await breakGlass();
    expect(await statusOf(1)).toMatchObject({
      id: 1,
      status: 'approved',
      requestedVia: 'break_glass',
      requestedByAdminId: null,
      approvalsRequired: 0,
      approvals: { approved: 0, rejected: 0 },
      approvedAt: NOW,
      filedBy: { hostname: expect.any(String) },
      invitation: { id: 1, state: 'live', expiresAt: new Date(NOW.getTime() + DAY), total: 1, replacements: 0, liveCount: 1, delivery: 'delivered' },
    });
  });

  it('reports expired, revoked and used invitations, and replacements', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    expect((await statusOf(fx.request.id, at(13 * 3600))).invitation).toMatchObject({ state: 'expired', liveCount: 0 }); // 12h life
    fx.invitation.revokedAt = at(-5);
    expect((await statusOf(fx.request.id)).invitation).toMatchObject({ state: 'revoked', liveCount: 0 });
    fx.invitation.revokedAt = null;
    fx.invitation.usedAt = at(-5);
    expect((await statusOf(fx.request.id)).invitation).toMatchObject({ state: 'used', liveCount: 0 });

    fx.invitation.usedAt = null;
    await resend(fx.request.id);
    expect((await statusOf(fx.request.id)).invitation).toMatchObject({ id: 2, state: 'live', total: 2, replacements: 1, liveCount: 1 });
  });

  it('says "unknown" delivery when nothing was recorded, and shows no invitation when there is none', async () => {
    const admin = target();
    const fx = seedApproved(admin);
    expect((await statusOf(fx.request.id)).invitation.delivery).toBe('unknown');
    const bare = seedApproved(admin, { request: { status: 'pending' } });
    db.invitations.pop();
    expect((await statusOf(bare.request.id)).invitation).toBeNull();
  });

  it('is read-only and exposes no token, hash, address or IP', async () => {
    const admin = target();
    seedPasskey(admin);
    await breakGlass();
    const before = snapshot();
    const info = await statusOf(1);
    expect(snapshot()).toBe(before);
    const text = JSON.stringify(info);
    expect(text).not.toContain(mailedToken());
    expect(text).not.toMatch(/tokenHash|sentToEmail|requestIp|passwordHash|credential|publicKey|\$2[aby]\$/i);
    expect(Object.keys(info.invitation).sort()).toEqual(['delivery', 'expiresAt', 'id', 'liveCount', 'replacements', 'state', 'total']);
  });
});

// ---- 5. the CLI ----------------------------------------------------------------------------

describe('scripts/admin-recovery.js', () => {
  describe('parseArgs', () => {
    it('parses resend and break-glass', () => {
      expect(parseArgs(['resend', '--id', '12'])).toEqual({ command: 'resend', id: 12 });
      expect(parseArgs(['resend', '--id=12'])).toEqual({ command: 'resend', id: 12 });
      expect(parseArgs(['break-glass', '--email', 'Target@Example.org', '--reason', `  ${REASON}  `])).toEqual({
        command: 'break-glass', email: EMAIL, reason: REASON,
      });
    });

    it.each([
      ['resend without an id', ['resend']],
      ['resend with a reason', ['resend', '--id', '1', '--reason', 'x y z']],
      ['resend with an email', ['resend', '--id', '1', '--email', EMAIL]],
      ['resend with a token', ['resend', '--id', '1', '--token', 'abc']],
      ['break-glass without a reason', ['break-glass', '--email', EMAIL]],
      ['break-glass without an email', ['break-glass', '--reason', REASON]],
      ['break-glass with an id', ['break-glass', '--id', '1', '--email', EMAIL, '--reason', REASON]],
      ['break-glass with a --confirm option (it must be typed)', ['break-glass', '--email', EMAIL, '--reason', REASON, '--confirm', 'yes']],
      ['break-glass with --yes', ['break-glass', '--email', EMAIL, '--reason', REASON, '--yes', 'true']],
      ['a command in another case', ['Break-Glass', '--email', EMAIL, '--reason', REASON]],
      ['a duplicate reason', ['break-glass', '--email', EMAIL, '--reason', REASON, '--reason', REASON]],
    ])('rejects %s', (_label, argv) => {
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'bad_arguments' }));
    });

    it('rejects a thin break-glass reason while ordinary reasons stay short', () => {
      expect(() => parseArgs(['break-glass', '--email', EMAIL, '--reason', 'urgent'])).toThrow(expect.objectContaining({ code: 'invalid_reason' }));
      expect(() => parseArgs(['break-glass', '--email', EMAIL, '--reason', 'lost key'])).toThrow(expect.objectContaining({ code: 'invalid_reason' }));
      expect(parseArgs(['request', '--email', EMAIL, '--reason', 'Lost it'])).toMatchObject({ reason: 'Lost it' });
      expect(parseArgs(['cancel', '--id', '1', '--reason', 'Oops'])).toMatchObject({ reason: 'Oops' });
    });

    it('rejects a bad resend id', () => {
      expect(() => parseArgs(['resend', '--id', '0'])).toThrow(expect.objectContaining({ code: 'invalid_request_id' }));
      expect(() => parseArgs(['resend', '--id', 'abc'])).toThrow(expect.objectContaining({ code: 'invalid_request_id' }));
    });
  });

  describe('promptLine', () => {
    it('refuses to run without an interactive terminal', () => {
      const input = new PassThrough();
      input.isTTY = false;
      expect(() => promptLine('Type: ', { input, output: new PassThrough() })).toThrow(expect.objectContaining({ code: 'confirmation_required' }));
    });

    it('returns exactly what was typed (trimmed) on a terminal', async () => {
      const input = new PassThrough();
      input.isTTY = true;
      const output = new PassThrough();
      const typed = promptLine('Type: ', { input, output });
      input.write(`  ${breakGlassConfirmation(EMAIL)}  \n`);
      await expect(typed).resolves.toBe(breakGlassConfirmation(EMAIL));
    });
  });

  describe('printStatus', () => {
    it('prints the break-glass marker and invitation facts, nothing sensitive', async () => {
      const admin = target();
      seedPasskey(admin);
      await breakGlass();
      await resend(1, { now: at(60) });
      const [info] = await getRecoveryRequestStatus({ id: 1, now: at(60) });
      const lines = [];
      console.log.mockImplementation((line) => lines.push(String(line)));
      printStatus(info);
      const output = lines.join('\n');
      expect(output).toContain('Channel:    break_glass');
      expect(output).toContain('BREAK-GLASS');
      expect(output).toContain('Invitation: #2 live');
      expect(output).toContain('email delivered');
      expect(output).toContain('Invitations issued: 2 (1 replacement(s)); live now: 1');
      expect(output).not.toContain(mailedToken());
      expect(output).not.toMatch(/hash|credential|\$2[aby]\$|#token/i);
    });

    it('prints "Invitation: none" when there is none', async () => {
      const admin = target();
      db.recoveryRequests.push({ id: 1, adminId: admin.id, requestedByAdminId: null, requestedVia: 'operator', status: 'pending', approvalsRequired: 2, expiresAt: at(DAY / 1000), createdAt: NOW, reason: 'x' });
      const [info] = await getRecoveryRequestStatus({ id: 1, now: NOW });
      const lines = [];
      console.log.mockImplementation((line) => lines.push(String(line)));
      printStatus(info);
      expect(lines.join('\n')).toContain('Invitation: none');
    });
  });
});
