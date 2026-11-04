// Operator disable / re-enable of Admin accounts (Step 7.8.3.3-A): the service and the CLI argument
// parser. No database: Prisma is the in-memory stand-in from admin-lock-fake-db.js, and nothing is
// ever run against a real account.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const kit = require('./admin-login-test-kit');
const { createAdminSession, validateAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { ProvisioningError } = require('../src/modules/admin/auth/admin-provisioning.service');
const { disableAdminAccount, enableAdminAccount } = require('../src/modules/admin/auth/admin-account.service');
const { parseArgs } = require('../scripts/admin-account');

const { db, fake, seedAdmin, seedPasskey, begin } = kit;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const LATER = new Date('2027-03-01T11:00:00.000Z');
const EMAIL = 'asha@example.org';

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
});

afterEach(() => {
  kit.restoreEnv();
});

const disable = (overrides = {}) => disableAdminAccount({ email: EMAIL, reason: 'Left the company', now: NOW, ...overrides });
const enable = (overrides = {}) => enableAdminAccount({ email: EMAIL, now: LATER, ...overrides });

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.code).toBe(code);
  return error;
};

// A live session (with its refresh token) created the way a real login does.
const startSession = (admin, now = NOW) => fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now }));
const auditsOf = (event) => db.audits.filter((a) => a.event === event);

describe('disable', () => {
  it('disables the account, recording who/why/when, and keeps everything else', async () => {
    const admin = seedAdmin({ email: EMAIL });
    const hashBefore = admin.passwordHash;
    const result = await disable();

    expect(result).toEqual({ admin: { id: admin.id, email: EMAIL, status: 'disabled' }, revokedSessions: 0, revokedRefreshTokens: 0, cancelledRecoveryRequests: 0, revokedRecoveryInvitations: 0 });
    expect(admin).toMatchObject({ status: 'disabled', disabledAt: NOW, disabledReason: 'Left the company', disabledBy: null });
    expect(admin.passwordHash).toBe(hashBefore);
    expect(admin.role).toBe('admin');
  });

  it('writes one operator audit event with the target, reason, time and operator, and no secrets', async () => {
    const admin = seedAdmin({ email: EMAIL });
    await disable();
    const events = auditsOf('admin_account_disabled');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'operator',
      actorId: null,
      identifier: EMAIL,
      detail: { adminId: admin.id, reason: 'Left the company', previousStatus: 'active', disabledAt: NOW.toISOString(), sessionCount: 0 },
    });
    expect(events[0].detail.operator).toEqual(expect.objectContaining({ hostname: expect.any(String) }));
    expect(JSON.stringify(events[0])).not.toMatch(/\$2[aby]\$|passwordHash|token/i);
  });

  it('matches the email exactly (trimmed and lower-cased) and never a partial one', async () => {
    seedAdmin({ email: EMAIL });
    seedAdmin({ email: 'sasha@example.org' });
    await disable({ email: '  Asha@Example.ORG ' });
    expect(db.admins.map((a) => a.status)).toEqual(['disabled', 'active']);
    await rejects(disable({ email: 'asha@example.or' }), 'admin_not_found');
    await rejects(disable({ email: 'sh@example.org' }), 'admin_not_found');
  });

  it('refuses an unknown or already-disabled account, changing nothing', async () => {
    await rejects(disable(), 'admin_not_found');
    const admin = seedAdmin({ email: EMAIL });
    await disable();
    const again = await rejects(disable({ reason: 'A second reason', now: LATER }), 'already_disabled');
    expect(again.message).toBe('That admin is already disabled.');
    expect(admin.disabledReason).toBe('Left the company');
    expect(admin.disabledAt).toEqual(NOW);
    expect(auditsOf('admin_account_disabled')).toHaveLength(1);
  });

  it('disables an account that is still invited or pending a passkey', async () => {
    const invited = seedAdmin({ email: EMAIL, status: 'invited', passwordHash: null });
    await disable();
    expect(invited.status).toBe('disabled');
    expect(auditsOf('admin_account_disabled')[0].detail.previousStatus).toBe('invited');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   \n\t '],
    ['not a string', 42],
    ['too long', 'x '.repeat(200)],
    ['control characters', 'bad\u0007reason'],
    ['markup', 'a <b>reason</b>'],
  ])('refuses a %s reason before touching anything', async (_label, reason) => {
    const admin = seedAdmin({ email: EMAIL });
    await rejects(disable({ reason }), 'invalid_reason');
    expect(admin.status).toBe('active');
    expect(db.audits).toHaveLength(0);
  });

  it('refuses an invalid email', async () => {
    await rejects(disable({ email: 'not-an-email' }), 'invalid_email');
    await rejects(disable({ email: undefined }), 'invalid_email');
  });

  it('requires a root Prisma client', async () => {
    seedAdmin({ email: EMAIL });
    await expect(disableAdminAccount({ email: EMAIL, reason: 'x y', db: { adminUser: {} } })).rejects.toThrow(TypeError);
  });
});

