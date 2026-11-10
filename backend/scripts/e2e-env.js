// The isolated environment for real-browser tests (the E2E backend, and the fixtures that run next
// to it). Built from backend/.env.test ONLY:
//   - keys that exist in the development .env but not in .env.test are blanked, because the Prisma
//     client would otherwise fill them in from .env (real SMTP credentials, Bitrix, Firebase ...);
//   - NODE_ENV is "test", which also switches on the guard in src/db/prisma.js;
//   - the database URL, mail settings and uploads folder are validated by the safety guard BEFORE
//     anything uses them, so a wrong .env.test stops here.
// The development .env is read only for its key NAMES, in memory; no value is printed or used.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { assertTestDatabaseUrl, assertSafeTestEnvironment, BACKEND_ROOT } = require('../src/common/safety/test-database-guard');

const SYSTEM_KEYS = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR'];

/** The complete, validated environment for a test process. Does not touch process.env. */
function buildIsolatedEnv() {
  const testFile = path.join(BACKEND_ROOT, '.env.test');
  if (!fs.existsSync(testFile)) throw new Error('backend/.env.test does not exist (see .env.test.example).');
  const testValues = dotenv.parse(fs.readFileSync(testFile));

  const devFile = path.join(BACKEND_ROOT, '.env');
  const devKeys = fs.existsSync(devFile) ? Object.keys(dotenv.parse(fs.readFileSync(devFile))) : [];

  const env = {};
  for (const key of devKeys) if (!(key in testValues)) env[key] = '';
  Object.assign(env, testValues, { NODE_ENV: 'test' });

  // The portal under test runs on its own port (default 3100), never on 3000, where the development
  // portal normally runs. The Admin Lock links and the WebAuthn origin must name that portal, so they
  // are derived here rather than trusted from the file; the RP ID stays "localhost".
  const portalPort = Number(process.env.E2E_PORTAL_PORT || 3100);
  if (!Number.isInteger(portalPort) || portalPort <= 0 || portalPort === 4100 || portalPort === 4000) {
    throw new Error('E2E_PORTAL_PORT is not usable.');
  }
  env.ADMIN_PORTAL_URL = `http://localhost:${portalPort}`;
  env.ADMIN_WEBAUTHN_ORIGIN = env.ADMIN_PORTAL_URL;
  env.ADMIN_WEBAUTHN_RP_ID = 'localhost';

  assertTestDatabaseUrl(env.DATABASE_URL);
  assertSafeTestEnvironment(env);
  return env;
}

/** Environment for a child process: the minimum system variables plus the isolated environment. */
function childEnv() {
  const system = {};
  for (const key of SYSTEM_KEYS) if (process.env[key] !== undefined) system[key] = process.env[key];
  return { ...system, ...buildIsolatedEnv() };
}

/** Applies the isolated environment to THIS process. Call before requiring anything that uses Prisma. */
function applyIsolatedEnv() {
  const env = buildIsolatedEnv();
  Object.assign(process.env, env);
  return env;
}

module.exports = { buildIsolatedEnv, childEnv, applyIsolatedEnv };
