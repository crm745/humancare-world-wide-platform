// Registration options for a first passkey (Step 7.7.4). No database: Prisma is the in-memory
// stand-in from admin-lock-fake-db.js. The real @simplewebauthn/server generates the options.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('@simplewebauthn/server', () => {
  const actual = jest.requireActual('@simplewebauthn/server');
  return { ...actual, generateRegistrationOptions: jest.fn(actual.generateRegistrationOptions) };
});

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const server = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const fake = require('./admin-lock-fake-db');
const {
  generateAdminPasskeyRegistrationOptions,
  PasskeyRegistrationError,
} = require('../src/modules/admin/auth/admin-webauthn-registration.service');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminLoginTicket } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { signAdminAccessToken, deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('../src/modules/admin/auth/admin-token.service');
const { deriveAdminWebAuthnUserHandle } = require('../src/modules/admin/auth/admin-webauthn.helpers');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const PCA = new Date('2027-02-28T09:00:00.000Z'); // when the password was set (= acceptance time)
const MINUTE = 60 * 1000;
const ENV_KEYS = ['ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME', 'JWT_ACCESS_SECRET', 'NODE_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function seedAdmin(overrides = {}) {
  const admin = {
    id: db.admins.length + 1,
    name: 'Asha Rao',
    email: 'asha@example.org',
    role: 'admin',
    status: 'pending_passkey',
    passwordHash: '$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotareal',
    passwordChangedAt: PCA,
    updatedAt: null,
    ...overrides,
  };
  db.admins.push(admin);
  return admin;
}

function seedInvitation(admin, overrides = {}) {
  const invitation = {
    id: db.invitations.length + 1,
    adminId: admin.id,
    purpose: 'activation',
    tokenHash: crypto.randomBytes(32).toString('hex'),
    sentToEmail: admin.email,
    expiresAt: new Date(PCA.getTime() + 72 * 60 * MINUTE),
    usedAt: PCA,
    revokedAt: null,
    ...overrides,
  };
  db.invitations.push(invitation);
  return invitation;
}

// A fully valid context: a pending Admin, its used activation invitation, and a matching ticket.
function setup(adminOverrides = {}, invitationOverrides = {}) {
  const admin = seedAdmin(adminOverrides);
  const invitation = seedInvitation(admin, invitationOverrides);
  const ticket = signAdminEnrollmentTicket({ adminId: admin.id, invitationId: invitation.id, passwordChangedAt: PCA });
  return { admin, invitation, ticket };
}

const run = (ticket, overrides = {}) => generateAdminPasskeyRegistrationOptions({ ticket, now: NOW, ...overrides });
const expectGenericFailure = async (promise) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(PasskeyRegistrationError);
  expect(error).toMatchObject({ code: 'invalid_enrollment', message: 'This passkey setup session is not valid. Please start again.' });
};

