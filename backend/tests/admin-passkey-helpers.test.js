// Step 7.7.2: the enrollment ticket, the WebAuthn registration helpers and the related
// configuration. Pure unit tests - no database, no network.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { generateRegistrationOptions } = require('@simplewebauthn/server');
const {
  signAdminEnrollmentTicket,
  readAdminEnrollmentTicket,
  enrollmentTicketMatches,
  ADMIN_ENROLLMENT_TICKET_TTL_SECONDS,
} = require('../src/modules/admin/auth/admin-enrollment-ticket.service');
const {
  signAdminLoginTicket,
  readAdminLoginTicket,
  ADMIN_LOGIN_FLOWS,
  ADMIN_LOGIN_TICKET_TTL_SECONDS,
} = require('../src/modules/admin/auth/admin-login-ticket.service');
const {
  signAdminAccessToken,
  verifyAdminAccessToken,
  deriveAdminKey,
  ADMIN_TOKEN_ISSUER,
} = require('../src/modules/admin/auth/admin-token.service');
const {
  ADMIN_LOCK_POLICY,
  loadAdminLockConfig,
  assertWebAuthnConfig,
  assertPortalUrlConfig,
  assertEnforcementConfig,
} = require('../src/modules/admin/auth/admin-lock.config');
const helpers = require('../src/modules/admin/auth/admin-webauthn.helpers');

const savedSecret = process.env.JWT_ACCESS_SECRET;
const PASSWORD_CHANGED = new Date('2027-03-01T10:00:00.000Z');

