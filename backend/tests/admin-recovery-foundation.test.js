// Foundation of two-person Admin passkey recovery (Step 7.9.2): the approval / rejection step-up
// challenge purposes, the recovery ticket, and the shared passkey-assertion verifier. No recovery
// workflow exists yet. No database: Prisma is the in-memory stand-in from admin-lock-fake-db.js.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const kit = require('./admin-login-test-kit');
const { makeAssertionResponse, makeRegistrationResponse, FLAG } = require('./admin-webauthn-test-authenticator');
const { signAdminEnrollmentTicket, readAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminLoginTicket, readAdminLoginTicket, ADMIN_LOGIN_FLOWS } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { signAdminAccessToken, verifyAdminAccessToken, deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('../src/modules/admin/auth/admin-token.service');
const {
  signAdminRecoveryTicket,
  readAdminRecoveryTicket,
  recoveryTicketMatches,
  ADMIN_RECOVERY_TICKET_AUDIENCE,
  ADMIN_RECOVERY_TICKET_TTL_SECONDS,
} = require('../src/modules/admin/auth/admin-recovery-ticket.service');
const {
  issueAdminWebAuthnChallenge,
  consumeAdminWebAuthnChallenge,
  ADMIN_WEBAUTHN_PURPOSES,
} = require('../src/modules/admin/auth/admin-webauthn-challenge.service');
const {
  verifyAdminPasskeyAssertion,
  advanceAdminPasskeyCounter,
  sanitizeAdminAssertionResponse,
  PasskeyAssertionError,
} = require('../src/modules/admin/auth/admin-passkey-assertion.service');
const { ADMIN_LOCK_POLICY } = require('../src/modules/admin/auth/admin-lock.config');

const { db, fake, NOW, PCA, later, seedAdmin, seedPasskey } = kit;

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

// ---- A. recovery step-up challenge purposes -----------------------------------------------

describe('recovery_approval and recovery_rejection challenges', () => {
  const PURPOSES = ['recovery_approval', 'recovery_rejection'];
  const bindings = { recoveryRequestId: 11, sessionId: 21 };
  const issue = (overrides = {}) => issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'recovery_approval', ...bindings, now: NOW, ...overrides });
  const consume = (overrides = {}) => consumeAdminWebAuthnChallenge({ adminId: 1, purpose: 'recovery_approval', ...bindings, now: later(5), ...overrides });
  const stored = (id) => db.challenges.find((c) => c.id === id);

  beforeEach(() => {
    seedAdmin();
    seedAdmin();
  });

  it('are registered purposes, next to the ones that already existed', () => {
    expect(ADMIN_WEBAUTHN_PURPOSES).toEqual(expect.arrayContaining([
      'registration', 'recovery_registration', 'authentication', 'unlock', 'recovery_approval', 'recovery_rejection',
    ]));
    for (const purpose of ADMIN_WEBAUTHN_PURPOSES) expect(purpose.length).toBeLessThanOrEqual(32); // the column width
  });

  it.each(PURPOSES)('%s keeps the 120-second lifetime', async (purpose) => {
    expect(ADMIN_LOCK_POLICY.recoveryStepUpChallengeTtlMs).toBe(120000);
    const result = await issue({ purpose });
    expect(result.expiresAt).toEqual(later(120));
    expect(stored(result.challengeId).expiresAt).toEqual(later(120));
  });

  it.each(PURPOSES)('%s is bound to the approver, the request and the session', async (purpose) => {
    const result = await issue({ purpose });
    expect(stored(result.challengeId)).toMatchObject({
      adminId: 1, purpose, recoveryRequestId: 11, sessionId: 21, invitationId: null, consumedAt: null,
    });
    const claimed = await consume({ purpose });
    expect(claimed).toMatchObject({ adminId: 1, purpose, recoveryRequestId: 11, sessionId: 21, challenge: result.challenge });
  });

  it.each(PURPOSES)('%s cannot be issued without BOTH bindings', async (purpose) => {
    for (const missing of ['recoveryRequestId', 'sessionId']) {
      for (const value of [undefined, null, 0, -1, '5', 1.5]) {
        await expect(issue({ purpose, [missing]: value })).rejects.toThrow(TypeError);
      }
    }
    expect(db.challenges).toHaveLength(0);
  });

  it.each(PURPOSES)('%s cannot be consumed without both bindings, nor as "unbound"', async (purpose) => {
    await issue({ purpose });
    for (const missing of ['recoveryRequestId', 'sessionId']) {
      for (const value of [undefined, null]) {
        await expect(consume({ purpose, [missing]: value })).rejects.toThrow(TypeError);
      }
    }
    expect(stored(1).consumedAt).toBeNull(); // nothing was claimed by the refused attempts
  });

  it.each(PURPOSES)('%s refuses a binding it does not allow', async (purpose) => {
    await expect(issue({ purpose, invitationId: 3 })).rejects.toThrow('not allowed');
  });

  it('are claimed only by the exact approver, request and session', async () => {
    await issue();
    expect(await consume({ adminId: 2 })).toBeNull(); // another Admin
    expect(await consume({ recoveryRequestId: 12 })).toBeNull(); // another request
    expect(await consume({ sessionId: 22 })).toBeNull(); // another session
    expect(stored(1).consumedAt).toBeNull();
    expect(await consume()).not.toBeNull();
  });

  it('cannot be used across purposes: an approval challenge never serves a rejection, or any other flow', async () => {
    await issue({ purpose: 'recovery_approval' });
    expect(await consume({ purpose: 'recovery_rejection' })).toBeNull();
    for (const purpose of ['authentication', 'registration', 'recovery_registration', 'unlock']) {
      const extra = purpose === 'unlock' || purpose === 'registration' ? { sessionId: 21 } : purpose === 'recovery_registration' ? { recoveryRequestId: 11 } : {};
      expect(await consumeAdminWebAuthnChallenge({ adminId: 1, purpose, ...extra, now: later(5) })).toBeNull();
    }
    expect(stored(1).consumedAt).toBeNull();
    expect(await consume({ purpose: 'recovery_approval' })).not.toBeNull();
  });

  it('are single-use: a replay finds nothing, even though everything else matches', async () => {
    await issue();
    expect(await consume()).not.toBeNull();
    expect(await consume()).toBeNull();
    expect(await consume({ now: later(6) })).toBeNull();
  });

  it('of simultaneous attempts, exactly one wins', async () => {
    await issue();
    const results = await Promise.all(Array.from({ length: 8 }, () => consume()));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('expire at exactly 120 seconds', async () => {
    await issue();
    expect(await consume({ now: later(119) })).not.toBeNull();
    await issue();
    expect(await consume({ now: later(120) })).toBeNull();
  });

  it('a newer one retires the older one of the same purpose, but never touches the other purpose', async () => {
    const first = await issue({ purpose: 'recovery_approval' });
    const reject = await issue({ purpose: 'recovery_rejection' });
    const second = await issue({ purpose: 'recovery_approval' });
    expect(stored(first.challengeId).consumedAt).not.toBeNull();
    expect(stored(reject.challengeId).consumedAt).toBeNull();
    expect(stored(second.challengeId).consumedAt).toBeNull();
    expect(await consume({ purpose: 'recovery_approval', challengeId: first.challengeId })).toBeNull();
  });

  it('leaves the existing purposes exactly as they were', async () => {
    const reg = await issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'recovery_registration', recoveryRequestId: 5, now: NOW });
    expect(stored(reg.challengeId)).toMatchObject({ purpose: 'recovery_registration', recoveryRequestId: 5, sessionId: null });
    // still optional for them
    await expect(issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'registration', now: NOW })).resolves.toBeTruthy();
    await expect(issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'authentication', now: NOW })).resolves.toBeTruthy();
    await expect(issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'unlock', sessionId: 2, now: NOW })).resolves.toBeTruthy();
    await expect(issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'authentication', recoveryRequestId: 5, now: NOW })).rejects.toThrow('not allowed');
  });
});

