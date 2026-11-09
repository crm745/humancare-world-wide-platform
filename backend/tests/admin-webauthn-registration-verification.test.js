// Registration verification (Step 7.7.5). No database: Prisma is the in-memory stand-in from
// admin-lock-fake-db.js. The REAL @simplewebauthn/server verifies genuine responses built by the
// software authenticator in admin-webauthn-test-authenticator.js; the verifier is only replaced
// where a test must inject a result the real library would never produce.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('@simplewebauthn/server', () => {
  const actual = jest.requireActual('@simplewebauthn/server');
  return {
    ...actual,
    generateRegistrationOptions: jest.fn(actual.generateRegistrationOptions),
    verifyRegistrationResponse: jest.fn(actual.verifyRegistrationResponse),
  };
});

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const server = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const fake = require('./admin-lock-fake-db');
const { makeRegistrationResponse, FLAG } = require('./admin-webauthn-test-authenticator');
const {
  generateAdminPasskeyRegistrationOptions,
  verifyAdminPasskeyRegistration,
  PasskeyRegistrationError,
} = require('../src/modules/admin/auth/admin-webauthn-registration.service');
const { signAdminEnrollmentTicket } = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const { signAdminLoginTicket } = require('../src/modules/admin/auth/admin-login-ticket.service');
const { deriveAdminKey, ADMIN_TOKEN_ISSUER } = require('../src/modules/admin/auth/admin-token.service');

const actualServer = jest.requireActual('@simplewebauthn/server');
const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const PCA = new Date('2027-02-28T09:00:00.000Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);
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
    expiresAt: new Date(PCA.getTime() + 72 * 3600 * 1000),
    usedAt: PCA,
    revokedAt: null,
    ...overrides,
  };
  db.invitations.push(invitation);
  return invitation;
}

// A pending Admin with a used invitation and a ticket. With `options`, also requests registration
// options (creating the open challenge) so that a response can be built for it.
async function begin({ options = true, adminOverrides = {}, invitationOverrides = {} } = {}) {
  const admin = seedAdmin(adminOverrides);
  const invitation = seedInvitation(admin, invitationOverrides);
  const ticket = signAdminEnrollmentTicket({ adminId: admin.id, invitationId: invitation.id, passwordChangedAt: PCA });
  const ctx = { admin, invitation, ticket };
  if (options) ctx.options = await generateAdminPasskeyRegistrationOptions({ ticket, now: NOW });
  return ctx;
}

const authenticate = (ctx, overrides = {}) => makeRegistrationResponse({ challenge: ctx.options.challenge, ...overrides });
const verify = (ctx, response, overrides = {}) => verifyAdminPasskeyRegistration({ ticket: ctx.ticket, response, now: later(5), ...overrides });

async function expectGenericFailure(promise) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(PasskeyRegistrationError);
  expect(error).toMatchObject({ code: 'invalid_enrollment', message: 'This passkey setup session is not valid. Please start again.' });
  return error;
}

const expectNothingStored = (admin) => {
  expect(db.passkeys).toHaveLength(0);
  expect(admin.status).toBe('pending_passkey');
  expect(db.audits.filter((a) => a.event === 'admin_passkey_registered')).toHaveLength(0);
};