describe('session and refresh-token revocation', () => {
  it('ends every live session and every live refresh token of that Admin only', async () => {
    const admin = seedAdmin({ email: EMAIL });
    const other = seedAdmin({ email: 'other@example.org' });
    const a = await startSession(admin);
    const b = await startSession(admin);
    const mine = await startSession(other);

    const result = await disable();
    expect(result).toMatchObject({ revokedSessions: 2, revokedRefreshTokens: 2 });

    for (const s of [a, b]) {
      expect(db.sessions.find((r) => r.id === s.sessionId)).toMatchObject({ revokedAt: NOW, revokedReason: 'account_disabled', revokedBy: null });
    }
    expect(db.refreshTokens.filter((t) => [a.sessionId, b.sessionId].includes(t.sessionId)).every((t) => t.revokedAt)).toBe(true);
    expect(db.sessions.find((r) => r.id === mine.sessionId).revokedAt).toBeNull();
    expect(db.refreshTokens.find((t) => t.sessionId === mine.sessionId).revokedAt).toBeNull();
    expect(auditsOf('admin_account_disabled')[0].detail.sessionCount).toBe(2);
  });

  it('keeps an earlier revocation as it was, but still revokes a refresh token left live on it', async () => {
    const admin = seedAdmin({ email: EMAIL });
    const s = await startSession(admin);
    const row = db.sessions.find((r) => r.id === s.sessionId);
    row.revokedAt = new Date('2027-02-01T00:00:00Z');
    row.revokedReason = 'logout';
    const result = await disable();
    expect(result.revokedSessions).toBe(0);
    expect(row).toMatchObject({ revokedAt: new Date('2027-02-01T00:00:00Z'), revokedReason: 'logout' });
    expect(db.refreshTokens[0].revokedAt).toEqual(NOW);
    expect(result.revokedRefreshTokens).toBe(1);
  });

  it('makes the existing sessions unusable straight away', async () => {
    const admin = seedAdmin({ email: EMAIL });
    const s = await startSession(admin);
    await expect(validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: NOW })).resolves.not.toBeNull();
    await disable();
    await expect(validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: NOW })).resolves.toBeNull();
  });
});

describe('passkeys', () => {
  it('survive disable and enable untouched', async () => {
    const admin = seedAdmin({ email: EMAIL });
    const { row } = seedPasskey(admin, { signCount: 7 });
    const before = JSON.stringify(row);
    await disable();
    expect(JSON.stringify(db.passkeys[0])).toBe(before);
    await enable();
    expect(JSON.stringify(db.passkeys[0])).toBe(before);
    expect(db.passkeys).toHaveLength(1);
    expect(db.passkeys[0].revokedAt).toBeNull();
  });
});

