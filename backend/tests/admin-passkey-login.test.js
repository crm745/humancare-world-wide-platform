// Admin password + passkey sign-in (Step 7.8.2): the password step, the login ticket and challenge
// binding, assertion verification and counters, and the lockout. No database: Prisma is the
// in-memory stand-in; the REAL @simplewebauthn/server verifies genuine assertions built by the
// software authenticator.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const kit = require('./admin-login-test-kit');
const { makeRegistrationResponse, FLAG } = require('./admin-webauthn-test-authenticator');
const { AdminLoginError } = require('../src/modules/admin/auth/admin-login.service');
const {
  signAdminLoginTicket,
  signAdminPasskeyLoginTicket,
  readAdminPasskeyLoginTicket,
  readAdminLoginTicket,
  ADMIN_LOGIN_FLOWS,
} = require('../src/modules/admin/auth/admin-login-ticket.service');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminAccessToken, verifyAdminAccessToken } = require('../src/modules/admin/auth/admin-token.service');
const { deriveAdminWebAuthnUserHandle } = require('../src/modules/admin/auth/admin-webauthn.helpers');
const { loginAdmin } = require('../src/modules/admin/admin.service');
const { hashToken } = require('../src/common/utils/token-hash');

const {
  db, fake, NOW, PCA, PASSWORD, PASSWORD_HASH, later, seedAdmin, seedPasskey, begin, login, makeAssertionResponse,
  completeAdminPasskeyLogin, beginAdminPasskeyLogin,
} = kit;

const GENERIC = { code: 'invalid_credentials', message: 'Invalid credentials' };

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
});

async function expectRefused(promise) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(AdminLoginError);
  expect(error).toMatchObject(GENERIC);
  expect(Object.keys(error).sort()).toEqual(['code', 'name']); // nothing else serialised
  return error;
}

// A started login: the admin, passkey, ticket, options and a helper to answer the challenge.
async function started(adminOverrides = {}, passkeyOptions = {}) {
  const admin = seedAdmin(adminOverrides);
  const passkey = seedPasskey(admin, passkeyOptions);
  const { loginTicket, options } = await begin(admin);
  const answer = (overrides = {}) => makeAssertionResponse({ challenge: options.challenge, registered: passkey.reg, counter: 1, ...overrides });
  const complete = (response, extra = {}) => completeAdminPasskeyLogin({ loginTicket, response, now: later(5), ...extra });
  return { admin, passkey, loginTicket, options, answer, complete };
}