beforeEach(() => {
  fake.reset();
  server.generateRegistrationOptions.mockClear();
  server.verifyRegistrationResponse.mockReset().mockImplementation(actualServer.verifyRegistrationResponse);
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-registration-verify';
  process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
  process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
  delete process.env.NODE_ENV;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('a valid registration', () => {
  it('stores the credential, activates the Admin and reports success without any token', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    const result = await verify(ctx, auth.response);
    expect(result).toEqual({ status: 'active', nextStep: 'sign_in' });
    expect(ctx.admin.status).toBe('active');
    expect(db.passkeys).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/token|session|jwt|bearer|cookie|adminId|passkeyId/i);
  });

  it('works for RS256 as well as ES256', async () => {
    const ctx = await begin();
    await expect(verify(ctx, authenticate(ctx, { key: 'rs256' }).response)).resolves.toMatchObject({ status: 'active' });
  });

  it('uses the real library with the configured RP, origin, ceremony type, UV, UP and algorithms', async () => {
    const ctx = await begin();
    await verify(ctx, authenticate(ctx).response);
    const [args] = server.verifyRegistrationResponse.mock.calls[0];
    expect(args).toMatchObject({
      expectedChallenge: ctx.options.challenge,
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  });

  it('never takes the Admin, invitation, challenge, RP, origin, handle, key, hash or status from the caller', async () => {
    const ctx = await begin();
    const other = seedAdmin({ email: 'other@example.org' });
    const auth = authenticate(ctx);
    const forged = {
      ...auth.response,
      adminId: other.id, invitationId: 99, challengeId: 1, expectedChallenge: 'x', rpId: 'evil.example', origin: 'https://evil.example',
      userHandle: 'evil', publicKey: 'evil', credentialIdHash: 'evil', role: 'superadmin', status: 'active',
    };
    await verifyAdminPasskeyRegistration({
      ticket: ctx.ticket, response: forged, now: later(5), adminId: other.id, status: 'active', expectedChallenge: 'x', rpId: 'evil.example', origin: 'https://evil.example',
    });
    const [args] = server.verifyRegistrationResponse.mock.calls[0];
    expect(Object.keys(args.response).sort()).toEqual(['clientExtensionResults', 'id', 'rawId', 'response', 'type']);
    expect(args.expectedRPID).toBe('localhost');
    expect(db.passkeys[0].adminId).toBe(ctx.admin.id);
    expect(other.status).toBe('pending_passkey');
    expect(db.passkeys[0].credentialIdHash).toBe(crypto.createHash('sha256').update(auth.credentialId).digest('hex'));
  });
});

describe('ticket and account state (refused before the challenge is touched)', () => {
  async function expectRefusedWithChallengeIntact(ctx, mutate, ticket = ctx.ticket) {
    const auth = authenticate(ctx);
    mutate?.();
    await expectGenericFailure(verifyAdminPasskeyRegistration({ ticket, response: auth.response, now: later(5) }));
    expectNothingStored(ctx.admin.status === 'pending_passkey' ? ctx.admin : { status: 'pending_passkey' });
    expect(db.challenges.find((c) => c.consumedAt !== null && c.purpose === 'registration' && c.adminId === ctx.admin.id)).toBeUndefined();
  }

  it('rejects an invalid, missing or tampered ticket', async () => {
    const ctx = await begin();
    const response = authenticate(ctx).response;
    for (const bad of [undefined, '', 'garbage', 12345, `${ctx.ticket.slice(0, -2)}xx`]) {
      await expectGenericFailure(verifyAdminPasskeyRegistration({ ticket: bad, response, now: later(5) }));
    }
    expect(db.challenges[0].consumedAt).toBeNull();
    expectNothingStored(ctx.admin);
  });

  it('rejects an expired ticket (valid at 599 s, refused at 601 s)', async () => {
    const ctx = await begin();
    const second = await begin({ adminOverrides: { email: 'second@example.org' } }); // both tickets issued now
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start + 599 * 1000);
    await expect(verify(ctx, authenticate(ctx).response)).resolves.toMatchObject({ status: 'active' });
    Date.now.mockReturnValue(start + 601 * 1000);
    await expectGenericFailure(verify(second, authenticate(second).response));
  });

  it('rejects a ticket of the wrong flow or audience', async () => {
    const ctx = await begin();
    const response = authenticate(ctx).response;
    await expectGenericFailure(verifyAdminPasskeyRegistration({ ticket: signAdminLoginTicket({ adminId: ctx.admin.id, flow: 'passkey_login' }), response, now: later(5) }));
    const forged = jwt.sign({ flow: 'passkey_login', inv: ctx.invitation.id, pca: PCA.getTime() }, deriveAdminKey('humancare/admin-lock/enrollment-ticket/v1'), {
      algorithm: 'HS256', issuer: ADMIN_TOKEN_ISSUER, audience: 'humancare-admin-enrollment-ticket', subject: String(ctx.admin.id), jwtid: 'x', expiresIn: 600,
    });
    await expectGenericFailure(verifyAdminPasskeyRegistration({ ticket: forged, response, now: later(5) }));
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  it('rejects a ticket bound to a different Admin than its invitation and password marker', async () => {
    const ctx = await begin();
    const second = seedAdmin({ email: 'second@example.org', passwordChangedAt: new Date(PCA.getTime() + 9000) });
    const secondInvitation = seedInvitation(second);
    const wrongBinding = signAdminEnrollmentTicket({ adminId: second.id, invitationId: secondInvitation.id, passwordChangedAt: PCA });
    await expectRefusedWithChallengeIntact(ctx, null, wrongBinding);
  });

  it('rejects when the password changed after the ticket was issued', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.admin.passwordChangedAt = new Date(PCA.getTime() + 1); });
  });

  it('rejects an Admin that no longer has a password marker', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.admin.passwordChangedAt = null; });
  });

  it('rejects an Admin that does not exist', async () => {
    const ghost = signAdminEnrollmentTicket({ adminId: 404, invitationId: 1, passwordChangedAt: PCA });
    await expectGenericFailure(verifyAdminPasskeyRegistration({ ticket: ghost, response: makeRegistrationResponse({ challenge: 'x' }).response, now: later(5) }));
  });

  it.each(['invited', 'active', 'disabled', 'something_else'])('rejects status %s', async (status) => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.admin.status = status; });
    ctx.admin.status = 'pending_passkey';
  });

  it('rejects a missing invitation', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { db.invitations.length = 0; });
  });

  it('rejects an invitation that belongs to another Admin', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.invitation.adminId = 999; });
  });

  it.each(['passkey_recovery', 'Passkey_Enrollment', ''])('rejects invitation purpose %p', async (purpose) => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.invitation.purpose = purpose; });
  });

  it('rejects an unused invitation', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.invitation.usedAt = null; });
  });

  it('rejects a revoked invitation', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.invitation.revokedAt = NOW; });
  });

  it('rejects an invitation that was used only after it expired', async () => {
    const ctx = await begin();
    await expectRefusedWithChallengeIntact(ctx, () => { ctx.invitation.expiresAt = new Date(PCA.getTime() - 1); });
  });

  it('rejects an Admin who already has an unrevoked passkey, and ignores revoked ones', async () => {
    const ctx = await begin();
    db.passkeys.push({ id: 1, adminId: ctx.admin.id, credentialIdHash: 'a'.repeat(64), credentialId: Buffer.alloc(32), revokedAt: null });
    await expectGenericFailure(verify(ctx, authenticate(ctx).response));
    expect(db.passkeys).toHaveLength(1); // nothing added
    expect(ctx.admin.status).toBe('pending_passkey');
    expect(db.challenges[0].consumedAt).toBeNull(); // refused before the challenge was touched
    db.passkeys[0].revokedAt = NOW; // revoked passkeys do not block
    await expect(verify(ctx, authenticate(ctx).response)).resolves.toMatchObject({ status: 'active' });
  });

  it('records a refusal for a valid ticket with a reason code only', async () => {
    const ctx = await begin();
    ctx.admin.status = 'disabled';
    await expectGenericFailure(verify(ctx, authenticate(ctx).response, { ipAddress: '203.0.113.4' }));
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ event: 'admin_passkey_registration_failed', actorType: 'admin', actorId: ctx.admin.id, ipAddress: '203.0.113.4', detail: { reason: 'state_changed' } });
  });

  it('refuses to run without valid WebAuthn configuration', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    delete process.env.ADMIN_WEBAUTHN_ORIGIN;
    await expect(verify(ctx, auth.response)).rejects.toThrow('ADMIN_WEBAUTHN_ORIGIN');
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  it('requires a root Prisma client, never a transaction client', async () => {
    const ctx = await begin();
    await expect(verifyAdminPasskeyRegistration({ ticket: ctx.ticket, response: authenticate(ctx).response, db: { adminUser: {} } })).rejects.toThrow(TypeError);
  });
});