beforeEach(() => { process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-passkey-helpers'; });
afterEach(() => {
  jest.restoreAllMocks();
  if (savedSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = savedSecret;
});

const mint = (overrides = {}) => signAdminEnrollmentTicket({ adminId: 5, invitationId: 9, passwordChangedAt: PASSWORD_CHANGED, ...overrides });

describe('enrollment ticket', () => {
  it('lasts exactly 600 seconds and reads back with its bindings', () => {
    const ticket = mint();
    const { exp, iat } = jwt.decode(ticket);
    expect(ADMIN_ENROLLMENT_TICKET_TTL_SECONDS).toBe(600);
    expect(ADMIN_LOCK_POLICY.enrollmentTicketTtlMs).toBe(600000);
    expect(exp - iat).toBe(600);
    const claims = readAdminEnrollmentTicket(ticket);
    expect(claims).toMatchObject({ adminId: 5, invitationId: 9, passwordChangedAt: PASSWORD_CHANGED });
    expect(claims.ticketId).toEqual(expect.any(String));
    expect(claims.expiresAt).toEqual(new Date(exp * 1000));
  });

  it('gives each ticket a unique id', () => {
    expect(readAdminEnrollmentTicket(mint()).ticketId).not.toBe(readAdminEnrollmentTicket(mint()).ticketId);
  });

  it('is accepted until 600 seconds and rejected after', () => {
    const ticket = mint();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 599 * 1000);
    expect(readAdminEnrollmentTicket(ticket)).not.toBeNull();
    Date.now.mockReturnValue(now + 601 * 1000);
    expect(readAdminEnrollmentTicket(ticket)).toBeNull();
  });

  it('carries no role, session or token claims', () => {
    const claims = jwt.decode(mint());
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'flow', 'iat', 'inv', 'iss', 'jti', 'pca', 'sub']);
    expect(claims.flow).toBe('passkey_enrollment');
    expect(JSON.stringify(claims)).not.toMatch(/role|sid|session/);
  });

  it('refuses to sign without all three bindings', () => {
    expect(() => mint({ adminId: 0 })).toThrow('adminId');
    expect(() => mint({ invitationId: undefined })).toThrow('invitationId');
    expect(() => mint({ invitationId: 1.5 })).toThrow('invitationId');
    expect(() => mint({ passwordChangedAt: undefined })).toThrow('passwordChangedAt');
    expect(() => mint({ passwordChangedAt: null })).toThrow('passwordChangedAt');
    expect(() => mint({ passwordChangedAt: new Date('nope') })).toThrow('passwordChangedAt');
    expect(() => mint({ passwordChangedAt: PASSWORD_CHANGED.getTime() })).toThrow('passwordChangedAt');
  });

  describe('binding', () => {
    const admin = { id: 5, passwordChangedAt: PASSWORD_CHANGED };
    const claims = () => readAdminEnrollmentTicket(mint());

    it('matches the same admin, invitation and password state', () => {
      expect(enrollmentTicketMatches(claims(), { admin, invitationId: 9 })).toBe(true);
      expect(enrollmentTicketMatches(claims(), { admin: { id: 5, passwordChangedAt: new Date(PASSWORD_CHANGED) }, invitationId: 9 })).toBe(true);
    });

    it.each([
      ['another admin', { admin: { id: 6, passwordChangedAt: PASSWORD_CHANGED }, invitationId: 9 }],
      ['another invitation', { admin: { id: 5, passwordChangedAt: PASSWORD_CHANGED }, invitationId: 10 }],
      ['a changed password', { admin: { id: 5, passwordChangedAt: new Date(PASSWORD_CHANGED.getTime() + 1) }, invitationId: 9 }],
      ['no password timestamp', { admin: { id: 5, passwordChangedAt: null }, invitationId: 9 }],
      ['a string timestamp', { admin: { id: 5, passwordChangedAt: PASSWORD_CHANGED.toISOString() }, invitationId: 9 }],
      ['no invitation id', { admin: { id: 5, passwordChangedAt: PASSWORD_CHANGED } }],
      ['no admin', { invitationId: 9 }],
      ['nothing', undefined],
    ])('does not match %s', (_name, expected) => {
      expect(enrollmentTicketMatches(claims(), expected)).toBe(false);
    });

    it('does not match null claims', () => {
      expect(enrollmentTicketMatches(null, { admin, invitationId: 9 })).toBe(false);
    });
  });

  describe('rejection', () => {
    const key = () => deriveAdminKey('humancare/admin-lock/enrollment-ticket/v1');
    const forge = (claims, options = {}) => {
      const merged = {
        algorithm: 'HS256', issuer: ADMIN_TOKEN_ISSUER, audience: 'humancare-admin-enrollment-ticket',
        subject: '5', jwtid: 'x', expiresIn: 600, ...options,
      };
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]; // undefined = leave the claim out
      return jwt.sign(claims, key(), merged);
    };
    const good = { flow: 'passkey_enrollment', inv: 9, pca: PASSWORD_CHANGED.getTime() };

    it('accepts a hand-built ticket with the right shape (control)', () => {
      expect(readAdminEnrollmentTicket(forge(good))).not.toBeNull();
    });

    it.each([
      ['a wrong flow', { ...good, flow: 'passkey_login' }],
      ['no flow', { inv: 9, pca: 1 }],
      ['no invitation binding', { flow: 'passkey_enrollment', pca: 1 }],
      ['no password marker', { flow: 'passkey_enrollment', inv: 9 }],
      ['a string invitation id', { ...good, inv: '9' }],
      ['a zero password marker', { ...good, pca: 0 }],
    ])('rejects %s', (_name, claims) => {
      expect(readAdminEnrollmentTicket(forge(claims))).toBeNull();
    });

    it('rejects other header-level problems', () => {
      expect(readAdminEnrollmentTicket(forge(good, { subject: undefined }))).toBeNull();
      expect(readAdminEnrollmentTicket(forge(good, { subject: 'abc' }))).toBeNull();
      expect(readAdminEnrollmentTicket(forge(good, { jwtid: undefined }))).toBeNull();
      expect(readAdminEnrollmentTicket(forge(good, { audience: 'other' }))).toBeNull();
      expect(readAdminEnrollmentTicket(forge(good, { issuer: 'other' }))).toBeNull();
      expect(readAdminEnrollmentTicket(forge(good, { expiresIn: 900 }))).toBeNull(); // wrong lifetime
      expect(readAdminEnrollmentTicket(forge(good, { algorithm: 'HS512' }))).toBeNull();
    });

    it('rejects garbage, tampering and a missing ticket', () => {
      const ticket = mint();
      expect(readAdminEnrollmentTicket(`${ticket.slice(0, -2)}xx`)).toBeNull();
      for (const bad of ['', undefined, null, 5, {}, 'a.b.c']) expect(readAdminEnrollmentTicket(bad)).toBeNull();
    });

    it('fails loudly, not as an invalid ticket, when the secret is missing', () => {
      const ticket = mint();
      delete process.env.JWT_ACCESS_SECRET;
      expect(() => readAdminEnrollmentTicket(ticket)).toThrow('JWT_ACCESS_SECRET is not set');
    });
  });

  describe('separation from other tokens', () => {
    it('is not a login ticket, an access token, or a shared-key token (and the reverse)', () => {
      const enrollment = mint();
      expect(readAdminLoginTicket(enrollment, ADMIN_LOGIN_FLOWS.PASSKEY_LOGIN)).toBeNull();
      expect(readAdminLoginTicket(enrollment, ADMIN_LOGIN_FLOWS.PASSKEY_UNLOCK)).toBeNull();
      expect(verifyAdminAccessToken(enrollment)).toBeNull();
      expect(() => jwt.verify(enrollment, process.env.JWT_ACCESS_SECRET)).toThrow();

      expect(readAdminEnrollmentTicket(signAdminLoginTicket({ adminId: 5, flow: 'passkey_login' }))).toBeNull();
      expect(readAdminEnrollmentTicket(signAdminAccessToken({ adminId: 5, role: 'admin', sessionId: 1 }))).toBeNull();
    });

    it('cannot be minted through the login-ticket signer', () => {
      expect(() => signAdminLoginTicket({ adminId: 5, flow: 'passkey_enrollment' })).toThrow();
      expect(readAdminLoginTicket(mint(), 'passkey_login')).toBeNull();
      expect(() => readAdminLoginTicket(mint(), 'passkey_enrollment')).toThrow();
    });
  });
});