beforeEach(() => {
  fake.reset();
  server.generateRegistrationOptions.mockClear();
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-registration-options';
  process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
  process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('a valid enrollment ticket', () => {
  it('produces registration options', async () => {
    const { admin, ticket } = setup();
    const options = await run(ticket);
    expect(options).toMatchObject({
      rp: { id: 'localhost', name: 'HumanCare World Wide Admin' },
      user: { name: admin.email, displayName: admin.name },
      attestation: 'none',
      timeout: 120000,
    });
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.generateRegistrationOptions).toHaveBeenCalledTimes(1);
  });

  it('uses the configured RP ID, RP name, and validates the configured origin', async () => {
    process.env.ADMIN_WEBAUTHN_RP_ID = 'example.org';
    process.env.ADMIN_WEBAUTHN_ORIGIN = 'https://admin.example.org';
    process.env.ADMIN_WEBAUTHN_RP_NAME = 'Example Admin';
    const { ticket } = setup();
    const options = await run(ticket);
    expect(options.rp).toEqual({ id: 'example.org', name: 'Example Admin' });
  });

  it('refuses to run with missing, mismatched or production-unsafe WebAuthn configuration, touching nothing', async () => {
    const { ticket } = setup();
    for (const key of ['ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME']) {
      const saved = process.env[key];
      delete process.env[key];
      await expect(run(ticket)).rejects.toThrow(key);
      process.env[key] = saved;
    }
    process.env.ADMIN_WEBAUTHN_RP_ID = 'other.example';
    await expect(run(ticket)).rejects.toThrow('ADMIN_WEBAUTHN_RP_ID');
    process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
    process.env.NODE_ENV = 'production'; // localhost values are never acceptable in production
    await expect(run(ticket)).rejects.toThrow('production');
    expect(db.events).toEqual([]);
    expect(db.challenges).toHaveLength(0);
  });

  it('uses the opaque, derived user handle (not the database id)', async () => {
    const { admin, ticket } = setup();
    const options = await run(ticket);
    const handle = isoBase64URL.toBuffer(options.user.id);
    expect(Buffer.from(handle).equals(Buffer.from(deriveAdminWebAuthnUserHandle(admin.id)))).toBe(true);
    expect(handle).toHaveLength(32);
    expect(options.user.id).not.toBe(String(admin.id));
  });

  it('offers only ES256 and RS256', async () => {
    const { ticket } = setup();
    const options = await run(ticket);
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(options.pubKeyCredParams.every((p) => p.type === 'public-key')).toBe(true);
  });

  it('requires user verification, prefers a resident key, and asks for no attestation', async () => {
    const { ticket } = setup();
    const options = await run(ticket);
    expect(options.authenticatorSelection).toMatchObject({ userVerification: 'required', residentKey: 'preferred' });
    expect(options.attestation).toBe('none');
  });

  it('gives the library a fresh authenticator-selection object every time (it mutates what it is given)', async () => {
    const { ticket } = setup();
    await run(ticket);
    await run(ticket);
    const [first, second] = server.generateRegistrationOptions.mock.calls.map(([args]) => args.authenticatorSelection);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(second)).toBe(false);
  });

  it('passes the library the exact challenge bytes, so the options carry the stored challenge', async () => {
    const { ticket } = setup();
    const options = await run(ticket);
    const [args] = server.generateRegistrationOptions.mock.calls[0];
    expect(args.challenge).toBeInstanceOf(Uint8Array);
    expect(typeof args.challenge).not.toBe('string');
    const row = db.challenges[0];
    expect(options.challenge).toBe(row.challenge); // identical text
    expect(Buffer.from(isoBase64URL.toBuffer(options.challenge)).equals(Buffer.from(args.challenge))).toBe(true); // identical bytes
    expect(isoBase64URL.toBuffer(row.challenge)).toHaveLength(32);
  });

  it('stores the challenge for the exact Admin, purpose and invitation with a 120-second lifetime', async () => {
    const { admin, invitation, ticket } = setup();
    await run(ticket, { ipAddress: '203.0.113.9' });
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0]).toMatchObject({
      adminId: admin.id,
      purpose: 'registration',
      invitationId: invitation.id,
      sessionId: null,
      recoveryRequestId: null,
      consumedAt: null,
      ipAddress: '203.0.113.9',
      expiresAt: new Date(NOW.getTime() + 120 * 1000),
    });
  });

  it('excludes no credentials for a first passkey', async () => {
    const { ticket } = setup();
    expect((await run(ticket)).excludeCredentials ?? []).toEqual([]);
  });

  it('retires an earlier open registration challenge and leaves one open', async () => {
    const { ticket } = setup();
    const first = await run(ticket);
    const second = await run(ticket, { now: new Date(NOW.getTime() + 1000) });
    expect(first.challenge).not.toBe(second.challenge);
    const open = db.challenges.filter((c) => c.consumedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].challenge).toBe(second.challenge);
    expect(db.challenges).toHaveLength(2);
  });

  it('runs inside a caller-supplied transaction when given one', async () => {
    const { ticket } = setup();
    await expect(fake.prisma.$transaction(async (tx) => {
      await generateAdminPasskeyRegistrationOptions({ ticket, now: NOW, db: tx });
      throw new Error('caller failed later');
    })).rejects.toThrow('caller failed later');
    expect(db.challenges).toHaveLength(0);
  });
});