describe('the challenge', () => {
  it('rejects when no challenge was ever issued', async () => {
    const ctx = await begin({ options: false });
    const response = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url') }).response;
    await expectGenericFailure(verify(ctx, response));
    expectNothingStored(ctx.admin);
    expect(server.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge (valid at 119 s, refused at 120 s)', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    await expectGenericFailure(verify(ctx, auth.response, { now: later(120) }));
    expect(server.verifyRegistrationResponse).not.toHaveBeenCalled();
    expectNothingStored(ctx.admin);
    await expect(verify(ctx, auth.response, { now: later(119) })).resolves.toMatchObject({ status: 'active' });
  });

  it('rejects a challenge that was already consumed', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    db.challenges[0].consumedAt = later(1);
    await expectGenericFailure(verify(ctx, auth.response));
    expect(server.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects a challenge issued to another Admin', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    db.challenges[0].adminId = 999;
    await expectGenericFailure(verify(ctx, auth.response));
    expect(server.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects a challenge bound to another invitation', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    db.challenges[0].invitationId = 999;
    await expectGenericFailure(verify(ctx, auth.response));
  });

  it('rejects a challenge bound to a session, and one for another purpose', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    db.challenges[0].sessionId = 5;
    await expectGenericFailure(verify(ctx, auth.response));
    db.challenges[0].sessionId = null;
    db.challenges[0].purpose = 'authentication';
    await expectGenericFailure(verify(ctx, auth.response));
  });

  it('is consumed - and committed - before the verifier runs', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    let seen;
    server.verifyRegistrationResponse.mockImplementationOnce(async (args) => {
      seen = { consumedAt: db.challenges[0].consumedAt, events: [...db.events], inTransaction: db.events.at(-1) !== 'commit' && db.events.includes('rollback') };
      return actualServer.verifyRegistrationResponse(args);
    });
    await verify(ctx, auth.response);
    expect(seen.consumedAt).toEqual(later(5));
    // Before verification there is no open transaction holding the consumption: the claim is its own
    // statement, so the only 'commit' events seen so far belong to the earlier options request.
    expect(seen.events.filter((e) => e === 'commit')).toHaveLength(1);
    expect(seen.events.at(-1)).toBe('challenges.update');
  });

  it('is not restored when verification fails: the same response cannot be tried again', async () => {
    const ctx = await begin();
    const wrongOrigin = authenticate(ctx, { origin: 'https://evil.example' });
    await expectGenericFailure(verify(ctx, wrongOrigin.response));
    expect(db.challenges[0].consumedAt).toEqual(later(5)); // still consumed
    // Even a perfectly valid response for the same challenge is now refused...
    await expectGenericFailure(verify(ctx, authenticate(ctx).response, { now: later(6) }));
    expectNothingStored(ctx.admin);
    // ...until fresh options are requested.
    const fresh = await generateAdminPasskeyRegistrationOptions({ ticket: ctx.ticket, now: later(10) });
    await expect(verify(ctx, makeRegistrationResponse({ challenge: fresh.challenge }).response, { now: later(11) })).resolves.toMatchObject({ status: 'active' });
  });

  it('a response is bound to the latest options only', async () => {
    const ctx = await begin();
    const stale = authenticate(ctx);
    const newer = await generateAdminPasskeyRegistrationOptions({ ticket: ctx.ticket, now: later(1) });
    await expectGenericFailure(verify(ctx, stale.response, { now: later(2) }));
    expect(newer.challenge).not.toBe(ctx.options.challenge);
  });
});

