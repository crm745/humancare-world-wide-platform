// Shared setup for the Admin sign-in and session tests. Not a test file. Importing tests must
// call jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db')) themselves.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fake = require('./admin-lock-fake-db');
const { makeRegistrationResponse, makeAssertionResponse } = require('./admin-webauthn-test-authenticator');
const { hashCredentialId } = require('../src/modules/admin/auth/admin-webauthn.helpers');
const { beginAdminPasskeyLogin, completeAdminPasskeyLogin } = require('../src/modules/admin/auth/admin-login.service');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const PCA = new Date('2027-02-28T09:00:00.000Z');
const PASSWORD = 'CurrentPass2027x';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);

const ENV_KEYS = ['JWT_ACCESS_SECRET', 'ADMIN_WEBAUTHN_RP_ID', 'ADMIN_WEBAUTHN_ORIGIN', 'ADMIN_WEBAUTHN_RP_NAME', 'ADMIN_PASSKEY_ENFORCEMENT', 'NODE_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv() {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-admin-login';
  process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
  process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
  process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
  delete process.env.ADMIN_PASSKEY_ENFORCEMENT;
  delete process.env.NODE_ENV;
}

function restoreEnv() {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
}

function seedAdmin(overrides = {}) {
  const admin = {
    id: db.admins.length + 1,
    name: 'Asha Rao',
    email: `admin${db.admins.length + 1}@example.org`,
    role: 'admin',
    status: 'active',
    passwordHash: PASSWORD_HASH,
    passwordChangedAt: PCA,
    emailVerifiedAt: PCA,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    updatedAt: null,
    ...overrides,
  };
  db.admins.push(admin);
  return admin;
}

// A registered passkey for `admin`: the row as stored, plus the software authenticator that made it.
function seedPasskey(admin, { signCount = 0, revokedAt = null, key = 'es256', transports = ['internal'] } = {}) {
  const reg = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url'), key, transports });
  const row = {
    id: db.passkeys.length + 1,
    adminId: admin.id,
    credentialIdHash: hashCredentialId(reg.credentialId),
    credentialId: Buffer.from(reg.credentialId),
    publicKey: Buffer.from(reg.publicKey),
    signCount,
    transports,
    aaguid: '00000000-0000-0000-0000-000000000000',
    deviceType: 'singleDevice',
    backedUp: false,
    label: 'Passkey',
    lastUsedAt: null,
    revokedAt,
  };
  db.passkeys.push(row);
  return { row, reg };
}

const begin = (admin, overrides = {}) => beginAdminPasskeyLogin({ email: admin.email, password: PASSWORD, now: NOW, ...overrides });

// Both steps, producing a session. `counter` is what the authenticator reports.
async function login(admin, passkey, { now = NOW, counter = 0, ipAddress = '203.0.113.5', userAgent = 'jest', assertion = {} } = {}) {
  const { loginTicket, options } = await begin(admin, { now, ipAddress });
  const response = makeAssertionResponse({ challenge: options.challenge, registered: passkey.reg, counter, ...assertion });
  return completeAdminPasskeyLogin({ loginTicket, response, now, ipAddress, userAgent });
}

module.exports = {
  db, fake, NOW, PCA, PASSWORD, PASSWORD_HASH, later, setEnv, restoreEnv, seedAdmin, seedPasskey, begin, login,
  makeAssertionResponse, completeAdminPasskeyLogin, beginAdminPasskeyLogin,
};