describe('what is returned and what is not issued', () => {
  it('returns only browser-safe options, with no internal ids, claims or account state', async () => {
    const { admin, invitation, ticket } = setup();
    const options = await run(ticket);
    expect(Object.keys(options).sort()).toEqual(
      ['attestation', 'authenticatorSelection', 'challenge', 'excludeCredentials', 'extensions', 'hints', 'pubKeyCredParams', 'rp', 'timeout', 'user']
        .filter((k) => k in options).sort(),
    );
    const text = JSON.stringify(options);
    for (const forbidden of ['passwordHash', 'status', 'pending_passkey', 'invitationId', 'challengeId', 'adminId', 'flow', 'pca', 'jti', 'role', ticket, admin.passwordHash]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain(`"id":${admin.id}`);
    expect(text).not.toContain(`"invitationId":${invitation.id}`);
    expect(options).not.toHaveProperty('challengeId');
    expect(options).not.toHaveProperty('adminId');
  });

  it('issues no token, cookie or session, and changes no account state', async () => {
    const { admin, ticket } = setup();
    const result = await run(ticket);
    expect(JSON.stringify(result)).not.toMatch(/token|session|jwt|bearer|cookie/i);
    expect(db.sessions).toHaveLength(0);
    expect(admin.status).toBe('pending_passkey'); // not activated
    expect(db.passkeys).toHaveLength(0); // nothing stored
    expect(db.audits).toHaveLength(0);
  });
});

describe('ticket validation', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 12345],
    ['garbage', 'not.a.jwt'],
  ])('rejects a %s ticket generically', async (_name, ticket) => {
    setup();
    await expectGenericFailure(run(ticket));
    expect(db.events).toEqual([]);
  });

  it('rejects a tampered ticket', async () => {
    const { ticket } = setup();
    await expectGenericFailure(run(`${ticket.slice(0, -2)}xx`));
  });

  it('rejects an expired ticket (valid at 599 s, expired at 601 s)', async () => {
    const { ticket } = setup();
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 599 * 1000);
    await expect(run(ticket)).resolves.toBeDefined();
    Date.now.mockReturnValue(start + 601 * 1000);
    await expectGenericFailure(run(ticket));
  });

  it('rejects tickets of other kinds (login ticket, access token, wrong audience, wrong flow)', async () => {
    const { admin } = setup();
    await expectGenericFailure(run(signAdminLoginTicket({ adminId: admin.id, flow: 'passkey_login' })));
    await expectGenericFailure(run(signAdminAccessToken({ adminId: admin.id, role: 'admin', sessionId: 1 })));
    const forge = (claims, options = {}) => jwt.sign(claims, deriveAdminKey('humancare/admin-lock/enrollment-ticket/v1'), {
      algorithm: 'HS256', issuer: ADMIN_TOKEN_ISSUER, subject: String(admin.id), jwtid: 'x', expiresIn: 600, ...options,
    });
    const claims = { flow: 'passkey_enrollment', inv: 1, pca: PCA.getTime() };
    await expectGenericFailure(run(forge(claims, { audience: 'someone-else' })));
    await expectGenericFailure(run(forge({ ...claims, flow: 'passkey_login' }, { audience: 'humancare-admin-enrollment-ticket' })));
    await expect(run(forge(claims, { audience: 'humancare-admin-enrollment-ticket' }))).resolves.toBeDefined(); // control
  });

  it('never accepts an Admin id, invitation id, challenge or handle from the caller', async () => {
    const { ticket } = setup();
    seedAdmin({ email: 'other@example.org' }); // a second pending Admin
    const options = await generateAdminPasskeyRegistrationOptions({
      ticket, now: NOW, adminId: 2, invitationId: 99, challenge: 'attacker-chosen', userID: 'evil', role: 'superadmin', status: 'active',
    });
    expect(options.user.name).toBe('asha@example.org');
    expect(options.challenge).not.toBe('attacker-chosen');
    expect(db.challenges[0]).toMatchObject({ adminId: 1, invitationId: 1 });
  });
});