describe('WebAuthn verification', () => {
  it.each([
    ['a wrong challenge', { challenge: crypto.randomBytes(32).toString('base64url') }],
    ['a wrong origin', { origin: 'https://evil.example' }],
    ['a similar origin with a different port', { origin: 'http://localhost:3001' }],
    ['a wrong RP ID', { rpId: 'evil.example' }],
    ['a wrong ceremony type', { type: 'webauthn.get' }],
    ['missing user verification', { flags: FLAG.UP | FLAG.AT }],
    ['missing user presence', { flags: FLAG.UV | FLAG.AT }],
    ['an unsupported algorithm (EdDSA)', { key: 'eddsa' }],
    ['an impossible backup state', { flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BS }],
    ['a non-empty "none" attestation statement', { attStmt: new Map([['x', 1]]) }],
    ['an unsupported attestation format', { fmt: 'made-up' }],
  ])('refuses %s, burning the challenge and storing nothing', async (_name, overrides) => {
    const ctx = await begin();
    const auth = makeRegistrationResponse({ challenge: ctx.options.challenge, ...overrides });
    await expectGenericFailure(verify(ctx, auth.response));
    expect(server.verifyRegistrationResponse).toHaveBeenCalledTimes(1);
    expect(db.challenges[0].consumedAt).not.toBeNull();
    expectNothingStored(ctx.admin);
  });

  it('refuses a credential id that differs from the one in the authenticator data', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    const swapped = isoBase64URL.fromBuffer(crypto.randomBytes(32));
    const response = { ...auth.response, id: swapped, rawId: swapped }; // id === rawId, but not the registered id
    await expectGenericFailure(verify(ctx, response));
    expectNothingStored(ctx.admin);
  });

  it('refuses an id / rawId mismatch', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    await expectGenericFailure(verify(ctx, { ...auth.response, rawId: isoBase64URL.fromBuffer(crypto.randomBytes(32)) }));
    expectNothingStored(ctx.admin);
  });

  describe('response shape', () => {
    const good = () => makeRegistrationResponse({ challenge: 'x'.repeat(43) }).response;
    it.each([
      ['undefined', () => undefined],
      ['null', () => null],
      ['a string', () => 'response'],
      ['an array', () => []],
      ['missing id', () => ({ ...good(), id: undefined })],
      ['non-base64url id', () => ({ ...good(), id: 'not base64url!' })],
      ['an over-long id', () => ({ ...good(), id: 'A'.repeat(3000), rawId: 'A'.repeat(3000) })],
      ['wrong type', () => ({ ...good(), type: 'password' })],
      ['no inner response', () => ({ ...good(), response: undefined })],
      ['missing clientDataJSON', () => { const r = good(); delete r.response.clientDataJSON; return r; }],
      ['missing attestationObject', () => { const r = good(); delete r.response.attestationObject; return r; }],
      ['non-string attestationObject', () => { const r = good(); r.response.attestationObject = { x: 1 }; return r; }],
      ['a huge attestationObject', () => { const r = good(); r.response.attestationObject = 'A'.repeat(40000); return r; }],
      ['transports that is not an array', () => { const r = good(); r.response.transports = 'usb'; return r; }],
      ['transports with a non-string', () => { const r = good(); r.response.transports = ['usb', 5]; return r; }],
    ])('refuses %s before touching the challenge', async (_name, build) => {
      const ctx = await begin();
      await expectGenericFailure(verify(ctx, build()));
      expect(db.challenges[0].consumedAt).toBeNull(); // shape problems cost the user nothing
      expect(server.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it('refuses garbage that has the right shape but is not a real attestation', async () => {
      const ctx = await begin();
      const response = { ...good(), response: { clientDataJSON: 'AAAA', attestationObject: 'AAAA' } };
      await expectGenericFailure(verify(ctx, response));
      expectNothingStored(ctx.admin);
    });
  });

  describe('results the library would not normally produce', () => {
    const run = async (verification) => {
      const ctx = await begin();
      const auth = authenticate(ctx);
      server.verifyRegistrationResponse.mockResolvedValueOnce(verification(auth));
      await expectGenericFailure(verify(ctx, auth.response));
      expectNothingStored(ctx.admin);
    };
    const info = (auth, overrides = {}) => ({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '01234567-89ab-cdef-0123-456789abcdef',
        credentialType: 'public-key',
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        credential: { id: auth.response.id, publicKey: new Uint8Array(auth.publicKey), counter: 0, transports: ['internal'] },
        ...overrides,
      },
    });
    const withCredential = (auth, overrides) => info(auth, { credential: { ...info(auth).registrationInfo.credential, ...overrides } });

    it('refuses verified:false', () => run(() => ({ verified: false })));
    it('refuses a missing registrationInfo', () => run(() => ({ verified: true })));
    it('refuses a missing credential', () => run((a) => info(a, { credential: undefined })));
    it('refuses a user that was not verified', () => run((a) => info(a, { userVerified: false })));
    it('refuses a credential type other than public-key', () => run((a) => info(a, { credentialType: 'other' })));
    it('refuses a credential id that is not canonical base64url', () => run((a) => withCredential(a, { id: 'not base64url' })));
    it('refuses a credential id of the wrong length', () => run((a) => withCredential(a, { id: isoBase64URL.fromBuffer(crypto.randomBytes(8)) })));
    it('refuses a credential id different from the response id', () => run((a) => withCredential(a, { id: isoBase64URL.fromBuffer(crypto.randomBytes(32)) })));
    it.each([
      ['missing', undefined],
      ['a string', 'AAAA'],
      ['empty', new Uint8Array(0)],
      ['too short', new Uint8Array(8)],
      ['too long', new Uint8Array(4096)],
      ['random bytes', new Uint8Array(crypto.randomBytes(64))],
    ])('refuses a public key that is %s', (_name, publicKey) => run((a) => withCredential(a, { publicKey })));
    it('refuses a public key using a disallowed algorithm', () => run((a) => withCredential(a, {
      publicKey: new Uint8Array(makeRegistrationResponse({ key: 'eddsa' }).publicKey),
    })));
    it.each([[-1], [4294967296], [1.5], ['7'], [NaN], [undefined], [null]])('refuses a signature counter of %p', (counter) => run((a) => withCredential(a, { counter })));
    it.each([['not-a-uuid'], [''], [undefined], ['0123456789abcdef0123456789abcdef'], ['01234567-89AB-CDEF-0123-456789ABCDEF']])('refuses AAGUID %p', (aaguid) => run((a) => info(a, { aaguid })));
    it('refuses an unknown device type', () => run((a) => info(a, { credentialDeviceType: 'quantumDevice' })));
    it('refuses a non-boolean backup state', () => run((a) => info(a, { credentialBackedUp: 'yes' })));
    it('refuses a single-device credential reported as backed up', () => run((a) => info(a, { credentialDeviceType: 'singleDevice', credentialBackedUp: true })));
    it('refuses malformed transports', () => run((a) => withCredential(a, { transports: 'internal' })));
  });
});