describe('existing login tickets are unchanged', () => {
  it('still last exactly 120 seconds with only the two original flows', () => {
    expect(ADMIN_LOGIN_TICKET_TTL_SECONDS).toBe(120);
    expect(ADMIN_LOGIN_FLOWS).toEqual({ PASSKEY_LOGIN: 'passkey_login', PASSKEY_UNLOCK: 'passkey_unlock' });
    for (const flow of Object.values(ADMIN_LOGIN_FLOWS)) {
      const ticket = signAdminLoginTicket({ adminId: 5, flow });
      const { exp, iat } = jwt.decode(ticket);
      expect(exp - iat).toBe(120);
      expect(readAdminLoginTicket(ticket, flow)).toMatchObject({ adminId: 5, flow });
    }
  });

  it('keeps the other approved policy values', () => {
    expect(ADMIN_LOCK_POLICY).toMatchObject({
      loginChallengeTtlMs: 120000,
      unlockChallengeTtlMs: 120000,
      accessTokenTtlMs: 900000,
      invitationTtlMs: 72 * 3600 * 1000,
      recoveryInvitationTtlMs: 24 * 3600 * 1000,
      recoveryRequestTtlMs: 7 * 24 * 3600 * 1000,
      failedLoginThreshold: 5,
      accountLockoutMs: 900000,
      refreshTokenReuseGraceMs: 10000,
      registrationChallengeTtlMs: 120000,
    });
  });
});

