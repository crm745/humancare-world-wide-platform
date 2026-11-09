// Support for the real-browser suite: the isolated backend bridge, database safety checks, targeted
// fixtures and cleanup, mail capture, the Chromium virtual authenticator, and the UI flows.
//
// SAFETY, in order of execution:
//  1. The environment is built from backend/.env.test only and validated by the safety guard BEFORE
//     any backend module that could touch Prisma is loaded.
//  2. Every fixture creation, every database read used as evidence, and the cleanup first ask the
//     database server to confirm it is humancare_test as a test user (assertIsolatedDb). Each
//     confirmation is recorded and reported.
//  3. Accounts are only ever @e2e.humancare.invalid addresses carrying this run's id; cleanup deletes
//     only rows that belong to those accounts and refuses anything else.
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { expect } = require('@playwright/test');

const BACKEND = path.resolve(__dirname, '../../../../backend');
const { applyIsolatedEnv, childEnv } = require(path.join(BACKEND, 'scripts/e2e-env'));
const testEnv = applyIsolatedEnv(); // validated; must precede the requires below

const guard = require(path.join(BACKEND, 'src/common/safety/test-database-guard'));
const { prisma } = require(path.join(BACKEND, 'src/db/prisma'));
const { provisionAdmin, superadminConfirmationPhrase } = require(path.join(BACKEND, 'src/modules/admin/auth/admin-provisioning.service'));
const { hashToken } = require(path.join(BACKEND, 'src/common/utils/token-hash'));
const { maskEmail } = require(path.join(BACKEND, 'src/common/utils/phone'));

const PORTAL = testEnv.ADMIN_WEBAUTHN_ORIGIN; // http://localhost:3100 - derived, see backend/scripts/e2e-env.js
const API = `http://localhost:${testEnv.PORT}`;
const MAIL_API = 'http://127.0.0.1:1080/messages';
const RUN = crypto.randomBytes(4).toString('hex');
const STARTED_AT = new Date();
const PASSWORD = `E2e-${RUN}-Pass1x`; // a unique, strong, test-only password
const emailFor = (tag) => `${tag}-${RUN}@e2e.humancare.invalid`;
const RUN_EMAIL = new RegExp(`^[a-z0-9]+-${RUN}@e2e\\.humancare\\.invalid$`);

// ---- database isolation ------------------------------------------------------------------------

const isolationChecks = [];
async function assertIsolatedDb(label) {
  guard.assertTestDatabaseUrl(process.env.DATABASE_URL);
  const live = await guard.verifyLiveDatabase(prisma);
  isolationChecks.push({ label, database: live.database, account: live.account });
  return live;
}

const created = []; // { id, email, role, tag }

async function provision({ tag, name, role }) {
  await assertIsolatedDb(`create fixture ${tag}`);
  const email = emailFor(tag);
  if (!RUN_EMAIL.test(email)) throw new Error('fixture email is not a run-scoped @e2e.humancare.invalid address');
  const result = await provisionAdmin({
    name,
    email,
    role,
    superadminConfirmation: role === 'superadmin' ? superadminConfirmationPhrase(email) : undefined,
  });
  expect(result.emailDelivered, 'invitation email must reach the capture sink').toBe(true);
  created.push({ id: result.admin.id, email, role, tag });
  return { id: result.admin.id, email, name, role };
}