describe('password step', () => {
  it('returns a login ticket and authentication options for the right password', async () => {
    const admin = seedAdmin();
    const { row } = seedPasskey(admin);
    const result = await begin(admin);
    expect(Object.keys(result).sort()).toEqual(['loginTicket', 'options']);
    expect(result.options).toMatchObject({ rpId: 'localhost', timeout: 120000, userVerification: 'required' });
    expect(result.options.allowCredentials).toEqual([{ id: isoBase64URL.fromBuffer(row.credentialId), type: 'public-key', transports: ['internal'] }]);
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0]).toMatchObject({ adminId: admin.id, purpose: 'authentication', consumedAt: null, invitationId: null, sessionId: null });
    expect(db.challenges[0].challenge).toBe(result.options.challenge); // the options carry the stored challenge
    expect(db.challenges[0].expiresAt).toEqual(later(120));
  });

  it('binds the ticket to the Admin, the password state and the exact challenge, for 120 seconds', async () => {
    const admin = seedAdmin();
    seedPasskey(admin);
    const { loginTicket } = await begin(admin);
    const decoded = jwt.decode(loginTicket);
    expect(decoded.exp - decoded.iat).toBe(120);
    expect(decoded).toMatchObject({ flow: 'passkey_login', sub: String(admin.id), pca: PCA.getTime(), chal: db.challenges[0].id });
    expect(readAdminPasskeyLoginTicket(loginTicket)).toMatchObject({ adminId: admin.id, passwordChangedAt: PCA, challengeId: db.challenges[0].id });
  });

  it('issues no cookie, access token, refresh token or session', async () => {
    const admin = seedAdmin();
    seedPasskey(admin);
    const result = await begin(admin);
    expect(db.sessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
    expect(verifyAdminAccessToken(result.loginTicket)).toBeNull();
  });

  it('reserves the attempt but does not reset the failure counter on a correct password', async () => {
    const admin = seedAdmin({ failedLoginCount: 3 });
    seedPasskey(admin);
    await begin(admin);
    expect(admin.failedLoginCount).toBe(4); // counted, not cleared: only a full login clears it
  });

  it('normalises the email', async () => {
    const admin = seedAdmin({ email: 'asha@example.org' });
    seedPasskey(admin);
    await expect(beginAdminPasskeyLogin({ email: '  ASHA@Example.ORG ', password: PASSWORD, now: NOW })).resolves.toHaveProperty('loginTicket');
  });

  describe('refusals are one generic error', () => {
    it('wrong password (and the attempt is counted)', async () => {
      const admin = seedAdmin();
      seedPasskey(admin);
      await expectRefused(begin(admin, { password: 'WrongPass2027y' }));
      expect(admin.failedLoginCount).toBe(1);
      expect(db.challenges).toHaveLength(0);
    });

    it.each([[undefined], [null], [''], [12345], [{}], ['x'.repeat(100)]])('unusable password %p', async (password) => {
      const admin = seedAdmin();
      seedPasskey(admin);
      await expectRefused(begin(admin, { password }));
      expect(db.challenges).toHaveLength(0);
    });

    it('unknown Admin and unusable email', async () => {
      await expectRefused(beginAdminPasskeyLogin({ email: 'nobody@example.org', password: PASSWORD, now: NOW }));
      for (const email of [undefined, null, '', 'not an email', 12345]) {
        await expectRefused(beginAdminPasskeyLogin({ email, password: PASSWORD, now: NOW }));
      }
    });

    it.each(['invited', 'pending_passkey', 'disabled', 'something_else'])('%s Admin, with the right password, touching no counter', async (status) => {
      const admin = seedAdmin({ status });
      seedPasskey(admin);
      await expectRefused(begin(admin));
      expect(admin.failedLoginCount).toBe(0);
      expect(db.challenges).toHaveLength(0);
    });

    it('an Admin with no passkey, or only revoked ones (no password-only fallback), touching no counter', async () => {
      const bare = seedAdmin();
      await expectRefused(begin(bare));
      const revoked = seedAdmin();
      seedPasskey(revoked, { revokedAt: NOW });
      await expectRefused(begin(revoked));
      expect([bare.failedLoginCount, revoked.failedLoginCount]).toEqual([0, 0]);
      expect(db.challenges).toHaveLength(0);
    });

    it('an Admin with no password hash or password timestamp', async () => {
      const a = seedAdmin({ passwordHash: null });
      seedPasskey(a);
      await expectRefused(begin(a));
      const b = seedAdmin({ passwordChangedAt: null });
      seedPasskey(b);
      await expectRefused(begin(b));
    });

    it('has the same shape for every cause, and always runs exactly one password comparison', async () => {
      const ok = seedAdmin();
      seedPasskey(ok);
      const disabled = seedAdmin({ status: 'disabled' });
      seedPasskey(disabled);
      const compare = jest.spyOn(bcrypt, 'compare');
      const shapes = new Set();
      for (const attempt of [
        () => begin(ok, { password: 'WrongPass2027y' }),
        () => begin(disabled),
        () => beginAdminPasskeyLogin({ email: 'nobody@example.org', password: PASSWORD, now: NOW }),
        () => beginAdminPasskeyLogin({ email: undefined, password: PASSWORD, now: NOW }),
      ]) {
        compare.mockClear();
        const error = await attempt().then(() => null, (e) => e);
        expect(compare).toHaveBeenCalledTimes(1);
        shapes.add(JSON.stringify({ name: error.name, code: error.code, message: error.message, keys: Object.keys(error).sort() }));
      }
      expect(shapes.size).toBe(1);
    });
  });

  describe('lockout', () => {
    it('allows five attempts, locks at the fifth failure, and refuses even the right password while locked', async () => {
      const admin = seedAdmin();
      seedPasskey(admin);
      for (let i = 1; i <= 5; i += 1) {
        await expectRefused(begin(admin, { password: `WrongPass2027-${i}` }));
        expect(admin.failedLoginCount).toBe(i);
        expect(admin.lockedUntil).toEqual(i < 5 ? null : later(15 * 60));
      }
      await expectRefused(begin(admin)); // the 6th: right password, but the account is locked
      expect(admin.failedLoginCount).toBe(5);
      expect(db.audits.find((a) => a.event === 'admin.account_locked')).toMatchObject({ actorType: 'system', detail: { adminId: admin.id } });
      expect(db.challenges).toHaveLength(0);
      await expectRefused(begin(admin, { now: later(14 * 60) })); // still locked, right password
      expect(admin.lockedUntil).toEqual(later(15 * 60)); // not extended by refused attempts
    });

    it('lasts exactly fifteen minutes, then counting starts afresh', async () => {
      const admin = seedAdmin({ failedLoginCount: 5 });
      seedPasskey(admin);
      await expectRefused(begin(admin)); // locks
      await expectRefused(begin(admin, { now: later(15 * 60 - 1) }));
      await expect(begin(admin, { now: later(15 * 60 + 1) })).resolves.toHaveProperty('loginTicket');
      expect(admin.failedLoginCount).toBe(1);
      expect(admin.lockedUntil).toBeNull();
    });

    it('cannot be beaten by parallel guesses: reservation comes before the password check', async () => {
      const admin = seedAdmin();
      seedPasskey(admin);
      const compare = jest.spyOn(bcrypt, 'compare');
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => begin(admin, { password: `WrongPass2027-${i}` })));
      results.forEach((r) => expect(r.status).toBe('rejected'));
      expect(admin.failedLoginCount).toBe(5);
      expect(admin.lockedUntil).not.toBeNull();
      expect(compare.mock.calls.filter(([, hash]) => hash === PASSWORD_HASH)).toHaveLength(5); // only five were ever checked
      await expectRefused(begin(admin)); // and the right password does not get in either
    });

    it('does not apply to, or count against, the Admin when the password step is simply refused for state', async () => {
      const admin = seedAdmin({ status: 'disabled', failedLoginCount: 4 });
      seedPasskey(admin);
      await expectRefused(begin(admin));
      expect(admin.failedLoginCount).toBe(4);
    });

    it('fails closed - and never checks the password - when the lock cannot be audited, and the lock stands', async () => {
      const admin = seedAdmin({ failedLoginCount: 5 });
      seedPasskey(admin);
      const compare = jest.spyOn(bcrypt, 'compare');
      db.failAudit = true;
      const error = await begin(admin).then(() => null, (e) => e);
      expect(error.message).toBe('audit write failed');
      expect(compare.mock.calls.filter(([, hash]) => hash === PASSWORD_HASH)).toHaveLength(0);
      expect(admin.lockedUntil).toEqual(later(15 * 60)); // committed before the audit: refused loudly, and locked
    });

    it('a full login clears the counter and the lock', async () => {
      const admin = seedAdmin({ failedLoginCount: 3 });
      const passkey = seedPasskey(admin);
      await kit.login(admin, passkey);
      expect(admin.failedLoginCount).toBe(0);
      expect(admin.lockedUntil).toBeNull();
      expect(admin.lastLoginAt).toEqual(NOW);
    });

    it('a failed passkey step does not clear it, and does not add a second increment', async () => {
      const t = await started({ failedLoginCount: 2 });
      expect(t.admin.failedLoginCount).toBe(3);
      await expectRefused(t.complete(t.answer({ origin: 'https://evil.example' })));
      expect(t.admin.failedLoginCount).toBe(3);
    });
  });

  it('a second password step retires the earlier challenge, and the earlier ticket stops working', async () => {
    const admin = seedAdmin();
    const passkey = seedPasskey(admin);
    const first = await begin(admin);
    const second = await begin(admin, { now: later(1) });
    expect(db.challenges[0].consumedAt).not.toBeNull();
    expect(db.challenges.filter((c) => c.consumedAt === null)).toHaveLength(1);
    // the first ticket cannot be used with the second challenge's answer, nor its own retired challenge
    const forSecond = makeAssertionResponse({ challenge: second.options.challenge, registered: passkey.reg });
    await expectRefused(completeAdminPasskeyLogin({ loginTicket: first.loginTicket, response: forSecond, now: later(2) }));
    expect(db.challenges[1].consumedAt).toBeNull(); // the newer challenge was not touched
    // and the second pair still works
    await expect(completeAdminPasskeyLogin({ loginTicket: second.loginTicket, response: forSecond, now: later(3) })).resolves.toHaveProperty('accessToken');
  });
});