describe('Admin validation (all failures are the same generic error and leave no trace)', () => {
  const assertNoTrace = (before = 0) => {
    expect(db.challenges).toHaveLength(before);
    expect(db.audits).toHaveLength(0);
    expect(db.passkeys.every((p) => p.revokedAt !== null || p.adminId)).toBe(true);
  };

  it('rejects an Admin that does not exist, exactly like any other failure', async () => {
    const ticket = signAdminEnrollmentTicket({ adminId: 77, invitationId: 1, passwordChangedAt: PCA });
    await expectGenericFailure(run(ticket));
    assertNoTrace();
  });

  it.each(['invited', 'active', 'disabled', 'something_else'])('rejects status %s', async (status) => {
    const { ticket } = setup({ status });
    await expectGenericFailure(run(ticket));
    assertNoTrace();
  });

  it('rejects an Admin with no password marker', async () => {
    const { ticket } = setup({ passwordChangedAt: null });
    await expectGenericFailure(run(ticket));
    assertNoTrace();
  });

  it('rejects when the password changed after the ticket was issued', async () => {
    const { admin, ticket } = setup();
    admin.passwordChangedAt = new Date(PCA.getTime() + 1);
    await expectGenericFailure(run(ticket));
    assertNoTrace();
  });

  it('rejects a ticket whose Admin does not match its other bindings', async () => {
    const first = seedAdmin();
    seedInvitation(first);
    const second = seedAdmin({ email: 'second@example.org', passwordChangedAt: new Date(PCA.getTime() + 5000) });
    const secondInvitation = seedInvitation(second);
    // Admin 2's id and invitation, but Admin 1's password marker.
    const ticket = signAdminEnrollmentTicket({ adminId: second.id, invitationId: secondInvitation.id, passwordChangedAt: PCA });
    await expectGenericFailure(run(ticket));
    assertNoTrace();
  });

  it('does not disturb an open challenge when a request is refused', async () => {
    const { admin, ticket } = setup();
    await run(ticket);
    admin.status = 'disabled';
    await expectGenericFailure(run(ticket, { now: new Date(NOW.getTime() + 1000) }));
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0].consumedAt).toBeNull();
  });
});

describe('invitation validation', () => {
  it('rejects a missing invitation', async () => {
    const admin = seedAdmin();
    const ticket = signAdminEnrollmentTicket({ adminId: admin.id, invitationId: 42, passwordChangedAt: PCA });
    await expectGenericFailure(run(ticket));
    expect(db.challenges).toHaveLength(0);
  });

  it("rejects an invitation that belongs to another Admin", async () => {
    const other = seedAdmin({ email: 'other@example.org' });
    const theirs = seedInvitation(other);
    const mine = seedAdmin();
    const ticket = signAdminEnrollmentTicket({ adminId: mine.id, invitationId: theirs.id, passwordChangedAt: PCA });
    await expectGenericFailure(run(ticket));
    expect(db.challenges).toHaveLength(0);
  });

  it.each(['passkey_recovery', 'Activation', 'Passkey_Enrollment', ''])('rejects invitation purpose %p', async (purpose) => {
    const { ticket } = setup({}, { purpose });
    await expectGenericFailure(run(ticket));
  });

  it('rejects an unused invitation', async () => {
    const { ticket } = setup({}, { usedAt: null });
    await expectGenericFailure(run(ticket));
  });

  it('rejects a revoked invitation', async () => {
    const { ticket } = setup({}, { revokedAt: new Date(PCA.getTime() + 1000) });
    await expectGenericFailure(run(ticket));
  });

  it('rejects an invitation that was only used after it had expired', async () => {
    const { ticket } = setup({}, { expiresAt: new Date(PCA.getTime() - 1) });
    await expectGenericFailure(run(ticket));
  });

  it('accepts an invitation used at the last moment before it expired, even if it has expired since', async () => {
    const { ticket } = setup({}, { expiresAt: PCA }); // used exactly at expiry: allowed; "now" is long after
    await expect(run(ticket)).resolves.toBeDefined();
  });
});