describe('WebAuthn registration settings', () => {
  it('allows only ES256 and RS256', () => {
    expect(helpers.ADMIN_WEBAUTHN_ALGORITHMS).toEqual([-7, -257]);
    expect(Object.isFrozen(helpers.ADMIN_WEBAUTHN_ALGORITHMS)).toBe(true);
  });

  it('hands out a fresh, mutable authenticatorSelection each time (the library edits what it is given)', () => {
    const a = helpers.registrationAuthenticatorSelection();
    const b = helpers.registrationAuthenticatorSelection();
    expect(a).toEqual({ residentKey: 'preferred', userVerification: 'required' });
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
    a.requireResidentKey = true;
    expect(helpers.registrationAuthenticatorSelection()).toEqual({ residentKey: 'preferred', userVerification: 'required' });
  });

  it('requires user verification and presence, prefers resident keys, and sends no attestation', () => {
    const s = helpers.ADMIN_REGISTRATION_SETTINGS;
    expect(s).toMatchObject({
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
      timeoutMs: 120000,
      expectedType: 'webauthn.create',
    });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.authenticatorSelection)).toBe(true);
  });

  it('are accepted by the installed library (a handle and these settings produce valid options)', async () => {
    const options = await generateRegistrationOptions({
      rpName: 'HumanCare World Wide Admin',
      rpID: 'localhost',
      userName: 'asha@example.org',
      userID: helpers.deriveAdminWebAuthnUserHandle(5),
      attestationType: helpers.ADMIN_REGISTRATION_SETTINGS.attestationType,
      authenticatorSelection: helpers.registrationAuthenticatorSelection(),
      supportedAlgorithmIDs: helpers.ADMIN_WEBAUTHN_ALGORITHMS,
      timeout: helpers.ADMIN_REGISTRATION_SETTINGS.timeoutMs,
    });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' });
    expect(options.attestation).toBe('none');
    expect(options.timeout).toBe(120000);
    expect(isoBase64URL.toBuffer(options.user.id)).toHaveLength(32);
  });
});

describe('WebAuthn user handle', () => {
  it('is a 32-byte Uint8Array (not a Buffer or string)', () => {
    const handle = helpers.deriveAdminWebAuthnUserHandle(5);
    expect(handle).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(handle)).toBe(false);
    expect(handle).toHaveLength(32);
    expect(helpers.USER_HANDLE_BYTES).toBe(32);
  });

  it('is stable for one admin and different across admins', () => {
    const a1 = helpers.deriveAdminWebAuthnUserHandle(5);
    const a2 = helpers.deriveAdminWebAuthnUserHandle(5);
    const b = helpers.deriveAdminWebAuthnUserHandle(6);
    expect(Buffer.from(a1).equals(Buffer.from(a2))).toBe(true);
    expect(Buffer.from(a1).equals(Buffer.from(b))).toBe(false);
  });

  it('changes with the secret and does not contain the admin id', () => {
    const before = Buffer.from(helpers.deriveAdminWebAuthnUserHandle(5));
    process.env.JWT_ACCESS_SECRET = 'a-different-secret';
    expect(before.equals(Buffer.from(helpers.deriveAdminWebAuthnUserHandle(5)))).toBe(false);
    expect(before.toString('utf8')).not.toContain('5');
    expect(before.toString('hex')).not.toBe(Buffer.from('admin:5').toString('hex'));
  });

  it('is domain-separated from every other derived key', () => {
    expect(helpers.ADMIN_WEBAUTHN_USER_HANDLE_KEY_LABEL).toBe('humancare/admin-lock/webauthn-user-handle/v1');
    const labels = [
      'humancare/admin-lock/access-token/v1',
      'humancare/admin-lock/login-ticket/v1',
      'humancare/admin-lock/enrollment-ticket/v1',
      helpers.ADMIN_WEBAUTHN_USER_HANDLE_KEY_LABEL,
    ];
    expect(new Set(labels.map((l) => deriveAdminKey(l).toString('hex'))).size).toBe(labels.length);
    // not simply the key itself or a plain HMAC of the id under the raw secret
    const raw = crypto.createHmac('sha256', process.env.JWT_ACCESS_SECRET).update('admin:5').digest();
    expect(Buffer.from(helpers.deriveAdminWebAuthnUserHandle(5)).equals(raw)).toBe(false);
  });

  it.each([[0], [-1], [1.5], ['5'], [null], [undefined]])('rejects admin id %p', (id) => {
    expect(() => helpers.deriveAdminWebAuthnUserHandle(id)).toThrow('adminId');
  });

  it('fails loudly when the secret is missing', () => {
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => helpers.deriveAdminWebAuthnUserHandle(5)).toThrow('JWT_ACCESS_SECRET is not set');
  });
});