/** Runs an operator CLI exactly as a person would, against the isolated test database only. */
async function runCli(script, args) {
  await assertIsolatedDb(`cli ${script} ${args[0]}`);
  const emailAt = args.indexOf('--email');
  if (emailAt >= 0 && !RUN_EMAIL.test(args[emailAt + 1])) throw new Error('refusing to run the CLI for a non-run account');
  if (emailAt < 0 && !['cancel'].includes(args[0])) throw new Error('refusing to run a CLI command without a run-scoped --email');
  const result = spawnSync(process.execPath, [path.join(BACKEND, 'scripts', script), ...args], {
    cwd: BACKEND,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function cleanupRun() {
  await assertIsolatedDb('cleanup');
  const admins = await prisma.adminUser.findMany({ where: { id: { in: created.map((c) => c.id) } } });
  admins.forEach((a) => {
    if (!RUN_EMAIL.test(a.email)) throw new Error('cleanup refused: a row is not a run-scoped test account');
  });
  const ids = admins.map((a) => a.id);
  const emails = admins.map((a) => a.email);
  if (ids.length === 0) return { adminsRemoved: 0 };

  const requests = await prisma.adminRecoveryRequest.findMany({
    where: { OR: [{ adminId: { in: ids } }, { requestedByAdminId: { in: ids } }] },
    select: { id: true },
  });
  const requestIds = requests.map((r) => r.id);
  const sessions = await prisma.adminSession.findMany({ where: { adminId: { in: ids } }, select: { id: true } });
  const sessionIds = sessions.map((s) => s.id);

  const counts = await prisma.$transaction(async (tx) => {
    const out = {};
    out.approvals = (await tx.adminRecoveryApproval.deleteMany({ where: { OR: [{ requestId: { in: requestIds } }, { approverId: { in: ids } }] } })).count;
    out.challenges = (await tx.adminWebAuthnChallenge.deleteMany({ where: { adminId: { in: ids } } })).count;
    out.refreshTokens = (await tx.adminRefreshToken.deleteMany({ where: { sessionId: { in: sessionIds } } })).count;
    out.sessions = (await tx.adminSession.deleteMany({ where: { adminId: { in: ids } } })).count;
    out.passkeys = (await tx.adminPasskey.deleteMany({ where: { adminId: { in: ids } } })).count;
    out.invitations = (await tx.adminInvitation.deleteMany({ where: { adminId: { in: ids } } })).count;
    out.requests = (await tx.adminRecoveryRequest.deleteMany({ where: { id: { in: requestIds } } })).count;
    out.audit = (await tx.securityEvent.deleteMany({
      where: {
        createdAt: { gte: STARTED_AT },
        OR: [{ actorId: { in: ids } }, { identifier: { in: [...emails, ...emails.map((e) => maskEmail(e))] } }],
      },
    })).count;
    out.admins = (await tx.adminUser.deleteMany({ where: { id: { in: ids }, email: { in: emails } } })).count;
    return out;
  });
  await assertIsolatedDb('cleanup done');
  return counts;
}

// ---- database evidence (read-only) ---------------------------------------------------------------

const db = {
  admin: async (email) => { await assertIsolatedDb(`read admin ${email.split('-')[0]}`); return prisma.adminUser.findUnique({ where: { email } }); },
  sessions: async (adminId) => prisma.adminSession.findMany({ where: { adminId }, orderBy: { id: 'asc' } }),
  refreshTokens: async (sessionIds) => prisma.adminRefreshToken.findMany({ where: { sessionId: { in: sessionIds } } }),
  passkeys: async (adminId) => prisma.adminPasskey.findMany({ where: { adminId }, orderBy: { id: 'asc' } }),
  latestRequest: async (adminId) => { await assertIsolatedDb('read recovery request'); return prisma.adminRecoveryRequest.findFirst({ where: { adminId }, orderBy: { id: 'desc' } }); },
  request: async (id) => prisma.adminRecoveryRequest.findUnique({ where: { id } }),
  approvals: async (requestId) => prisma.adminRecoveryApproval.findMany({ where: { requestId }, orderBy: { id: 'asc' } }),
  invitations: async (requestId) => prisma.adminInvitation.findMany({ where: { recoveryRequestId: requestId }, orderBy: { id: 'asc' } }),
  auditText: async (adminIds) => JSON.stringify(await prisma.securityEvent.findMany({ where: { createdAt: { gte: STARTED_AT }, OR: [{ actorId: { in: adminIds } }, { identifier: { contains: RUN } }] } })),
  countOtherAdmins: async () => prisma.adminUser.count({ where: { id: { notIn: created.map((c) => c.id) } } }),
  countRunAdmins: async () => prisma.adminUser.count({ where: { email: { contains: `-${RUN}@e2e.humancare.invalid` } } }),
  rawRequestRow: async (id) => prisma.adminRecoveryRequest.findUnique({ where: { id } }),
};

// ---- mail capture ----------------------------------------------------------------------------------

async function mailbox() {
  const res = await fetch(MAIL_API);
  return res.json();
}
async function waitForMail(to, predicate = () => true, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await mailbox()).filter((m) => m.to.includes(to) && predicate(m));
    if (found.length) return found[found.length - 1];
    if (Date.now() > deadline) throw new Error(`no matching email to ${to.split('-')[0]} arrived in time`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
/** The portal path + fragment of the one-time link in a message, e.g. /accept-invite#token=... */
function linkFrom(message, pathName) {
  const m = new RegExp(`${PORTAL.replace(/[.]/g, '\\.')}(${pathName}#token=[A-Za-z0-9_-]{43})`).exec(message.text);
  if (!m) throw new Error(`no ${pathName} link in the message`);
  return m[1];
}
const tokenOf = (link) => link.split('#token=')[1];

// ---- Chromium virtual authenticator (real WebAuthn in the browser) ---------------------------------

async function attachAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    id: authenticatorId,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    setUserVerified: (isUserVerified) => cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified }),
    setPresence: (enabled) => cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled }),
  };
}

/** A separate browser profile (own cookies and storage) with its own virtual authenticator. */
async function newPerson(browser, label) {
  const context = await browser.newContext({ baseURL: PORTAL });
  const page = await context.newPage();
  const authenticator = await attachAuthenticator(page);
  return { label, context, page, authenticator };
}

// ---- UI flows ------------------------------------------------------------------------------------------

async function acceptInvitation(page, link) {
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Welcome to HumanCare Admin' })).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Save password and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your passkey' })).toBeVisible();
  await page.getByLabel('Passkey name (optional)').fill('E2E virtual key');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
}

async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const sessionCookies = async (context) => (await context.cookies()).filter((c) => /^hc_admin/.test(c.name));

module.exports = {
  PORTAL, API, MAIL_API, RUN, PASSWORD, STARTED_AT, emailFor, RUN_EMAIL,
  isolationChecks, assertIsolatedDb, provision, runCli, cleanupRun, db, created,
  mailbox, waitForMail, linkFrom, tokenOf, hashToken,
  attachAuthenticator, newPerson, acceptInvitation, signIn, sessionCookies,
  testEnv, prisma, guard,
};