describe('enable', () => {
  it('re-enables, clears the current disabled metadata and keeps the history in the audit trail', async () => {
    const admin = seedAdmin({ email: EMAIL });
    seedPasskey(admin);
    await disable();
    const result = await enable();

    expect(result).toEqual({ admin: { id: admin.id, email: EMAIL, status: 'active' }, previousStatus: 'disabled', statusSource: 'live_passkey' });
    expect(admin).toMatchObject({ status: 'active', disabledAt: null, disabledReason: null, disabledBy: null });
    expect(auditsOf('admin_account_disabled')).toHaveLength(1); // the history stays
    expect(auditsOf('admin_account_enabled')).toHaveLength(1);
    expect(auditsOf('admin_account_enabled')[0]).toMatchObject({
      actorType: 'operator',
      identifier: EMAIL,
      detail: { adminId: admin.id, newStatus: 'active', statusSource: 'live_passkey', enabledAt: LATER.toISOString() },
    });
  });

  it('creates no session or token and does not restore revoked ones', async () => {
    const admin = seedAdmin({ email: EMAIL });
    seedPasskey(admin);
    const s = await startSession(admin);
    await disable();
    const sessions = db.sessions.length;
    const tokens = db.refreshTokens.length;
    await enable();
    expect(db.sessions).toHaveLength(sessions);
    expect(db.refreshTokens).toHaveLength(tokens);
    expect(db.sessions.find((r) => r.id === s.sessionId).revokedAt).toEqual(NOW);
    expect(db.refreshTokens.every((t) => t.revokedAt)).toBe(true);
    await expect(validateAdminSession({ sessionId: s.sessionId, adminId: admin.id, now: LATER })).resolves.toBeNull();
  });

  it('leaves the password alone and opens no password-only door: sign-in still needs the passkey step', async () => {
    const admin = seedAdmin({ email: EMAIL });
    seedPasskey(admin);
    const hash = admin.passwordHash;
    await disable();
    await expect(begin(admin)).rejects.toMatchObject({ code: 'invalid_credentials' }); // disabled: refused
    await enable();
    expect(admin.passwordHash).toBe(hash);
    const step = await begin(admin);
    expect(step).toHaveProperty('loginTicket');
    expect(db.sessions).toHaveLength(0); // the password alone created nothing
  });

  it('refuses an unknown account and one that is not disabled', async () => {
    await rejects(enable(), 'admin_not_found');
    const admin = seedAdmin({ email: EMAIL });
    const error = await rejects(enable(), 'not_disabled');
    expect(error.message).toBe('That admin is not disabled.');
    expect(admin.status).toBe('active');
    expect(db.audits).toHaveLength(0);
  });

  it('restores "invited" for an account that never chose a password, and "pending_passkey" for one that never finished enrollment', async () => {
    const invited = seedAdmin({ email: EMAIL, status: 'invited', passwordHash: null });
    await disable();
    await expect(enable()).resolves.toMatchObject({ admin: { status: 'invited' }, statusSource: 'no_password' });
    expect(invited.status).toBe('invited');

    const pending = seedAdmin({ email: 'pending@example.org', status: 'pending_passkey' });
    await disable({ email: 'pending@example.org' });
    await expect(enable({ email: 'pending@example.org' })).resolves.toMatchObject({ admin: { status: 'pending_passkey' }, statusSource: 'audit_trail' });
    expect(pending.status).toBe('pending_passkey');
  });

  it('treats an account disabled some other way (no audit event) with a password and no passkey as active', async () => {
    const admin = seedAdmin({ email: EMAIL, status: 'disabled', disabledAt: NOW, disabledReason: 'by hand' });
    await expect(enable()).resolves.toMatchObject({ admin: { status: 'active' }, statusSource: 'default' });
    expect(admin).toMatchObject({ status: 'active', disabledAt: null, disabledReason: null });
  });

  it('a revoked passkey does not count as a live one', async () => {
    const admin = seedAdmin({ email: EMAIL, status: 'pending_passkey' });
    seedPasskey(admin, { revokedAt: NOW });
    await disable();
    await expect(enable()).resolves.toMatchObject({ admin: { status: 'pending_passkey' } });
  });
});

describe('atomicity: an audit failure undoes everything', () => {
  it('disable: status, metadata, sessions and tokens are all unchanged', async () => {
    // (A real row always has the disabled-metadata columns, as null.)
    const admin = seedAdmin({ email: EMAIL, disabledAt: null, disabledReason: null, disabledBy: null });
    await startSession(admin);
    db.failAudit = true;
    await expect(disable()).rejects.toThrow('audit write failed');
    db.failAudit = false;

    expect(admin).toMatchObject({ status: 'active', disabledAt: null, disabledReason: null, disabledBy: null });
    expect(db.sessions.every((s) => s.revokedAt === null)).toBe(true);
    expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
    expect(auditsOf('admin_account_disabled')).toHaveLength(0);
    await expect(disable()).resolves.toMatchObject({ revokedSessions: 1 }); // and it can simply be retried
  });

  it('enable: the account stays disabled with its metadata', async () => {
    const admin = seedAdmin({ email: EMAIL });
    seedPasskey(admin);
    await disable();
    db.failAudit = true;
    await expect(enable()).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(admin).toMatchObject({ status: 'disabled', disabledAt: NOW, disabledReason: 'Left the company' });
    expect(auditsOf('admin_account_enabled')).toHaveLength(0);
  });
});

