// Recovery request lifecycle for the operator CLI (Step 7.9.3): create, status, cancel, and the
// argument parser / output of scripts/admin-recovery.js. No database: Prisma is the in-memory
// stand-in from admin-lock-fake-db.js, mail never leaves the process, and nothing is ever run
// against a real account. Approval, invitations and recovery itself do not exist yet.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const os = require('os');
const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { ProvisioningError } = require('../src/modules/admin/auth/admin-provisioning.service');
const {
  createRecoveryRequest,
  cancelRecoveryRequest,
  getRecoveryRequestStatus,
} = require('../src/modules/admin/auth/admin-recovery-request.service');
const { parseArgs, printStatus } = require('../scripts/admin-recovery');

const { db, fake, seedAdmin, seedPasskey } = kit;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const LATER = new Date('2027-03-01T11:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'asha@example.org';

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

const create = (overrides = {}) => createRecoveryRequest({ email: EMAIL, reason: 'Lost laptop', now: NOW, ...overrides });
const cancel = (id, overrides = {}) => cancelRecoveryRequest({ id, reason: 'Raised in error', now: LATER, ...overrides });
const target = (overrides = {}) => seedAdmin({ email: EMAIL, ...overrides });
const auditsOf = (event) => db.audits.filter((a) => a.event === event);

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.code).toBe(code);
  return error;
};

// A request row in a given state, for tests that need one without going through create().
function seedRequest(admin, overrides = {}) {
  const row = {
    id: db.recoveryRequests.length + 1,
    adminId: admin.id,
    requestedByAdminId: null,
    requestedVia: 'operator',
    requestIp: null,
    reason: 'Seeded',
    status: 'pending',
    approvalsRequired: 2,
    approvedAt: null,
    completedAt: null,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    createdAt: NOW,
    ...overrides,
  };
  db.recoveryRequests.push(row);
  return row;
}