describe('what is persisted', () => {
  it('stores the raw credential id, its hash from the decoded bytes, and the verified public key', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    await verify(ctx, auth.response);
    const row = db.passkeys[0];
    expect(Buffer.isBuffer(row.credentialId)).toBe(true);
    expect(row.credentialId.equals(auth.credentialId)).toBe(true);
    expect(row.credentialIdHash).toBe(crypto.createHash('sha256').update(auth.credentialId).digest('hex'));
    expect(row.credentialIdHash).not.toBe(crypto.createHash('sha256').update(auth.response.id).digest('hex')); // not the text
    expect(row.credentialIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.isBuffer(row.publicKey)).toBe(true);
    expect(row.publicKey.equals(auth.publicKey)).toBe(true);
  });

  it('stores exactly the intended fields and nothing sensitive', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    await verify(ctx, auth.response);
    expect(Object.keys(db.passkeys[0]).sort()).toEqual(
      ['aaguid', 'adminId', 'backedUp', 'credentialId', 'credentialIdHash', 'deviceType', 'id', 'label', 'publicKey', 'revokedAt', 'signCount', 'transports'].sort(),
    );
    const everything = JSON.stringify(db);
    // Neither the ticket nor any part of the browser's response is stored anywhere.
    for (const secret of [ctx.ticket, auth.response.response.attestationObject, auth.response.response.clientDataJSON]) {
      expect(everything).not.toContain(secret);
    }
    expect(JSON.stringify(db.passkeys)).not.toContain(ctx.options.challenge);
    expect(JSON.stringify(db.audits)).not.toContain(ctx.options.challenge);
  });

  it('accepts a zero signature counter', async () => {
    const ctx = await begin();
    await verify(ctx, authenticate(ctx, { counter: 0 }).response);
    expect(db.passkeys[0].signCount).toBe(0);
    expect(ctx.admin.status).toBe('active');
  });

  it('keeps a non-zero counter, including the 32-bit maximum', async () => {
    const ctx = await begin();
    await verify(ctx, authenticate(ctx, { counter: 42 }).response);
    expect(db.passkeys[0].signCount).toBe(42);
    const max = await begin({ adminOverrides: { email: 'max@example.org' } });
    await verify(max, authenticate(max, { counter: 4294967295 }).response);
    expect(db.passkeys[1].signCount).toBe(4294967295);
  });

  it('normalizes transports to the allowlist', async () => {
    const ctx = await begin();
    await verify(ctx, authenticate(ctx, { transports: ['internal', 'hybrid', 'internal', 'telepathy'] }).response);
    expect(db.passkeys[0].transports).toEqual(['internal', 'hybrid']);
    const none = await begin({ adminOverrides: { email: 'n@example.org' } });
    await verify(none, authenticate(none, { transports: null }).response);
    expect(db.passkeys[1].transports).toEqual([]);
  });

  it('normalizes the label and defaults it', async () => {
    const a = await begin();
    await verify(a, authenticate(a).response, { label: '  Asha   MacBook \n Touch ID ' });
    expect(db.passkeys[0].label).toBe('Asha MacBook Touch ID');
    const b = await begin({ adminOverrides: { email: 'b@example.org' } });
    await verify(b, authenticate(b).response);
    expect(db.passkeys[1].label).toBe('Passkey');
    const c = await begin({ adminOverrides: { email: 'c@example.org' } });
    await verify(c, authenticate(c).response, { label: 'x'.repeat(300) });
    expect(db.passkeys[2].label).toHaveLength(100);
  });

  it('refuses a label that is not a string, without consuming the challenge', async () => {
    const ctx = await begin();
    await expectGenericFailure(verify(ctx, authenticate(ctx).response, { label: { evil: true } }));
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  it('stores the verified device type, backup state and AAGUID', async () => {
    const synced = await begin();
    const auth = authenticate(synced, { flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BE | FLAG.BS });
    await verify(synced, auth.response);
    expect(db.passkeys[0]).toMatchObject({ deviceType: 'multiDevice', backedUp: true });
    expect(db.passkeys[0].aaguid).toBe([8, 4, 4, 4, 12].reduce((acc, n) => { acc.parts.push(acc.hex.slice(acc.at, acc.at + n)); acc.at += n; return acc; }, { hex: auth.aaguid.toString('hex'), at: 0, parts: [] }).parts.join('-'));

    const bound = await begin({ adminOverrides: { email: 'bound@example.org' } });
    await verify(bound, authenticate(bound, { flags: FLAG.UP | FLAG.UV | FLAG.AT }).response);
    expect(db.passkeys[1]).toMatchObject({ deviceType: 'singleDevice', backedUp: false });
  });

  it('refuses a duplicate credential with the same generic error, whoever owns it', async () => {
    const owner = await begin();
    const auth = authenticate(owner);
    await verify(owner, auth.response);

    const victim = await begin({ adminOverrides: { email: 'victim@example.org' } });
    const replay = makeRegistrationResponse({ challenge: victim.options.challenge, credentialId: auth.credentialId });
    const error = await expectGenericFailure(verify(victim, replay.response, { now: later(6) }));
    expect(JSON.stringify(error)).not.toContain('asha');
    expect(db.passkeys).toHaveLength(1);
    expect(victim.admin.status).toBe('pending_passkey');
    expect(db.audits.at(-1)).toMatchObject({ event: 'admin_passkey_registration_failed', detail: { reason: 'duplicate_credential' } });
  });

  it('does not overwrite revoked credential history, even when the same credential is presented again', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    const history = {
      id: 7, adminId: ctx.admin.id, credentialIdHash: crypto.createHash('sha256').update(auth.credentialId).digest('hex'),
      credentialId: Buffer.from(auth.credentialId), publicKey: Buffer.from('old-key'), signCount: 9, revokedAt: new Date('2027-01-01T00:00:00Z'), revokedReason: 'lost',
    };
    db.passkeys.push({ ...history });
    await expectGenericFailure(verify(ctx, auth.response)); // same authenticator again: unique hash blocks it
    expect(db.passkeys).toHaveLength(1);
    expect(db.passkeys[0]).toEqual(history);
    expect(ctx.admin.status).toBe('pending_passkey');
  });

  it('adds a new credential alongside revoked history', async () => {
    const ctx = await begin();
    const old = { id: 7, adminId: ctx.admin.id, credentialIdHash: 'b'.repeat(64), credentialId: Buffer.alloc(32, 1), publicKey: Buffer.from('old'), signCount: 3, revokedAt: NOW };
    db.passkeys.push({ ...old });
    await verify(ctx, authenticate(ctx).response);
    expect(db.passkeys).toHaveLength(2);
    expect(db.passkeys[0]).toEqual(old);
    expect(db.passkeys[1].revokedAt).toBeNull();
  });
});