// ---- B. recovery ticket ------------------------------------------------------------------

describe('recovery ticket', () => {
  const claimsInput = { adminId: 7, recoveryRequestId: 31, invitationId: 41, passwordChangedAt: PCA };
  const sign = (overrides = {}) => signAdminRecoveryTicket({ ...claimsInput, ...overrides });
  const resign = (mutate, options = {}) => {
    const payload = { ...jwt.decode(sign()) };
    mutate(payload);
    return jwt.sign(payload, deriveAdminKey('humancare/admin-lock/recovery-ticket/v1'), { algorithm: 'HS256', ...options });
  };

  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-recovery-ticket';
  });

  it('carries the Admin, request, invitation, password state, a unique id, issuer, audience and a 10-minute expiry', () => {
    const decoded = jwt.decode(sign());
    expect(decoded).toMatchObject({
      sub: '7', flow: 'passkey_recovery', rid: 31, inv: 41, pca: PCA.getTime(), iss: ADMIN_TOKEN_ISSUER, aud: ADMIN_RECOVERY_TICKET_AUDIENCE,
    });
    expect(decoded.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(decoded.exp - decoded.iat).toBe(600);
    expect(ADMIN_RECOVERY_TICKET_TTL_SECONDS).toBe(600);
    expect(sign()).not.toBe(sign()); // distinct ids
    expect(jwt.decode(sign()).jti).not.toBe(decoded.jti);
  });

  it('reads back exactly what was signed', () => {
    expect(readAdminRecoveryTicket(sign())).toEqual({
      adminId: 7,
      recoveryRequestId: 31,
      invitationId: 41,
      passwordChangedAt: PCA,
      ticketId: expect.any(String),
      expiresAt: expect.any(Date),
    });
  });

  it.each([
    ['adminId', { adminId: 0 }], ['adminId', { adminId: '7' }], ['request id', { recoveryRequestId: -1 }],
    ['request id', { recoveryRequestId: undefined }], ['invitation id', { invitationId: 1.5 }], ['invitation id', { invitationId: null }],
    ['password time', { passwordChangedAt: undefined }], ['password time', { passwordChangedAt: new Date('x') }], ['password time', { passwordChangedAt: PCA.getTime() }],
  ])('refuses to sign with a bad %s', (_label, overrides) => {
    expect(() => sign(overrides)).toThrow();
  });

  it('expires at 600 seconds (valid before, refused after)', () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const ticket = sign();
      jest.setSystemTime(new Date(NOW.getTime() + 599 * 1000));
      expect(readAdminRecoveryTicket(ticket)).not.toBeNull();
      jest.setSystemTime(new Date(NOW.getTime() + 601 * 1000));
      expect(readAdminRecoveryTicket(ticket)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a tampered ticket: any changed claim, a swapped signature, or a stripped one', () => {
    const [header, body, signature] = sign().split('.');
    const forge = (patch) => {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      return [header, Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url'), signature].join('.');
    };
    for (const patch of [{ sub: '8' }, { rid: 32 }, { inv: 42 }, { pca: PCA.getTime() + 1 }, { flow: 'passkey_enrollment' }]) {
      expect(readAdminRecoveryTicket(forge(patch))).toBeNull();
    }
    expect(readAdminRecoveryTicket(`${header}.${body}.`)).toBeNull();
    expect(readAdminRecoveryTicket(`${header}.${body}.${signature.slice(0, -2)}xx`)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(readAdminRecoveryTicket(`${none}.${body}.`)).toBeNull();
  });

  it.each([undefined, null, '', 'not.a.jwt', 12, {}, []])('reads %p as no ticket', (value) => {
    expect(readAdminRecoveryTicket(value)).toBeNull();
  });

  it('refuses a ticket signed with the wrong audience, issuer, algorithm, or a different secret', () => {
    const key = deriveAdminKey('humancare/admin-lock/recovery-ticket/v1');
    const base = { flow: 'passkey_recovery', rid: 31, inv: 41, pca: PCA.getTime() };
    const good = { algorithm: 'HS256', subject: '7', issuer: ADMIN_TOKEN_ISSUER, audience: ADMIN_RECOVERY_TICKET_AUDIENCE, jwtid: 'x', expiresIn: 600 };
    expect(readAdminRecoveryTicket(jwt.sign(base, key, good))).not.toBeNull(); // the control
    expect(readAdminRecoveryTicket(jwt.sign(base, key, { ...good, audience: 'humancare-admin-enrollment-ticket' }))).toBeNull();
    expect(readAdminRecoveryTicket(jwt.sign(base, key, { ...good, issuer: 'someone-else' }))).toBeNull();
    expect(readAdminRecoveryTicket(jwt.sign(base, key, { ...good, algorithm: 'HS512' }))).toBeNull();
    expect(readAdminRecoveryTicket(jwt.sign(base, 'a-different-secret', good))).toBeNull();
    const ticket = sign();
    process.env.JWT_ACCESS_SECRET = 'rotated-secret-value';
    expect(readAdminRecoveryTicket(ticket)).toBeNull();
  });

  it('refuses malformed claims even when correctly signed', () => {
    expect(readAdminRecoveryTicket(resign((p) => { p.rid = '31'; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { p.inv = 0; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { p.pca = 'x'; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { delete p.jti; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { p.flow = 'passkey_login'; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { p.sub = '07'; }))).toBeNull();
    expect(readAdminRecoveryTicket(resign((p) => { p.exp = p.iat + 3600; }))).toBeNull(); // not exactly 600 s
  });

  it('is not interchangeable with any other token: flows and keys are separate', () => {
    const recovery = sign();
    const enrollment = signAdminEnrollmentTicket({ adminId: 7, invitationId: 41, passwordChangedAt: PCA });
    const login = signAdminLoginTicket({ adminId: 7, flow: ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN });
    const access = signAdminAccessToken({ adminId: 7, role: 'admin', sessionId: 3 });

    // other tokens are not recovery tickets
    for (const other of [enrollment, login, access]) expect(readAdminRecoveryTicket(other)).toBeNull();
    // and a recovery ticket is none of them
    expect(readAdminEnrollmentTicket(recovery)).toBeNull();
    for (const flow of Object.values(ADMIN_LOGIN_FLOWS)) expect(readAdminLoginTicket(recovery, flow)).toBeNull();
    expect(verifyAdminAccessToken(recovery)).toBeNull();
    expect(() => jwt.verify(recovery, deriveAdminKey('humancare/admin-lock/enrollment-ticket/v1'), { algorithms: ['HS256'] })).toThrow();
  });

  it('cannot be verified with the raw access secret', () => {
    expect(() => jwt.verify(sign(), process.env.JWT_ACCESS_SECRET)).toThrow();
  });

  it('throws (never returns null) when the signing secret is missing, and never exposes it', () => {
    const ticket = sign();
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => readAdminRecoveryTicket(ticket)).toThrow('JWT_ACCESS_SECRET is not set');
    expect(() => sign()).toThrow('JWT_ACCESS_SECRET is not set');
  });

  describe('recoveryTicketMatches (what the database must still say)', () => {
    const admin = (o = {}) => ({ id: 7, status: 'active', passwordChangedAt: PCA, ...o });
    const request = (o = {}) => ({ id: 31, adminId: 7, status: 'approved', expiresAt: new Date(NOW.getTime() + 3600 * 1000), ...o });
    const invitation = (o = {}) => ({ id: 41, adminId: 7, purpose: 'passkey_recovery', recoveryRequestId: 31, usedAt: NOW, revokedAt: null, ...o });
    const claims = () => readAdminRecoveryTicket(sign());
    const matches = (rows) => recoveryTicketMatches(claims(), { admin: admin(), request: request(), invitation: invitation(), now: NOW, ...rows });

    it('accepts exactly the rows it was issued for', () => {
      expect(matches({})).toBe(true);
    });

    it.each(['pending', 'rejected', 'completed', 'expired', 'cancelled', 'APPROVED', '', null, undefined])(
      'refuses a request whose status is %p', (status) => {
        expect(matches({ request: request({ status }) })).toBe(false);
      },
    );

    describe('the request deadline (expiresAt)', () => {
      it('accepts an approved request whose expiresAt is in the future', () => {
        expect(matches({ request: request({ expiresAt: new Date(NOW.getTime() + 1) }) })).toBe(true);
        expect(matches({ request: request({ expiresAt: new Date(NOW.getTime() + 7 * 24 * 3600 * 1000) }) })).toBe(true);
      });

      it('refuses an approved request whose expiresAt equals now', () => {
        expect(matches({ request: request({ expiresAt: new Date(NOW.getTime()) }) })).toBe(false);
      });

      it('refuses an approved request whose expiresAt is in the past', () => {
        expect(matches({ request: request({ expiresAt: new Date(NOW.getTime() - 1) }) })).toBe(false);
        expect(matches({ request: request({ expiresAt: new Date(NOW.getTime() - 3600 * 1000) }) })).toBe(false);
      });

      it('fails closed when the deadline is missing or not a date', () => {
        for (const expiresAt of [undefined, null, '2999-01-01T00:00:00Z', NOW.getTime() + 1000, new Date('x')]) {
          expect(matches({ request: request({ expiresAt }) })).toBe(false);
        }
      });

      it('uses the supplied clock, and the current time by default', () => {
        const row = request({ expiresAt: new Date(NOW.getTime() + 1000) });
        expect(matches({ request: row, now: new Date(NOW.getTime() + 999) })).toBe(true);
        expect(matches({ request: row, now: new Date(NOW.getTime() + 1000) })).toBe(false);
        expect(matches({ request: row, now: new Date('x') })).toBe(false);
        // no `now`: the real clock, against a request that expired long ago / far in the future
        const noNow = (expiresAt) => recoveryTicketMatches(claims(), { admin: admin(), request: request({ expiresAt }), invitation: invitation() });
        expect(noNow(new Date('2001-01-01T00:00:00Z'))).toBe(false);
        expect(noNow(new Date('2999-01-01T00:00:00Z'))).toBe(true);
      });

      it('is checked together with the status: an expired deadline cannot be rescued by "approved", nor a future one by another status', () => {
        expect(matches({ request: request({ status: 'approved', expiresAt: new Date(NOW.getTime() - 1) }) })).toBe(false);
        expect(matches({ request: request({ status: 'pending' }) })).toBe(false);
      });
    });

    it('is killed by a password change', () => {
      expect(matches({ admin: admin({ passwordChangedAt: new Date(PCA.getTime() + 1000) }) })).toBe(false);
      expect(matches({ admin: admin({ passwordChangedAt: null }) })).toBe(false);
    });

    it.each(['disabled', 'invited', 'pending_passkey', 'locked', undefined])('refuses an Admin who is %p', (status) => {
      expect(matches({ admin: admin({ status }) })).toBe(false);
    });

    it('refuses any mismatched id', () => {
      expect(matches({ admin: admin({ id: 8 }) })).toBe(false);
      expect(matches({ request: request({ id: 32 }) })).toBe(false);
      expect(matches({ request: request({ adminId: 8 }) })).toBe(false);
      expect(matches({ invitation: invitation({ id: 42 }) })).toBe(false);
      expect(matches({ invitation: invitation({ adminId: 8 }) })).toBe(false);
      expect(matches({ invitation: invitation({ recoveryRequestId: 32 }) })).toBe(false);
      expect(matches({ invitation: invitation({ recoveryRequestId: null }) })).toBe(false);
    });

    it('refuses an invitation of another purpose, one never redeemed, or one revoked', () => {
      for (const purpose of ['activation', 'passkey_enrollment', 'Passkey_Recovery', undefined]) {
        expect(matches({ invitation: invitation({ purpose }) })).toBe(false);
      }
      expect(matches({ invitation: invitation({ usedAt: null }) })).toBe(false);
      expect(matches({ invitation: invitation({ revokedAt: NOW }) })).toBe(false);
    });

    it('refuses missing rows or claims', () => {
      expect(recoveryTicketMatches(null, { admin: admin(), request: request(), invitation: invitation() })).toBe(false);
      expect(recoveryTicketMatches(claims(), {})).toBe(false);
      expect(recoveryTicketMatches(claims())).toBe(false);
      for (const key of ['admin', 'request', 'invitation']) {
        expect(matches({ [key]: null })).toBe(false);
      }
    });
  });
});

// ---- C. shared passkey-assertion verifier -------------------------------------------------

describe('verifyAdminPasskeyAssertion (shared by login and recovery step-up)', () => {
  const RP = { rpId: 'localhost', origin: 'http://localhost:3000' };
  const CHALLENGE = crypto.randomBytes(32).toString('base64url');

  function setup(options = {}) {
    const admin = seedAdmin();
    const passkey = seedPasskey(admin, options);
    const assert = (overrides = {}) => makeAssertionResponse({ challenge: CHALLENGE, registered: passkey.reg, counter: 1, ...overrides });
    const verify = (response, extra = {}) => verifyAdminPasskeyAssertion({
      adminId: admin.id, response, expectedChallenge: CHALLENGE, ...RP, ...extra,
    });
    return { admin, passkey, assert, verify };
  }

  async function refusedWith(promise, reason) {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(PasskeyAssertionError);
    expect(error.reason).toBe(reason);
    expect(Object.keys(error).sort()).toEqual(['code', 'name']); // the reason is never serialised
    return error;
  }

  it('verifies a genuine assertion and returns the credential and the counter to store, creating nothing', async () => {
    const { admin, passkey, assert, verify } = setup();
    const result = await verify(assert());
    expect(result.newCounter).toBe(1);
    expect(result.passkey).toMatchObject({ id: passkey.row.id, adminId: admin.id, signCount: 0 });
    // no session, token, ticket or challenge row, and the stored counter is untouched
    expect(db.sessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
    expect(db.challenges).toHaveLength(0);
    expect(db.passkeys[0].signCount).toBe(0);
    expect(Object.keys(result).sort()).toEqual(['newCounter', 'passkey']);
  });

  it('works for ES256 and RS256 credentials', async () => {
    for (const key of ['es256', 'rs256']) {
      fake.reset();
      const { assert, verify } = setup({ key });
      await expect(verify(assert())).resolves.toMatchObject({ newCounter: 1 });
    }
  });

  it('refuses another Admin\'s genuine credential, an unknown one and a revoked one', async () => {
    const { admin, assert, verify } = setup();
    const other = seedAdmin();
    const theirs = seedPasskey(other);
    await refusedWith(verify(makeAssertionResponse({ challenge: CHALLENGE, registered: theirs.reg })), 'unknown_credential');
    await refusedWith(verifyAdminPasskeyAssertion({ adminId: other.id, response: assert(), expectedChallenge: CHALLENGE, ...RP }), 'unknown_credential');
    db.passkeys[0].revokedAt = NOW;
    await refusedWith(verify(assert()), 'unknown_credential');
    expect(admin.id).not.toBe(other.id);
  });

  it('checks the userHandle when present', async () => {
    const { admin, assert, verify } = setup();
    const { deriveAdminWebAuthnUserHandle } = require('../src/modules/admin/auth/admin-webauthn.helpers');
    await expect(verify(assert({ userHandle: deriveAdminWebAuthnUserHandle(admin.id) }))).resolves.toBeTruthy();
    await refusedWith(verify(assert({ userHandle: deriveAdminWebAuthnUserHandle(admin.id + 1) })), 'wrong_user_handle');
  });

  it('enforces the signature counter, auditing a regression by name without revoking the credential', async () => {
    const { assert, verify } = setup({ signCount: 5 });
    await refusedWith(verify(assert({ counter: 5 })), 'counter_regression');
    await refusedWith(verify(assert({ counter: 3 })), 'counter_regression');
    expect(db.audits.filter((a) => a.event === 'admin_passkey_counter_regression')).toHaveLength(2);
    expect(db.audits[0].detail).toEqual({ passkeyId: 1, storedCount: 5, reportedCount: 5 });
    expect(db.passkeys[0].revokedAt).toBeNull();
    await expect(verify(assert({ counter: 6 }))).resolves.toMatchObject({ newCounter: 6 });
  });

  it('accepts a zero/zero authenticator but not a zero after a non-zero counter', async () => {
    const zero = setup();
    await expect(zero.verify(zero.assert({ counter: 0 }))).resolves.toMatchObject({ newCounter: 0 });
    fake.reset();
    const used = setup({ signCount: 2 });
    await refusedWith(used.verify(used.assert({ counter: 0 })), 'counter_regression');
  });

  it('refuses a wrong challenge, origin, RP ID, ceremony type and a bad signature', async () => {
    const { assert, verify } = setup();
    await refusedWith(verify(assert({ challenge: crypto.randomBytes(32).toString('base64url') })), 'verification_failed');
    await refusedWith(verify(assert({ origin: 'https://evil.example' })), 'verification_failed');
    await refusedWith(verify(assert({ rpId: 'evil.example' })), 'verification_failed');
    await refusedWith(verify(assert({ type: 'webauthn.create' })), 'verification_failed');
    // a wrong signature is reported by the library as "not verified", which the result check refuses
    await refusedWith(verify(assert({ signWith: makeRegistrationResponse({ challenge: CHALLENGE }).privateKey })), 'invalid_result');
    await refusedWith(verify(assert(), { origin: 'http://localhost:3001' }), 'verification_failed');
    await refusedWith(verify(assert(), { rpId: 'example.org' }), 'verification_failed');
  });

  it('requires user verification, not just presence', async () => {
    const { assert, verify } = setup();
    await refusedWith(verify(assert({ flags: FLAG.UP })), 'verification_failed');
    await refusedWith(verify(assert({ flags: FLAG.UV })), 'verification_failed');
  });

  it('refuses malformed or oversized responses before any database work', async () => {
    const { assert, verify } = setup();
    const good = assert();
    const bad = [
      undefined, null, 'x', {}, { ...good, type: 'other' }, { ...good, id: '' }, { ...good, id: 'a b' },
      { ...good, response: null }, { ...good, response: { ...good.response, signature: 'x'.repeat(3000) } },
      { ...good, response: { ...good.response, clientDataJSON: 5 } }, { ...good, response: { ...good.response, userHandle: '***' } },
    ];
    const lookups = jest.spyOn(fake.prisma.adminPasskey, 'findFirst');
    for (const response of bad) await refusedWith(verify(response), 'invalid_response');
    expect(lookups).not.toHaveBeenCalled();
  });

  it('hands the library only the known fields', async () => {
    const { assert } = setup();
    const response = assert();
    const cleaned = sanitizeAdminAssertionResponse({ ...response, extra: 'x', response: { ...response.response, extra: 'y' } });
    expect(cleaned).toEqual({ ...response, clientExtensionResults: {} });
    expect(sanitizeAdminAssertionResponse(cleaned)).toEqual(cleaned); // idempotent
  });

  it('lets a non-assertion failure (the database) through unchanged, so callers can fail closed', async () => {
    const { assert, verify } = setup();
    const boom = new Error('database down');
    jest.spyOn(fake.prisma.adminPasskey, 'findFirst').mockRejectedValue(boom);
    await expect(verify(assert())).rejects.toBe(boom);
  });

  describe('advanceAdminPasskeyCounter', () => {
    it('advances once, only from the verified value, and only for a live credential', async () => {
      const { admin, assert, verify } = setup();
      const { passkey, newCounter } = await verify(assert());
      const advance = () => fake.prisma.$transaction((tx) => advanceAdminPasskeyCounter(tx, { adminId: admin.id, passkey, newCounter, now: later(5) }));
      expect(await advance()).toBe(true);
      expect(db.passkeys[0]).toMatchObject({ signCount: 1, lastUsedAt: later(5) });
      expect(await advance()).toBe(false); // a second assertion racing on the same credential loses

      const second = seedPasskey(admin);
      const verified = { adminId: admin.id, passkey: { ...second.row }, newCounter: 4, now: later(6) };
      db.passkeys.find((p) => p.id === second.row.id).revokedAt = NOW;
      expect(await fake.prisma.$transaction((tx) => advanceAdminPasskeyCounter(tx, verified))).toBe(false);
    });

    it('of two simultaneous advances, exactly one wins', async () => {
      const { admin, assert, verify } = setup();
      const { passkey, newCounter } = await verify(assert());
      const results = await Promise.all([1, 2, 3].map(() => fake.prisma.$transaction((tx) => advanceAdminPasskeyCounter(tx, { adminId: admin.id, passkey, newCounter, now: later(5) }))));
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