describe('repeated and concurrent operations', () => {
  it('five simultaneous disables: exactly one wins, the rest are already_disabled, one audit event', async () => {
    const admin = seedAdmin({ email: EMAIL });
    await startSession(admin);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => disable()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures).toHaveLength(4);
    failures.forEach((r) => expect(r.reason.code).toBe('already_disabled'));
    expect(auditsOf('admin_account_disabled')).toHaveLength(1);
    expect(admin.status).toBe('disabled');
  });

  it('five simultaneous enables: exactly one wins, the rest are not_disabled, one audit event', async () => {
    const admin = seedAdmin({ email: EMAIL });
    seedPasskey(admin);
    await disable();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => enable()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('not_disabled'));
    expect(auditsOf('admin_account_enabled')).toHaveLength(1);
    expect(admin.status).toBe('active');
  });

  it('a second disable after enable works again, and the last event decides what enable restores', async () => {
    const admin = seedAdmin({ email: EMAIL, status: 'pending_passkey' });
    await disable();
    await enable();
    admin.status = 'active'; // later it became a fully active Admin with a passkey-less legacy login
    await disable({ reason: 'Second time', now: LATER });
    await expect(enable({ now: new Date('2027-03-02T00:00:00Z') })).resolves.toMatchObject({ admin: { status: 'active' } });
    expect(auditsOf('admin_account_disabled')).toHaveLength(2);
  });
});

describe('parseArgs', () => {
  it('parses disable and enable, in both option styles', () => {
    expect(parseArgs(['disable', '--email', 'Asha@Example.org', '--reason', '  Left   the company '])).toEqual({
      command: 'disable', email: EMAIL, reason: 'Left the company',
    });
    expect(parseArgs(['disable', '--reason=Left', '--email=asha@example.org'])).toEqual({ command: 'disable', email: EMAIL, reason: 'Left' });
    expect(parseArgs(['enable', '--email', EMAIL])).toEqual({ command: 'enable', email: EMAIL });
    expect(parseArgs(['enable', `--email=${EMAIL}`])).toEqual({ command: 'enable', email: EMAIL });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['delete', '--email', EMAIL]],
    ['a command with different case', ['Disable', '--email', EMAIL, '--reason', 'x']],
    ['an inherited property as a command', ['constructor', '--email', EMAIL]],
    ['a missing email', ['disable', '--reason', 'x y']],
    ['a missing reason', ['disable', '--email', EMAIL]],
    ['a missing email for enable', ['enable']],
    ['a duplicate email', ['enable', '--email', EMAIL, '--email', EMAIL]],
    ['a duplicate reason', ['disable', '--email', EMAIL, '--reason', 'a b', '--reason', 'c d']],
    ['a reason on enable', ['enable', '--email', EMAIL, '--reason', 'x y']],
    ['an account id', ['disable', '--id', '5', '--email', EMAIL, '--reason', 'x y']],
    ['a password option', ['enable', '--email', EMAIL, '--password', 'x']],
    ['a positional argument', ['enable', '--email', EMAIL, 'extra']],
    ['a value-less option', ['enable', '--email']],
    ['an option swallowing the next option', ['disable', '--email', '--reason', 'x y']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(ProvisioningError);
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: 'bad_arguments' }));
  });

  it.each([
    ['an empty reason', ['disable', '--email', EMAIL, '--reason', ''], 'invalid_reason'],
    ['a blank reason', ['disable', '--email', EMAIL, '--reason', '   '], 'invalid_reason'],
    ['an invalid email', ['enable', '--email', 'nobody'], 'invalid_email'],
    ['an empty email', ['enable', '--email', ''], 'invalid_email'],
  ])('rejects %s with its own error', (_label, argv, code) => {
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code }));
  });
});