describe('ticket and challenge', () => {
  it('accepts a correct ticket and assertion', async () => {
    const t = await started();
    await expect(t.complete(t.answer())).resolves.toHaveProperty('accessToken');
  });

  it('rejects an expired ticket (valid at 119 s, refused at 121 s)', async () => {
    const t = await started();
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 121 * 1000);
    await expectRefused(t.complete(t.answer()));
    expect(db.challenges[0].consumedAt).toBeNull(); // refused before the challenge was touched
    Date.now.mockReturnValue(start + 119 * 1000);
    await expect(t.complete(t.answer())).resolves.toHaveProperty('accessToken');
  });

  it('rejects when the password changed after the ticket was issued', async () => {
    const t = await started();
    t.admin.passwordChangedAt = new Date(PCA.getTime() + 1);
    await expectRefused(t.complete(t.answer()));
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  it('rejects tickets of other kinds and unbound passkey_login tickets', async () => {
    const t = await started();
    const response = t.answer();
    const bad = [
      signAdminLoginTicket({ adminId: t.admin.id, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN }), // right flow, no bindings
      signAdminLoginTicket({ adminId: t.admin.id, flow: ADMIN_LOGIN_FLOWS.PASSKEY_UNLOCK }),
      signAdminEnrollmentTicket({ adminId: t.admin.id, invitationId: 1, passwordChangedAt: PCA }),
      signAdminAccessToken({ adminId: t.admin.id, role: 'admin', sessionId: 1 }),
      undefined, '', 'garbage', 12345,
    ];
    for (const loginTicket of bad) await expectRefused(completeAdminPasskeyLogin({ loginTicket, response, now: later(5) }));
    expect(db.challenges[0].consumedAt).toBeNull();
    expect(readAdminLoginTicket(t.loginTicket, 'passkey_login')).not.toBeNull(); // the bound one is still a valid login ticket
    expect(readAdminPasskeyLoginTicket(signAdminLoginTicket({ adminId: 1, flow: 'passkey_login' }))).toBeNull();
  });

  it('rejects a ticket bound to a different challenge than the one the answer is for', async () => {
    const t = await started();
    const other = signAdminPasskeyLoginTicket({ adminId: t.admin.id, passwordChangedAt: PCA, challengeId: 999 });
    await expectRefused(completeAdminPasskeyLogin({ loginTicket: other, response: t.answer(), now: later(5) }));
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  it('rejects a ticket naming another Admin\'s challenge', async () => {
    const t = await started();
    const other = seedAdmin();
    seedPasskey(other);
    await begin(other);
    const ticket = signAdminPasskeyLoginTicket({ adminId: t.admin.id, passwordChangedAt: PCA, challengeId: db.challenges.find((c) => c.adminId === other.id).id });
    await expectRefused(completeAdminPasskeyLogin({ loginTicket: ticket, response: t.answer(), now: later(5) }));
    expect(db.challenges.every((c) => c.consumedAt === null)).toBe(true);
  });

  it('rejects an expired challenge (valid at 119 s, refused at 120 s)', async () => {
    const t = await started();
    await expectRefused(completeAdminPasskeyLogin({ loginTicket: t.loginTicket, response: t.answer(), now: later(120) }));
    await expect(completeAdminPasskeyLogin({ loginTicket: t.loginTicket, response: t.answer(), now: later(119) })).resolves.toHaveProperty('accessToken');
  });

  it('rejects a consumed challenge and a replay of the whole exchange', async () => {
    const t = await started();
    const response = t.answer();
    await t.complete(response);
    await expectRefused(t.complete(response, { now: later(6) })); // replay
    expect(db.sessions).toHaveLength(1);
    expect(db.refreshTokens).toHaveLength(1);
  });

  it('burns the challenge on a failed assertion: nothing can be retried with it', async () => {
    const t = await started();
    await expectRefused(t.complete(t.answer({ origin: 'https://evil.example' })));
    expect(db.challenges[0].consumedAt).toEqual(later(5));
    await expectRefused(t.complete(t.answer(), { now: later(6) })); // even a perfect answer is now refused
    expect(db.sessions).toHaveLength(0);
  });

  it('two simultaneous completions of one ticket: exactly one wins', async () => {
    const t = await started();
    const response = t.answer();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => t.complete(response)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason).toBeInstanceOf(AdminLoginError));
    expect(db.sessions).toHaveLength(1);
  });
});

describe('assertion verification', () => {
  it('accepts the right credential with ES256 and with RS256', async () => {
    for (const key of ['es256', 'rs256']) {
      fake.reset();
      db.auditClock = NOW;
      const t = await started({}, { key });
      await expect(t.complete(t.answer())).resolves.toMatchObject({ admin: { id: t.admin.id } });
    }
  });

  it("refuses another Admin's credential, even though its assertion is genuine", async () => {
    const t = await started();
    const other = seedAdmin();
    const otherKey = seedPasskey(other);
    const stolen = makeAssertionResponse({ challenge: t.options.challenge, registered: otherKey.reg, counter: 1 });
    await expectRefused(t.complete(stolen));
    expect(db.sessions).toHaveLength(0);
    expect(otherKey.row.signCount).toBe(0);
    expect(db.challenges[0].consumedAt).not.toBeNull();
  });

  it('refuses an unknown credential and a malformed credential id', async () => {
    const t = await started();
    const stranger = makeRegistrationResponse({ challenge: 'x' });
    await expectRefused(t.complete(makeAssertionResponse({ challenge: t.options.challenge, registered: stranger })));
    const t2 = await started();
    const bad = t2.answer();
    bad.id = 'AAAA'; bad.rawId = 'AAAA';
    await expectRefused(t2.complete(bad));
  });

  it('refuses a revoked credential', async () => {
    const t = await started();
    t.passkey.row.revokedAt = later(1);
    await expectRefused(t.complete(t.answer()));
    expect(db.sessions).toHaveLength(0);
  });

  it('refuses a credential revoked while the assertion was being verified', async () => {
    const t = await started();
    const realTransaction = fake.prisma.$transaction;
    fake.prisma.$transaction = (fn) => { t.passkey.row.revokedAt = later(1); return realTransaction(fn); };
    try {
      await expectRefused(t.complete(t.answer()));
    } finally {
      fake.prisma.$transaction = realTransaction;
    }
    expect(db.sessions).toHaveLength(0);
  });

  it.each([
    ['a wrong origin', { origin: 'https://evil.example' }],
    ['a similar origin on another port', { origin: 'http://localhost:3001' }],
    ['a wrong RP ID', { rpId: 'evil.example' }],
    ['a wrong ceremony type', { type: 'webauthn.create' }],
    ['a missing user-verification flag', { flags: FLAG.UP }],
    ['a missing user-presence flag', { flags: FLAG.UV }],
    ['a signature from another key', { signWith: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }],
    ['a different challenge', { challenge: crypto.randomBytes(32).toString('base64url') }],
  ])('refuses %s, burning the challenge and creating nothing', async (_name, overrides) => {
    const t = await started();
    await expectRefused(t.complete(t.answer(overrides)));
    expect(db.challenges[0].consumedAt).not.toBeNull();
    expect(db.sessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
    expect(t.passkey.row.signCount).toBe(0);
  });

  it('checks the user handle when present: the right one passes, a wrong one is refused', async () => {
    const good = await started();
    await expect(good.complete(good.answer({ userHandle: deriveAdminWebAuthnUserHandle(good.admin.id) }))).resolves.toHaveProperty('accessToken');
    fake.reset();
    db.auditClock = NOW;
    const bad = await started();
    await expectRefused(bad.complete(bad.answer({ userHandle: deriveAdminWebAuthnUserHandle(bad.admin.id + 100) })));
    expect(db.sessions).toHaveLength(0);
  });

  describe('response shape', () => {
    it.each([
      ['undefined', () => undefined],
      ['a string', () => 'x'],
      ['no id', (r) => ({ ...r, id: undefined })],
      ['a non-base64url id', (r) => ({ ...r, id: 'not valid!' })],
      ['a wrong type', (r) => ({ ...r, type: 'password' })],
      ['no inner response', (r) => ({ ...r, response: undefined })],
      ['missing signature', (r) => ({ ...r, response: { ...r.response, signature: undefined } })],
      ['an object as authenticatorData', (r) => ({ ...r, response: { ...r.response, authenticatorData: {} } })],
      ['a huge signature', (r) => ({ ...r, response: { ...r.response, signature: 'A'.repeat(5000) } })],
    ])('refuses %s', async (_name, mutate) => {
      const t = await started();
      await expectRefused(t.complete(mutate(t.answer())));
      expect(db.sessions).toHaveLength(0);
    });

    it('passes only known fields to the library', async () => {
      const t = await started();
      const response = { ...t.answer(), evil: 'x', response: { ...t.answer().response, extra: 'y' } };
      await expect(t.complete(response)).resolves.toHaveProperty('accessToken');
    });
  });

  describe('signature counter', () => {
    it('accepts a valid increase and records it with the last-used time', async () => {
      const t = await started({}, { signCount: 5 });
      await t.complete(t.answer({ counter: 6 }));
      expect(t.passkey.row).toMatchObject({ signCount: 6, lastUsedAt: later(5), revokedAt: null });
    });

    it('accepts an authenticator that always reports zero (0/0), recording the use', async () => {
      const t = await started({}, { signCount: 0 });
      await t.complete(t.answer({ counter: 0 }));
      expect(t.passkey.row).toMatchObject({ signCount: 0, lastUsedAt: later(5) });
    });

    it('accepts the first non-zero counter after zeros', async () => {
      const t = await started({}, { signCount: 0 });
      await t.complete(t.answer({ counter: 1 }));
      expect(t.passkey.row.signCount).toBe(1);
    });

    it.each([[5, 5], [5, 4], [5, 0], [1, 0]])('refuses a rollback (stored %i, reported %i), audits it, and does not revoke the credential', async (stored, reported) => {
      const t = await started({}, { signCount: stored });
      await expectRefused(t.complete(t.answer({ counter: reported })));
      expect(t.passkey.row).toMatchObject({ signCount: stored, revokedAt: null });
      const event = db.audits.find((a) => a.event === 'admin_passkey_counter_regression');
      expect(event).toMatchObject({ actorType: 'admin', actorId: t.admin.id, detail: { passkeyId: t.passkey.row.id, storedCount: stored, reportedCount: reported } });
      expect(JSON.stringify(event)).not.toContain(t.passkey.row.credentialIdHash);
      expect(db.sessions).toHaveLength(0);
      expect(db.challenges[0].consumedAt).not.toBeNull();
    });

    it('does not let two logins both advance one credential (conditional counter update)', async () => {
      const t = await started({}, { signCount: 5 });
      const realTransaction = fake.prisma.$transaction;
      // Another login advances the credential after this one was verified, before it commits.
      fake.prisma.$transaction = (fn) => { t.passkey.row.signCount = 7; return realTransaction(fn); };
      try {
        await expectRefused(t.complete(t.answer({ counter: 6 })));
      } finally {
        fake.prisma.$transaction = realTransaction;
      }
      expect(t.passkey.row.signCount).toBe(7); // untouched by the loser
      expect(db.sessions).toHaveLength(0);
    });
  });

  describe('account state at completion', () => {
    it.each(['disabled', 'pending_passkey', 'invited'])('refuses an Admin who became %s after the password step', async (status) => {
      const t = await started();
      t.admin.status = status;
      await expectRefused(t.complete(t.answer()));
      expect(db.sessions).toHaveLength(0);
      expect(db.challenges[0].consumedAt).toBeNull(); // refused before the challenge was touched
    });

    it('refuses an Admin who became locked after the password step', async () => {
      const t = await started();
      t.admin.lockedUntil = later(600);
      await expectRefused(t.complete(t.answer()));
    });

    it('refuses an Admin disabled while the assertion was being verified', async () => {
      const t = await started();
      const realTransaction = fake.prisma.$transaction;
      fake.prisma.$transaction = (fn) => { t.admin.status = 'disabled'; return realTransaction(fn); };
      try {
        await expectRefused(t.complete(t.answer()));
      } finally {
        fake.prisma.$transaction = realTransaction;
      }
      expect(db.sessions).toHaveLength(0);
      expect(t.passkey.row.lastUsedAt).toBeNull();
    });

    it('rolls everything back, creating no session, when the audit write fails', async () => {
      const t = await started({ failedLoginCount: 1 }, { signCount: 5 });
      const answer = t.answer({ counter: 6 });
      db.failAudit = true;
      const error = await t.complete(answer).then(() => null, (e) => e);
      expect(error.message).toBe('audit write failed');
      expect(db.sessions).toHaveLength(0);
      expect(db.refreshTokens).toHaveLength(0);
      expect(t.passkey.row.signCount).toBe(5);
      expect(t.admin.failedLoginCount).toBe(2); // the attempt stays counted; nothing was cleared
      expect(db.events).toContain('rollback');
    });
  });
});

describe('policy that must not change', () => {
  it('an Admin with a passkey is still refused by the legacy password-only login', async () => {
    const admin = seedAdmin();
    seedPasskey(admin);
    expect(await loginAdmin(admin.email, PASSWORD)).toBeNull();
  });

  it('an Admin without a passkey still can use the legacy route while enforcement is off', async () => {
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-legacy-route';
    const admin = seedAdmin();
    const result = await loginAdmin(admin.email, PASSWORD);
    expect(result).toMatchObject({ admin: { id: admin.id } });
  });

  it('the legacy route still refuses everyone when enforcement is on', async () => {
    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    const admin = seedAdmin();
    expect(await loginAdmin(admin.email, PASSWORD)).toBeNull();
  });

  it('the new login works with enforcement on or off', async () => {
    const admin = seedAdmin();
    const passkey = seedPasskey(admin);
    await expect(kit.login(admin, passkey)).resolves.toHaveProperty('accessToken');
    process.env.ADMIN_PASSKEY_ENFORCEMENT = 'true';
    await expect(kit.login(admin, passkey, { now: later(60) })).resolves.toHaveProperty('accessToken');
  });

  it('there is no way to a session without the passkey step', async () => {
    const admin = seedAdmin();
    seedPasskey(admin);
    const { loginTicket } = await begin(admin);
    await expectRefused(completeAdminPasskeyLogin({ loginTicket, response: undefined, now: later(1) }));
    expect(db.sessions).toHaveLength(0);
  });

  it('refuses to run without valid WebAuthn configuration', async () => {
    const admin = seedAdmin();
    seedPasskey(admin);
    delete process.env.ADMIN_WEBAUTHN_ORIGIN;
    await expect(begin(admin)).rejects.toThrow('ADMIN_WEBAUTHN_ORIGIN');
    expect(admin.failedLoginCount).toBe(0);
  });

  it('requires a root Prisma client', async () => {
    await expect(beginAdminPasskeyLogin({ email: 'a@b.co', password: PASSWORD, db: { adminUser: {} } })).rejects.toThrow(TypeError);
    await expect(completeAdminPasskeyLogin({ loginTicket: 'x', response: {}, db: { adminUser: {} } })).rejects.toThrow(TypeError);
  });
});

describe('no secrets leak', () => {
  it('keeps passwords, tickets, challenges, assertions, tokens and credential material out of audit rows and logs', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const admin = seedAdmin();
    const passkey = seedPasskey(admin, { signCount: 5 });
    // a wrong password, a rollback, a bad assertion with failing audit, and finally a success
    await begin(admin, { password: 'WrongPass2027y' }).catch(() => {});
    const t1 = await begin(admin, { now: later(1) });
    const rollback = makeAssertionResponse({ challenge: t1.options.challenge, registered: passkey.reg, counter: 3 });
    await completeAdminPasskeyLogin({ loginTicket: t1.loginTicket, response: rollback, now: later(2) }).catch(() => {});
    const t2 = await begin(admin, { now: later(3) });
    db.failAudit = true;
    await completeAdminPasskeyLogin({ loginTicket: t2.loginTicket, response: makeAssertionResponse({ challenge: t2.options.challenge, registered: passkey.reg, counter: 6 }), now: later(4) }).catch(() => {});
    db.failAudit = false;
    const t3 = await begin(admin, { now: later(5) });
    const good = makeAssertionResponse({ challenge: t3.options.challenge, registered: passkey.reg, counter: 7 });
    const result = await completeAdminPasskeyLogin({ loginTicket: t3.loginTicket, response: good, now: later(6) });

    const everywhere = JSON.stringify(db.audits) + spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n');
    const secrets = [
      PASSWORD, 'WrongPass2027y', PASSWORD_HASH, t1.loginTicket, t3.loginTicket, t1.options.challenge, t3.options.challenge,
      result.accessToken, result.refreshToken, hashToken(result.refreshToken), good.response.signature, good.response.clientDataJSON,
      good.id, passkey.row.credentialIdHash, passkey.row.publicKey.toString('base64url'),
    ];
    for (const secret of secrets) expect(everywhere).not.toContain(secret);
  });
});