describe('createRecoveryRequest', () => {
  it('opens a pending request with the approved defaults', async () => {
    const admin = target();
    seedPasskey(admin);
    const result = await create();

    expect(result).toMatchObject({
      request: { id: 1, status: 'pending', expiresAt: new Date(NOW.getTime() + 7 * DAY) },
      admin: { id: admin.id, email: EMAIL },
      emailDelivered: true,
      emailError: null,
    });
    expect(db.recoveryRequests).toHaveLength(1);
    expect(db.recoveryRequests[0]).toMatchObject({
      adminId: admin.id,
      requestedByAdminId: null,
      requestedVia: 'operator',
      requestIp: null,
      reason: 'Lost laptop',
      status: 'pending',
      approvalsRequired: 2,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
    });
    expect(db.recoveryApprovals).toHaveLength(0);
  });

  it('accepts an active Admin who has no passkey registered', async () => {
    target();
    await expect(create()).resolves.toMatchObject({ request: { status: 'pending' } });
    expect(auditsOf('admin_recovery_requested')[0].detail.hasLivePasskey).toBe(false);
  });

  it('counts only live passkeys', async () => {
    const admin = target();
    seedPasskey(admin, { revokedAt: NOW });
    await create();
    expect(auditsOf('admin_recovery_requested')[0].detail.hasLivePasskey).toBe(false);
  });

  it.each(['invited', 'pending_passkey', 'disabled'])('refuses a %s target, creating, auditing and sending nothing', async (status) => {
    target({ status, passwordHash: status === 'invited' ? null : undefined });
    const error = await rejects(create(), 'target_not_active');
    expect(error.message).toContain(`"${status}"`);
    expect(db.recoveryRequests).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('refuses an unknown email, an invalid email and a bad reason', async () => {
    await rejects(create(), 'admin_not_found');
    target();
    await rejects(create({ email: 'nobody' }), 'invalid_email');
    await rejects(create({ email: undefined }), 'invalid_email');
    for (const reason of [undefined, null, '', '   ', 42, 'x'.repeat(501), 'bad\u0007', 'a <b>']) {
      await rejects(create({ reason }), 'invalid_reason');
    }
    expect(db.recoveryRequests).toHaveLength(0);
  });

  it('matches the email exactly (trimmed, lower-cased) and never a partial one', async () => {
    target();
    seedAdmin({ email: 'sasha@example.org' });
    await create({ email: '  Asha@Example.ORG ' });
    expect(db.recoveryRequests.map((r) => r.adminId)).toEqual([1]);
    await rejects(create({ email: 'sha@example.org' }), 'admin_not_found');
  });

  it('stores a request IP only when one is given', async () => {
    target();
    await create({ ipAddress: ' 203.0.113.9 ' });
    expect(db.recoveryRequests[0].requestIp).toBe('203.0.113.9');
    fake.reset();
    target();
    await create({ ipAddress: '   ' });
    expect(db.recoveryRequests[0].requestIp).toBeNull();
  });

  it('writes one operator audit event with the target, request, reason, expiry and operator', async () => {
    const admin = target();
    await create();
    const events = auditsOf('admin_recovery_requested');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'operator',
      actorId: null,
      identifier: EMAIL,
      detail: {
        adminId: admin.id,
        recoveryRequestId: 1,
        reason: 'Lost laptop',
        requestedVia: 'operator',
        approvalsRequired: 2,
        expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
        hasLivePasskey: false,
      },
    });
    expect(events[0].detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
    expect(JSON.stringify(events[0])).not.toMatch(/\$2[aby]\$|passwordHash|tokenHash/);
  });

  it('records the operator identity from the operator utility, tolerating a missing user', async () => {
    target();
    jest.spyOn(os, 'userInfo').mockImplementation(() => { throw new Error('no passwd entry'); });
    jest.spyOn(os, 'hostname').mockReturnValue('ops-box');
    await create();
    expect(auditsOf('admin_recovery_requested')[0].detail.operator).toEqual({ username: null, hostname: 'ops-box' });

    fake.reset();
    target();
    os.userInfo.mockReturnValue({ username: 'operator1' });
    await create();
    expect(auditsOf('admin_recovery_requested')[0].detail.operator).toEqual({ username: 'operator1', hostname: 'ops-box' });
  });

  it('reports how many OTHER active superadmins could approve, without refusing', async () => {
    const withKey = (overrides) => { const a = seedAdmin({ role: 'superadmin', ...overrides }); seedPasskey(a); return a; };
    const admin = target({ role: 'superadmin' });
    seedPasskey(admin);
    withKey();
    withKey({ status: 'disabled' });
    seedAdmin({ role: 'admin' });
    expect((await create()).eligibleApprovers).toBe(1); // the target itself, a disabled and an ordinary admin do not count
    expect(admin.status).toBe('active');
    fake.reset();
    target();
    withKey();
    withKey();
    expect((await create()).eligibleApprovers).toBe(2);
  });

  it('counts only superadmins with a LIVE passkey: none, or only a revoked one, does not count', async () => {
    target();
    const live = seedAdmin({ role: 'superadmin' });
    seedPasskey(live);
    seedAdmin({ role: 'superadmin' }); // no passkey at all
    const revoked = seedAdmin({ role: 'superadmin' });
    seedPasskey(revoked, { revokedAt: NOW });
    const both = seedAdmin({ role: 'superadmin' });
    seedPasskey(both, { revokedAt: NOW });
    seedPasskey(both); // one revoked, one live: counts once
    expect((await create()).eligibleApprovers).toBe(2);
  });

  describe('duplicates', () => {
    it.each(['pending', 'approved'])('refuses a second request while one is %s', async (status) => {
      const admin = target();
      seedRequest(admin, { status });
      const error = await rejects(create(), 'open_request_exists');
      expect(error.message).toMatch(/already has an open recovery request/);
      expect(db.recoveryRequests).toHaveLength(1);
      expect(db.audits).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it.each(['completed', 'rejected', 'cancelled', 'expired'])('allows a new request after one that is %s', async (status) => {
      const admin = target();
      seedRequest(admin, { status });
      await expect(create()).resolves.toMatchObject({ request: { id: 2 } });
    });

    it('is not blocked by another Admin\'s open request', async () => {
      target();
      const other = seedAdmin({ email: 'other@example.org' });
      seedRequest(other);
      await expect(create()).resolves.toMatchObject({ request: { id: 2 } });
    });

    it('treats a request past its deadline as expired (pending or approved), recording that, and lets a new one start', async () => {
      const admin = target();
      const stale = seedRequest(admin, { status: 'pending', expiresAt: new Date(NOW.getTime() - 1) });
      const alsoStale = seedRequest(admin, { status: 'approved', expiresAt: new Date(NOW.getTime()) });
      await expect(create()).resolves.toMatchObject({ request: { id: 3 } });
      expect(stale.status).toBe('expired');
      expect(alsoStale.status).toBe('expired');
      expect(auditsOf('admin_recovery_expired')[0]).toMatchObject({ actorType: 'operator', detail: { adminId: admin.id, count: 2, trigger: 'new_request' } });
    });

    it('does not expire a request whose deadline is still ahead', async () => {
      const admin = target();
      seedRequest(admin, { status: 'pending', expiresAt: new Date(NOW.getTime() + 1) });
      await rejects(create(), 'open_request_exists');
    });

    it('five simultaneous attempts: exactly one request is created', async () => {
      target();
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => create()));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('open_request_exists'));
      expect(db.recoveryRequests).toHaveLength(1);
      expect(auditsOf('admin_recovery_requested')).toHaveLength(1);
      expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    });

    it('a create racing a disable of the target either wins before it or is refused after it, never both', async () => {
      const admin = target();
      const results = await Promise.allSettled([
        create(),
        fake.prisma.$transaction(async (tx) => {
          const held = await tx.adminUser.updateMany({ where: { id: admin.id }, data: { updatedAt: NOW } });
          if (held.count === 1) await tx.adminUser.updateMany({ where: { id: admin.id }, data: { status: 'disabled' } });
        }),
      ]);
      expect(results.every((r) => r.status === 'fulfilled' || r.reason.code === 'target_not_active')).toBe(true);
      expect(admin.status).toBe('disabled');
    });
  });

  describe('atomicity and notification', () => {
    it('an audit failure rolls the request back, and nothing is sent', async () => {
      const admin = target();
      db.failAudit = true;
      await expect(create()).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(db.recoveryRequests).toHaveLength(0);
      expect(admin.status).toBe('active');
      expect(mailer.sendMail).not.toHaveBeenCalled();
      await expect(create()).resolves.toMatchObject({ request: { id: 1 } }); // and it can be retried
    });

    it('sends the notice only after the commit, without any link or token', async () => {
      target({ name: 'Asha Rao' });
      await create();
      expect(db.events.indexOf('commit')).toBeLessThan(db.events.indexOf('email'));
      const [message] = mailer.sendMail.mock.calls[0];
      expect(message).toMatchObject({ to: EMAIL, subject: expect.stringContaining('recovery') });
      const body = `${message.text}\n${message.html}`;
      expect(body).toContain('Reference: 1');
      expect(body).not.toMatch(/https?:|token|password|#|href/i);
      expect(auditsOf('admin_recovery_notification_sent')).toHaveLength(1);
    });

    it('a failed email keeps the committed request and records the failure for a later resend', async () => {
      const admin = target();
      mailer.sendMail.mockRejectedValue(new Error('SMTP down: secret-host.internal'));
      const result = await create();
      expect(result).toMatchObject({ emailDelivered: false, emailError: 'SMTP down: secret-host.internal', request: { id: 1, status: 'pending' } });
      expect(db.recoveryRequests).toHaveLength(1);
      expect(auditsOf('admin_recovery_requested')).toHaveLength(1);
      const failed = auditsOf('admin_recovery_notification_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].detail).toEqual({ adminId: admin.id, recoveryRequestId: 1, operator: expect.any(Object) });
      expect(JSON.stringify(failed[0])).not.toMatch(/SMTP|secret-host/);
      expect((await getRecoveryRequestStatus({ id: 1, now: NOW }))[0].notification).toBe('failed');
    });

    it('even if recording the notice outcome fails too, the request stands', async () => {
      target();
      mailer.sendMail.mockImplementation(async () => { db.failAudit = true; throw new Error('down'); });
      await expect(create()).resolves.toMatchObject({ emailDelivered: false, request: { id: 1 } });
      expect(db.recoveryRequests).toHaveLength(1);
    });
  });
});

describe('getRecoveryRequestStatus', () => {
  it('shows the operational facts for one request', async () => {
    const admin = target({ name: 'Asha Rao' });
    await create();
    const [info] = await getRecoveryRequestStatus({ id: 1, now: NOW });
    expect(info).toEqual({
      id: 1,
      status: 'pending',
      pastDeadline: false,
      reason: 'Lost laptop',
      admin: { id: admin.id, name: 'Asha Rao', email: EMAIL, status: 'active' },
      requestedVia: 'operator',
      requestedByAdminId: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
      approvedAt: null,
      completedAt: null,
      approvalsRequired: 2,
      approvals: { approved: 0, rejected: 0 },
      filedBy: { username: expect.anything(), hostname: expect.any(String) },
      cancelledBy: null,
      notification: 'delivered',
      invitation: null,
    });
  });

  it('counts approvals and rejections', async () => {
    const admin = target();
    const request = seedRequest(admin);
    db.recoveryApprovals.push(
      { id: 1, requestId: request.id, approverId: 8, decision: 'approved' },
      { id: 2, requestId: request.id, approverId: 9, decision: 'rejected' },
      { id: 3, requestId: request.id + 1, approverId: 9, decision: 'approved' },
    );
    expect((await getRecoveryRequestStatus({ id: request.id, now: NOW }))[0].approvals).toEqual({ approved: 1, rejected: 1 });
  });

  it('flags a request past its deadline without changing it', async () => {
    const admin = target();
    const request = seedRequest(admin, { expiresAt: new Date(NOW.getTime() + 1000) });
    expect((await getRecoveryRequestStatus({ id: request.id, now: NOW }))[0].pastDeadline).toBe(false);
    const late = new Date(NOW.getTime() + 1000);
    expect((await getRecoveryRequestStatus({ id: request.id, now: late }))[0]).toMatchObject({ pastDeadline: true, status: 'pending' });
    expect(request.status).toBe('pending'); // read-only
    request.status = 'completed';
    expect((await getRecoveryRequestStatus({ id: request.id, now: late }))[0].pastDeadline).toBe(false);
  });

  it('lists an Admin\'s most recent requests newest first, at most five', async () => {
    const admin = target();
    for (let i = 0; i < 7; i += 1) seedRequest(admin, { status: 'completed', reason: `r${i + 1}` });
    const list = await getRecoveryRequestStatus({ email: ' Asha@example.org ', now: NOW });
    expect(list.map((r) => r.id)).toEqual([7, 6, 5, 4, 3]);
    expect(await getRecoveryRequestStatus({ email: 'asha@example.org', limit: 2, now: NOW })).toHaveLength(2);
  });

  it('reports who cancelled it and the notice state', async () => {
    target();
    await create();
    await cancel(1);
    const [info] = await getRecoveryRequestStatus({ id: 1, now: LATER });
    expect(info).toMatchObject({ status: 'cancelled', cancelledBy: { hostname: expect.any(String) }, notification: 'delivered' });
  });

  it('reports "unknown" when there is no record of the notice', async () => {
    const admin = target();
    seedRequest(admin);
    expect((await getRecoveryRequestStatus({ id: 1, now: NOW }))[0]).toMatchObject({ notification: 'unknown', filedBy: null });
  });

  it('never exposes IP addresses, hashes, tokens, credential or password data', async () => {
    const admin = target();
    seedPasskey(admin);
    await create({ ipAddress: '203.0.113.9' });
    const info = (await getRecoveryRequestStatus({ id: 1, now: NOW }))[0];
    const text = JSON.stringify(info);
    expect(text).not.toMatch(/203\.0\.113\.9|requestIp|passwordHash|tokenHash|token|credential|publicKey|signCount|\$2[aby]\$/i);
    expect(Object.keys(info).sort()).toEqual([
      'admin', 'approvalsRequired', 'approvals', 'approvedAt', 'cancelledBy', 'completedAt', 'createdAt', 'expiresAt', 'filedBy', 'id',
      'invitation', 'notification', 'pastDeadline', 'reason', 'requestedByAdminId', 'requestedVia', 'status',
    ].sort());
    expect(Object.keys(info.admin).sort()).toEqual(['email', 'id', 'name', 'status']);
  });

  it('is read-only', async () => {
    const admin = target();
    await create();
    seedRequest(admin, { status: 'rejected' });
    const before = JSON.stringify({ r: db.recoveryRequests, a: db.admins, audits: db.audits });
    await getRecoveryRequestStatus({ id: 1, now: LATER });
    await getRecoveryRequestStatus({ email: EMAIL, now: LATER });
    expect(JSON.stringify({ r: db.recoveryRequests, a: db.admins, audits: db.audits })).toBe(before);
  });

  it('refuses unknown targets and malformed or conflicting input', async () => {
    await rejects(getRecoveryRequestStatus({ id: 99 }), 'request_not_found');
    await rejects(getRecoveryRequestStatus({ email: 'nobody@example.org' }), 'admin_not_found');
    await rejects(getRecoveryRequestStatus({ email: 'bad' }), 'invalid_email');
    await rejects(getRecoveryRequestStatus({ id: '0' }), 'invalid_request_id');
    await rejects(getRecoveryRequestStatus({}), 'bad_arguments');
    await rejects(getRecoveryRequestStatus({ id: 1, email: EMAIL }), 'bad_arguments');
  });
});

describe('cancelRecoveryRequest', () => {
  it('cancels a pending request, auditing the operator, reason and time', async () => {
    const admin = target();
    await create();
    const result = await cancel(1);
    expect(result).toEqual({ request: { id: 1, status: 'cancelled' }, admin: { id: admin.id, email: EMAIL }, revokedInvitations: 0 });
    expect(db.recoveryRequests[0].status).toBe('cancelled');
    const event = auditsOf('admin_recovery_cancelled');
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({
      actorType: 'operator',
      identifier: EMAIL,
      detail: { adminId: admin.id, recoveryRequestId: 1, reason: 'Raised in error', cancelledAt: LATER.toISOString() },
    });
    expect(event[0].detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
  });

  it('lets a new request start afterwards', async () => {
    target();
    await create();
    await cancel(1);
    await expect(create({ now: LATER })).resolves.toMatchObject({ request: { id: 2 } });
  });

  it('cancels a pending request that already has an approval', async () => {
    const admin = target();
    const request = seedRequest(admin);
    db.recoveryApprovals.push({ id: 1, requestId: request.id, approverId: 8, decision: 'approved' });
    await expect(cancel(request.id)).resolves.toMatchObject({ request: { status: 'cancelled' } });
  });

  it.each(['completed', 'rejected', 'expired', 'cancelled'])('refuses a %s request, changing nothing', async (status) => {
    const admin = target();
    const request = seedRequest(admin, { status });
    const error = await rejects(cancel(request.id), 'not_pending');
    expect(error.message).toContain(`"${status}"`);
    expect(request.status).toBe(status);
    expect(db.audits).toHaveLength(0);
  });

  it('refuses a pending request that is past its deadline', async () => {
    const admin = target();
    const request = seedRequest(admin, { expiresAt: new Date(LATER.getTime()) });
    const error = await rejects(cancel(request.id), 'not_pending');
    expect(error.message).toMatch(/expired/);
    expect(request.status).toBe('pending');
  });

  it('refuses an unknown request and malformed ids', async () => {
    await rejects(cancel(99), 'request_not_found');
    for (const id of [undefined, null, '', '0', '-1', '1.5', 'abc', '1e3', ' 5', '5 ', '05', '12345678901', 0, -3, 2.5, {}]) {
      await rejects(cancel(id), 'invalid_request_id');
    }
  });

  it('requires a real reason', async () => {
    const admin = target();
    seedRequest(admin);
    for (const reason of [undefined, '', '   ', 7, 'x'.repeat(501), 'bad\u0007']) {
      await rejects(cancel(1, { reason }), 'invalid_reason');
    }
    expect(db.recoveryRequests[0].status).toBe('pending');
  });

  it('five simultaneous cancellations: exactly one wins, one audit event', async () => {
    const admin = target();
    seedRequest(admin);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => cancel(1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('not_pending'));
    expect(auditsOf('admin_recovery_cancelled')).toHaveLength(1);
  });

  it('an audit failure leaves the request pending', async () => {
    const admin = target();
    const request = seedRequest(admin);
    db.failAudit = true;
    await expect(cancel(request.id)).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(request.status).toBe('pending');
    await expect(cancel(request.id)).resolves.toMatchObject({ request: { status: 'cancelled' } });
  });
});

describe('scripts/admin-recovery.js', () => {
  describe('parseArgs', () => {
    it('parses each command, in both option styles, normalising input', () => {
      expect(parseArgs(['request', '--email', 'Asha@Example.org', '--reason', '  Lost   laptop '])).toEqual({
        command: 'request', email: EMAIL, reason: 'Lost laptop',
      });
      expect(parseArgs(['request', '--reason=Lost', `--email=${EMAIL}`])).toEqual({ command: 'request', email: EMAIL, reason: 'Lost' });
      expect(parseArgs(['status', '--id', '12'])).toEqual({ command: 'status', id: 12 });
      expect(parseArgs(['status', '--id=12'])).toEqual({ command: 'status', id: 12 });
      expect(parseArgs(['status', '--email', EMAIL])).toEqual({ command: 'status', email: EMAIL });
      expect(parseArgs(['cancel', '--id', '3', '--reason', 'Raised in error'])).toEqual({ command: 'cancel', id: 3, reason: 'Raised in error' });
    });

    it.each([
      ['no command', []],
      ['an unknown command', ['approve', '--id', '1']],
      ['a command with different case', ['Request', '--email', EMAIL, '--reason', 'x y']],
      ['an inherited property as a command', ['constructor']],
      ['a missing email', ['request', '--reason', 'x y']],
      ['a missing reason (request)', ['request', '--email', EMAIL]],
      ['a missing id (cancel)', ['cancel', '--reason', 'x y']],
      ['a missing reason (cancel)', ['cancel', '--id', '1']],
      ['status with nothing', ['status']],
      ['status with both id and email', ['status', '--id', '1', '--email', EMAIL]],
      ['a duplicate option', ['status', '--id', '1', '--id', '2']],
      ['a duplicate reason', ['cancel', '--id', '1', '--reason', 'a b', '--reason', 'c d']],
      ['a reason on status', ['status', '--id', '1', '--reason', 'x y']],
      ['an email on cancel', ['cancel', '--id', '1', '--email', EMAIL, '--reason', 'x y']],
      ['an id on request', ['request', '--id', '1', '--email', EMAIL, '--reason', 'x y']],
      ['a password option', ['request', '--email', EMAIL, '--reason', 'x y', '--password', 'pw']],
      ['a token option', ['status', '--id', '1', '--token', 'abc']],
      ['a positional argument', ['status', '--id', '1', 'extra']],
      ['a value-less option', ['status', '--id']],
      ['an option swallowing the next option', ['request', '--email', '--reason', 'x y']],
    ])('rejects %s', (_label, argv) => {
      expect(() => parseArgs(argv)).toThrow(ProvisioningError);
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'bad_arguments' }));
    });

    it.each([
      ['an empty reason', ['request', '--email', EMAIL, '--reason', ''], 'invalid_reason'],
      ['a blank cancel reason', ['cancel', '--id', '1', '--reason', '   '], 'invalid_reason'],
      ['an over-long reason', ['request', '--email', EMAIL, '--reason', 'x'.repeat(501)], 'invalid_reason'],
      ['an invalid email', ['request', '--email', 'nobody', '--reason', 'x y'], 'invalid_email'],
      ['an invalid status email', ['status', '--email', 'nobody'], 'invalid_email'],
      ['a zero id', ['status', '--id', '0'], 'invalid_request_id'],
      ['a negative id', ['cancel', '--id', '-4', '--reason', 'x y'], 'invalid_request_id'],
      ['a fractional id', ['status', '--id', '1.5'], 'invalid_request_id'],
      ['a non-numeric id', ['status', '--id', 'abc'], 'invalid_request_id'],
    ])('rejects %s with its own error', (_label, argv, code) => {
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code }));
    });
  });

  describe('printStatus', () => {
    it('prints the operational facts and nothing sensitive', async () => {
      const admin = target({ name: 'Asha Rao' });
      seedPasskey(admin);
      await create({ ipAddress: '203.0.113.9' });
      const [info] = await getRecoveryRequestStatus({ id: 1, now: NOW });
      const lines = [];
      jest.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
      printStatus(info);
      const output = lines.join('\n');
      expect(output).toContain('Recovery request 1: pending');
      expect(output).toContain(EMAIL);
      expect(output).toContain('Approvals:  0 of 2 required');
      expect(output).toContain('Channel:    operator');
      expect(output).toContain('Notice to the admin: delivered');
      expect(output).not.toMatch(/203\.0\.113\.9|hash|token|credential|\$2[aby]\$/i);
    });

    it('marks a request past its deadline', async () => {
      const admin = target();
      seedRequest(admin, { expiresAt: new Date(NOW.getTime() - 1) });
      const [info] = await getRecoveryRequestStatus({ id: 1, now: NOW });
      const lines = [];
      jest.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
      printStatus(info);
      expect(lines.join('\n')).toContain('past its deadline');
    });
  });
});