describe('the last active superadmin is protected', () => {
  const superadmin = (email, overrides = {}) => seedAdmin({ email, role: 'superadmin', ...overrides });
  const activeSuperadmins = () => db.admins.filter((a) => a.role === 'superadmin' && a.status === 'active');
  const snapshot = () => JSON.stringify({ admins: db.admins, sessions: db.sessions, tokens: db.refreshTokens, passkeys: db.passkeys });

  it('refuses to disable the only active superadmin, changing nothing and auditing nothing', async () => {
    const only = superadmin(EMAIL, { disabledAt: null, disabledReason: null, disabledBy: null });
    seedAdmin({ email: 'ops@example.org' }); // an ordinary admin does not count
    seedPasskey(only);
    await startSession(only);
    const before = snapshot();

    const error = await rejects(disable(), 'last_active_superadmin');
    expect(error.message).toBe('That admin is the last active superadmin and cannot be disabled.');
    expect(snapshot().replace(/"updatedAt":"[^"]*"/g, '')).toBe(before.replace(/"updatedAt":"[^"]*"/g, ''));
    expect(only.status).toBe('active');
    expect(db.sessions.every((s) => s.revokedAt === null)).toBe(true);
    expect(db.refreshTokens.every((t) => t.revokedAt === null)).toBe(true);
    expect(auditsOf('admin_account_disabled')).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('does not count superadmins that are not active', async () => {
    superadmin(EMAIL);
    superadmin('invited-super@example.org', { status: 'invited', passwordHash: null });
    superadmin('disabled-super@example.org', { status: 'disabled' });
    await rejects(disable(), 'last_active_superadmin');
  });

  it('disables one of several active superadmins, and then protects the one left', async () => {
    const first = superadmin(EMAIL);
    const second = superadmin('second@example.org');
    await startSession(first);

    await expect(disable()).resolves.toMatchObject({ admin: { status: 'disabled' }, revokedSessions: 1 });
    expect(first.status).toBe('disabled');
    expect(activeSuperadmins()).toEqual([second]);
    await rejects(disable({ email: 'second@example.org' }), 'last_active_superadmin');
    expect(second.status).toBe('active');
  });

  it('still disables an ordinary admin when there is only one superadmin', async () => {
    const lone = superadmin('root@example.org');
    const ordinary = seedAdmin({ email: EMAIL });
    await expect(disable()).resolves.toMatchObject({ admin: { status: 'disabled' } });
    expect(ordinary.status).toBe('disabled');
    expect(lone.status).toBe('active');
  });

  it('still disables a superadmin who is not active yet, whatever the count', async () => {
    const pending = superadmin(EMAIL, { status: 'invited', passwordHash: null });
    superadmin('root@example.org');
    await expect(disable()).resolves.toMatchObject({ admin: { status: 'disabled' } });
    expect(pending.status).toBe('disabled');
  });

  it('can disable a superadmin again after another one is re-enabled', async () => {
    const a = superadmin(EMAIL);
    const b = superadmin('second@example.org');
    seedPasskey(b);
    await disable();
    await disable({ email: 'second@example.org' }).catch(() => null); // refused: last one
    expect(b.status).toBe('active');
    await enable(); // a is back
    await expect(disable({ email: 'second@example.org', now: LATER })).resolves.toMatchObject({ admin: { status: 'disabled' } });
    expect(a.status).toBe('active');
  });

  it('two simultaneous disables of the final two active superadmins cannot both succeed', async () => {
    for (let round = 0; round < 12; round += 1) {
      fake.reset();
      db.auditClock = NOW;
      const a = superadmin(EMAIL);
      const b = superadmin('second@example.org');
      await startSession(a);
      await startSession(b);

      const attempts = [disable(), disable({ email: 'second@example.org' })];
      if (round % 2) attempts.reverse();
      const results = await Promise.allSettled(attempts);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected');
      expect(refused.reason.code).toBe('last_active_superadmin');
      expect(activeSuperadmins()).toHaveLength(1);
      expect(auditsOf('admin_account_disabled')).toHaveLength(1);
      // only the disabled one lost its session
      const survivor = activeSuperadmins()[0];
      expect(db.sessions.filter((s) => !s.revokedAt).map((s) => s.adminId)).toEqual([survivor.id]);
    }
  });

  it('three superadmins disabled at once: two succeed, one is always left, and nothing deadlocks', async () => {
    superadmin(EMAIL);
    superadmin('second@example.org');
    superadmin('third@example.org');
    const emails = [EMAIL, 'second@example.org', 'third@example.org'];
    const results = await Promise.allSettled(emails.map((email) => disable({ email })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('last_active_superadmin'));
    expect(activeSuperadmins()).toHaveLength(1);
  });

  it('mixed attempts on the same superadmin: one disable wins, the rest are already_disabled or protected', async () => {
    superadmin(EMAIL);
    superadmin('second@example.org');
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => disable()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(['already_disabled']).toContain(r.reason.code));
    expect(activeSuperadmins()).toHaveLength(1);
  });

  it('an audit failure still rolls back, and the protection does not change enabling', async () => {
    const a = superadmin(EMAIL, { disabledAt: null, disabledReason: null, disabledBy: null });
    superadmin('second@example.org');
    db.failAudit = true;
    await expect(disable()).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(a.status).toBe('active');
    await disable();
    await expect(enable()).resolves.toMatchObject({ admin: { status: 'active' } });
  });
});