describe('atomic activation', () => {
  it('activates the Admin only after the credential is stored, and writes the audit in the same transaction', async () => {
    const ctx = await begin();
    db.events.length = 0;
    await verify(ctx, authenticate(ctx).response);
    const order = db.events.filter((e) => ['passkeys.create', 'audit.create', 'commit', 'rollback'].includes(e));
    expect(order).toEqual(['passkeys.create', 'audit.create', 'commit']);
    const created = db.events.indexOf('passkeys.create');
    const statusChange = db.events.lastIndexOf('admins.update');
    expect(statusChange).toBeGreaterThan(created);
    expect(db.events.indexOf('audit.create')).toBeGreaterThan(statusChange);
  });

  it('records admin_passkey_registered with safe metadata only', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx, { flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BE });
    await verify(ctx, auth.response, { ipAddress: '203.0.113.7' });
    const audit = db.audits.find((a) => a.event === 'admin_passkey_registered');
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: ctx.admin.id,
      identifier: 'as•••@example.org',
      ipAddress: '203.0.113.7',
      detail: { passkeyId: db.passkeys[0].id, invitationId: ctx.invitation.id, deviceType: 'multiDevice', backedUp: false, credentialCount: 1 },
    });
    const text = JSON.stringify(audit);
    for (const secret of [ctx.ticket, ctx.options.challenge, auth.response.id, auth.publicKey.toString('base64url'), auth.response.response.attestationObject]) {
      expect(text).not.toContain(secret);
    }
  });

  it('rolls everything back when the activation matches no row (the count must be exactly one)', async () => {
    const ctx = await begin();
    const original = fake.prisma.adminUser.updateMany;
    // Let the lock/touch statement through, but make the status flip match nothing.
    const wrap = (client) => {
      const real = client.adminUser.updateMany;
      client.adminUser.updateMany = async (args) => (args.data.status === 'active' ? { count: 0 } : real(args));
    };
    const realTransaction = fake.prisma.$transaction;
    fake.prisma.$transaction = (fn) => realTransaction((tx) => { wrap(tx); return fn(tx); });
    try {
      await expectGenericFailure(verify(ctx, authenticate(ctx).response));
    } finally {
      fake.prisma.$transaction = realTransaction;
      fake.prisma.adminUser.updateMany = original;
    }
    expectNothingStored(ctx.admin);
    expect(db.events).toContain('rollback');
  });

  it('rolls back the credential and the activation when the audit write fails', async () => {
    const ctx = await begin();
    const auth = authenticate(ctx);
    db.failAudit = true;
    await expect(verify(ctx, auth.response)).rejects.toThrow('audit write failed');
    expect(db.passkeys).toHaveLength(0);
    expect(ctx.admin.status).toBe('pending_passkey');
    expect(db.events).toContain('rollback');
    expect(db.challenges[0].consumedAt).not.toBeNull(); // the challenge stays burned
  });

  it('leaves the Admin pending when storing the passkey fails', async () => {
    const ctx = await begin();
    db.failCreate = 'passkeys';
    await expect(verify(ctx, authenticate(ctx).response)).rejects.toThrow('passkeys create failed');
    expect(ctx.admin.status).toBe('pending_passkey');
    expect(db.passkeys).toHaveLength(0);
  });

  it('does not run the verifier inside a database transaction', async () => {
    const ctx = await begin();
    let openTransactions = 0;
    const realTransaction = fake.prisma.$transaction;
    fake.prisma.$transaction = async (fn) => { openTransactions += 1; try { return await realTransaction(fn); } finally { openTransactions -= 1; } };
    let during;
    server.verifyRegistrationResponse.mockImplementationOnce(async (args) => { during = openTransactions; return actualServer.verifyRegistrationResponse(args); });
    try {
      await verify(ctx, authenticate(ctx).response);
    } finally {
      fake.prisma.$transaction = realTransaction;
    }
    expect(during).toBe(0);
  });
});