describe('existing passkeys', () => {
  it('rejects an Admin with an unrevoked passkey', async () => {
    const { admin, ticket } = setup();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialId: crypto.randomBytes(32), transports: ['internal'], revokedAt: null });
    await expectGenericFailure(run(ticket));
    expect(db.challenges).toHaveLength(0);
  });

  it('is not blocked by revoked passkeys, nor by another Admin\'s passkeys', async () => {
    const { admin, ticket } = setup();
    db.passkeys.push({ id: 1, adminId: admin.id, credentialId: crypto.randomBytes(32), transports: [], revokedAt: new Date() });
    db.passkeys.push({ id: 2, adminId: admin.id + 1, credentialId: crypto.randomBytes(32), transports: [], revokedAt: null });
    const options = await run(ticket);
    expect(options.excludeCredentials ?? []).toEqual([]);
  });
});

describe('failure handling and concurrency', () => {
  it('leaves no usable challenge when option generation fails, and restores the previous one', async () => {
    const { ticket } = setup();
    const previous = await run(ticket);
    server.generateRegistrationOptions.mockRejectedValueOnce(new Error('library failure'));
    await expect(run(ticket, { now: new Date(NOW.getTime() + 1000) })).rejects.toThrow('library failure');
    expect(db.events).toContain('rollback');
    expect(db.challenges).toHaveLength(1); // the failed attempt's challenge does not exist
    expect(db.challenges[0]).toMatchObject({ challenge: previous.challenge, consumedAt: null }); // earlier one untouched
  });

  it('leaves nothing behind when the first attempt fails', async () => {
    const { ticket } = setup();
    server.generateRegistrationOptions.mockRejectedValueOnce(new Error('library failure'));
    await expect(run(ticket)).rejects.toThrow('library failure');
    expect(db.challenges).toHaveLength(0);
  });

  it('rolls back if the library returns a challenge other than the stored one', async () => {
    const { ticket } = setup();
    const actual = jest.requireActual('@simplewebauthn/server');
    server.generateRegistrationOptions.mockImplementationOnce(async (args) => ({ ...(await actual.generateRegistrationOptions(args)), challenge: 'someOtherChallenge' }));
    await expect(run(ticket)).rejects.toThrow('do not match the stored challenge');
    expect(db.challenges).toHaveLength(0);
  });

  it('rolls back if storing the challenge fails', async () => {
    const { ticket } = setup();
    db.failCreate = 'challenges';
    await expect(run(ticket)).rejects.toThrow('create failed');
    expect(db.challenges).toHaveLength(0);
  });

  it('keeps exactly one open challenge under concurrent requests with one ticket', async () => {
    const { ticket } = setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => run(ticket, { now: new Date(NOW.getTime() + i * 1000) })));
    expect(new Set(results.map((r) => r.challenge)).size).toBe(5); // each got its own
    expect(db.challenges).toHaveLength(5);
    const open = db.challenges.filter((c) => c.consumedAt === null);
    expect(open).toHaveLength(1);
    expect(results.map((r) => r.challenge)).toContain(open[0].challenge);
  });

  it('holds the Admin row while it works, so a concurrent disable cannot change the Admin mid-request', async () => {
    const { admin, ticket } = setup();
    // Pause the request right after it has read the Admin, before it makes the challenge.
    let reachedPause;
    const paused = new Promise((resolve) => { reachedPause = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    db.afterRead = async (table) => {
      if (table !== 'admins') return;
      db.afterRead = null;
      reachedPause();
      await gate;
    };

    const request = run(ticket);
    await paused;

    // Someone tries to disable the Admin now. It must wait for the request's lock.
    let disabled = false;
    const disable = fake.prisma.$transaction(async (tx) => {
      await tx.adminUser.updateMany({ where: { id: admin.id }, data: { status: 'disabled' } });
      disabled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disabled).toBe(false);
    expect(admin.status).toBe('pending_passkey'); // untouched while the request holds the row

    resume();
    const options = await request;
    await disable;
    expect(options.challenge).toBeDefined(); // the request saw a consistent, still-pending Admin
    expect(disabled).toBe(true);
    expect(admin.status).toBe('disabled');

    // After the disable, the same ticket no longer works.
    await expectGenericFailure(run(ticket, { now: new Date(NOW.getTime() + 1000) }));
  });
});