describe('credential IDs', () => {
  const bytes = crypto.randomBytes(32);
  const id = isoBase64URL.fromBuffer(bytes);

  it('decodes to the raw bytes', () => {
    const decoded = helpers.decodeCredentialId(id);
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.equals(bytes)).toBe(true);
  });

  it('accepts the minimum and maximum lengths', () => {
    expect(helpers.decodeCredentialId(isoBase64URL.fromBuffer(crypto.randomBytes(16)))).toHaveLength(16);
    expect(helpers.decodeCredentialId(isoBase64URL.fromBuffer(crypto.randomBytes(1023)))).toHaveLength(1023);
  });

  it.each([
    ['empty', ''],
    ['not a string', 123],
    ['null', null],
    ['undefined', undefined],
    ['standard base64 characters', 'ab+/cdefghijklmnopqrstuv=='],
    ['spaces', 'abcd efghijklmnopqrstuv'],
    ['punctuation', 'abcdefghijklmnopqrstuv!'],
    ['too short (15 bytes)', isoBase64URL.fromBuffer(crypto.randomBytes(15))],
    ['too long (1024 bytes)', isoBase64URL.fromBuffer(crypto.randomBytes(1024))],
    ['absurdly long', 'A'.repeat(5000)],
  ])('rejects a %s credential ID', (_name, value) => {
    expect(() => helpers.decodeCredentialId(value)).toThrow(TypeError);
    expect(() => helpers.hashCredentialId(value)).toThrow(TypeError);
  });

  it('rejects a non-canonical encoding of the same bytes', () => {
    // 16 bytes encode to 22 chars whose last char carries only 4 data bits; changing the unused
    // low bits yields different text that many decoders map to the same bytes.
    const sixteen = Buffer.alloc(16, 7);
    const canonical = isoBase64URL.fromBuffer(sixteen);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = canonical[canonical.length - 1];
    const variant = alphabet.split('').find((c) => c !== last && (alphabet.indexOf(c) >> 2) === (alphabet.indexOf(last) >> 2));
    const sloppy = canonical.slice(0, -1) + variant;
    expect(sloppy).not.toBe(canonical);
    expect(() => helpers.decodeCredentialId(canonical)).not.toThrow();
    expect(() => helpers.decodeCredentialId(sloppy)).toThrow('canonical');
  });

  describe('hash', () => {
    it('is the lowercase hex SHA-256 of the decoded bytes, not of the text', () => {
      const hash = helpers.hashCredentialId(id);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(hash).not.toBe(crypto.createHash('sha256').update(id).digest('hex'));
    });

    it('is the same for the string form and the byte form, and deterministic', () => {
      expect(helpers.hashCredentialId(bytes)).toBe(helpers.hashCredentialId(id));
      expect(helpers.hashCredentialId(new Uint8Array(bytes))).toBe(helpers.hashCredentialId(id));
      expect(helpers.hashCredentialId(id)).toBe(helpers.hashCredentialId(id));
    });

    it('differs for different credentials', () => {
      expect(helpers.hashCredentialId(id)).not.toBe(helpers.hashCredentialId(isoBase64URL.fromBuffer(crypto.randomBytes(32))));
    });

    it('is case-sensitive about the id (case variants are different credentials)', () => {
      const swapped = id.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      if (swapped !== id) expect(helpers.hashCredentialId(swapped)).not.toBe(helpers.hashCredentialId(id));
    });

    it('rejects byte input of the wrong type or length', () => {
      for (const bad of [Buffer.alloc(15), Buffer.alloc(1024), [1, 2, 3], {}, null, undefined, 5]) {
        expect(() => helpers.hashCredentialId(bad)).toThrow(TypeError);
      }
    });
  });
});