describe('races', () => {
  // Starts a verification and holds it inside the verifier (challenge already consumed), so the test
  // can change the world before the final transaction.
  async function pauseInVerifier(ctx, response) {
    let reached;
    const atVerifier = new Promise((resolve) => { reached = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    server.verifyRegistrationResponse.mockImplementationOnce(async (args) => {
      reached();
      await gate;
      return actualServer.verifyRegistrationResponse(args);
    });
    const pending = verify(ctx, response);
    await atVerifier;
    return { pending, resume };
  }

  it('two registrations cannot both succeed', async () => {
    const ctx = await begin();
    const first = await pauseInVerifier(ctx, authenticate(ctx).response);
    // While the first is mid-verification a second attempt gets fresh options and completes.
    const newer = await generateAdminPasskeyRegistrationOptions({ ticket: ctx.ticket, now: later(2) });
    await expect(verify(ctx, makeRegistrationResponse({ challenge: newer.challenge }).response, { now: later(3) })).resolves.toMatchObject({ status: 'active' });
    first.resume();
    await expectGenericFailure(first.pending);
    expect(db.passkeys).toHaveLength(1);
    expect(db.audits.filter((a) => a.event === 'admin_passkey_registered')).toHaveLength(1);
  });

  it('simultaneous submissions of one response: exactly one wins', async () => {
    const ctx = await begin();
    const response = authenticate(ctx).response;
    const results = await Promise.allSettled([verify(ctx, response), verify(ctx, response), verify(ctx, response), verify(ctx, response)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason).toBeInstanceOf(PasskeyRegistrationError);
    expect(db.passkeys).toHaveLength(1);
    expect(db.admins[0].status).toBe('active');
  });

  it('an Admin disabled during the ceremony is not activated', async () => {
    const ctx = await begin();
    const held = await pauseInVerifier(ctx, authenticate(ctx).response);
    ctx.admin.status = 'disabled';
    held.resume();
    await expectGenericFailure(held.pending);
    expect(db.passkeys).toHaveLength(0);
    expect(ctx.admin.status).toBe('disabled');
  });

  it('a password change during the ceremony prevents activation', async () => {
    const ctx = await begin();
    const held = await pauseInVerifier(ctx, authenticate(ctx).response);
    ctx.admin.passwordChangedAt = new Date(PCA.getTime() + 60000);
    held.resume();
    await expectGenericFailure(held.pending);
    expectNothingStored(ctx.admin);
  });

  it('an invitation revoked during the ceremony prevents activation', async () => {
    const ctx = await begin();
    const held = await pauseInVerifier(ctx, authenticate(ctx).response);
    ctx.invitation.revokedAt = later(3);
    held.resume();
    await expectGenericFailure(held.pending);
    expectNothingStored(ctx.admin);
  });

  it('a passkey added during the ceremony prevents a second first-passkey activation', async () => {
    const ctx = await begin();
    const held = await pauseInVerifier(ctx, authenticate(ctx).response);
    db.passkeys.push({ id: 50, adminId: ctx.admin.id, credentialIdHash: 'c'.repeat(64), credentialId: Buffer.alloc(32, 2), revokedAt: null });
    held.resume();
    await expectGenericFailure(held.pending);
    expect(db.passkeys).toHaveLength(1);
    expect(ctx.admin.status).toBe('pending_passkey');
  });

  it('holds the Admin and invitation while the final transaction works, so a concurrent disable must wait', async () => {
    const ctx = await begin();
    const response = authenticate(ctx).response;
    // Pause the final transaction right after it re-reads the Admin.
    let reached;
    const atRead = new Promise((resolve) => { reached = resolve; });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    let adminReads = 0;
    db.afterRead = async (table) => {
      if (table !== 'admins') return;
      adminReads += 1;
      if (adminReads !== 2) return; // the 1st read is the read-only pre-check; the 2nd is inside the locked transaction
      db.afterRead = null;
      reached();
      await gate;
    };
    const request = verify(ctx, response);
    await atRead;

    let disabled = false;
    const disable = fake.prisma.$transaction(async (tx) => {
      await tx.adminUser.updateMany({ where: { id: ctx.admin.id }, data: { status: 'disabled' } });
      disabled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disabled).toBe(false);
    expect(ctx.admin.status).toBe('pending_passkey');

    resume();
    await expect(request).resolves.toMatchObject({ status: 'active' });
    await disable;
    expect(ctx.admin.status).toBe('disabled'); // the disable ran after, and wins as the later change
    expect(db.passkeys).toHaveLength(1);
  });
});

describe('no session material', () => {
  it('issues no access token, refresh token, cookie or session on success or failure', async () => {
    const ok = await begin();
    const result = await verify(ok, authenticate(ok).response);
    expect(Object.keys(result).sort()).toEqual(['nextStep', 'status']);
    const bad = await begin({ adminOverrides: { email: 'bad@example.org' } });
    const error = await verify(bad, authenticate(bad, { origin: 'https://evil.example' }).response).catch((e) => e);
    expect(JSON.stringify(result)).not.toMatch(/token|session|cookie|jwt/i);
    expect(error).toMatchObject({ code: 'invalid_enrollment', message: 'This passkey setup session is not valid. Please start again.' });
    expect(JSON.stringify(error)).not.toMatch(/token|cookie|jwt/i);
    expect(db.sessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);
  });

  it('exposes no detail about why a registration failed', async () => {
    const ctx = await begin();
    const error = await verify(ctx, authenticate(ctx, { origin: 'https://evil.example' }).response).catch((e) => e);
    expect(error.message).toBe('This passkey setup session is not valid. Please start again.');
    expect(JSON.stringify(error)).not.toMatch(/origin|challenge|evil|verification/i);
    expect(Object.keys(error).sort()).toEqual(['code', 'name']); // no stack, reason or detail is serialized
    expect(error.reason).toBe('verification_failed'); // internal only (non-enumerable)
  });
});