describe('transports', () => {
  it('keeps known transports in order, dropping unknown ones and duplicates', () => {
    expect(helpers.normalizeTransports(['internal', 'hybrid', 'internal', 'telepathy', 'usb'])).toEqual(['internal', 'hybrid', 'usb']);
    expect(helpers.normalizeTransports(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'])).toEqual(helpers.ALLOWED_TRANSPORTS);
  });

  it('treats missing as empty', () => {
    expect(helpers.normalizeTransports(undefined)).toEqual([]);
    expect(helpers.normalizeTransports(null)).toEqual([]);
    expect(helpers.normalizeTransports([])).toEqual([]);
  });

  it('is case-sensitive and does not trim', () => {
    expect(helpers.normalizeTransports(['USB', ' usb', 'usb '])).toEqual([]);
  });

  it('rejects the wrong shape', () => {
    expect(() => helpers.normalizeTransports('usb')).toThrow(TypeError);
    expect(() => helpers.normalizeTransports({ 0: 'usb' })).toThrow(TypeError);
    expect(() => helpers.normalizeTransports(['usb', 5])).toThrow(TypeError);
    expect(() => helpers.normalizeTransports(Array(33).fill('usb'))).toThrow(TypeError);
  });

  it('does not modify its input', () => {
    const input = ['usb', 'x'];
    helpers.normalizeTransports(input);
    expect(input).toEqual(['usb', 'x']);
  });
});

describe('passkey labels', () => {
  it('defaults when missing or blank', () => {
    for (const v of [undefined, null, '', '   ', '\n\t', '\u0007​']) expect(helpers.normalizePasskeyLabel(v)).toBe('Passkey');
  });

  it('trims and collapses whitespace', () => {
    expect(helpers.normalizePasskeyLabel('  Asha   MacBook \n Touch ID  ')).toBe('Asha MacBook Touch ID');
  });

  it('removes control and invisible-format characters', () => {
    expect(helpers.normalizePasskeyLabel('Key\u0000One‮')).toBe('Key One');
  });

  it('cuts to 100 characters, counting characters not UTF-16 units', () => {
    expect(helpers.MAX_LABEL_LENGTH).toBe(100);
    expect(helpers.normalizePasskeyLabel('a'.repeat(100))).toHaveLength(100);
    expect(helpers.normalizePasskeyLabel('a'.repeat(250))).toHaveLength(100);
    const emoji = helpers.normalizePasskeyLabel('🔑'.repeat(150));
    expect([...emoji]).toHaveLength(100);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no split surrogate
  });

  it('leaves normal text, including non-Latin, alone', () => {
    expect(helpers.normalizePasskeyLabel('मेरा लैपटॉप')).toBe('मेरा लैपटॉप');
  });

  it('rejects non-string labels', () => {
    for (const bad of [5, {}, [], true]) expect(() => helpers.normalizePasskeyLabel(bad)).toThrow(TypeError);
  });
});

describe('WebAuthn configuration (unchanged behavior)', () => {
  const load = (env) => loadAdminLockConfig(env);
  const local = { ADMIN_WEBAUTHN_RP_ID: 'localhost', ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3000', ADMIN_WEBAUTHN_RP_NAME: 'HumanCare World Wide Admin' };

  it('accepts the local development values outside production', () => {
    expect(assertWebAuthnConfig(load(local), { env: {} })).toEqual({
      rpId: 'localhost', origin: 'http://localhost:3000', rpName: 'HumanCare World Wide Admin',
    });
  });

  it('rejects the same localhost values in production', () => {
    expect(() => assertWebAuthnConfig(load(local), { env: { NODE_ENV: 'production' } })).toThrow('production');
  });

  it('requires the WebAuthn settings for a ceremony even with enforcement off, and has no defaults', () => {
    expect(load({}).passkeyEnforcement).toBe(false);
    expect(() => assertWebAuthnConfig(load({}), { env: {} })).toThrow(/ADMIN_WEBAUTHN_RP_ID is required/);
    expect(() => assertWebAuthnConfig(load({}), { env: {} })).toThrow(/ADMIN_WEBAUTHN_ORIGIN is required/);
    expect(() => assertWebAuthnConfig(load({}), { env: {} })).toThrow(/ADMIN_WEBAUTHN_RP_NAME is required/);
  });

  it('keeps enforcement and portal-URL validation separate', () => {
    expect(() => assertEnforcementConfig(load({}), { env: {} })).not.toThrow(); // enforcement off
    expect(() => assertEnforcementConfig(load({ ADMIN_PASSKEY_ENFORCEMENT: 'true' }), { env: {} })).toThrow('ADMIN_WEBAUTHN_RP_ID');
    expect(() => assertPortalUrlConfig(load(local), { env: {} })).toThrow('ADMIN_PORTAL_URL is required'); // the WebAuthn trio doesn't satisfy it
    expect(assertPortalUrlConfig(load({ ADMIN_PORTAL_URL: 'http://localhost:3000' }), { env: {} })).toBe('http://localhost:3000');
  });
});
