// Interleavings of the recovery services (Step 7.9.9): cancellation, Admin disable and break-glass
// racing redemption, registration and each other. Each race is run in both start orders and the
// test asserts the INVARIANT that must hold whichever side wins, not a particular winner.
//
// IMPORTANT LIMIT: Prisma here is the in-memory stand-in from admin-lock-fake-db.js. It models row
// locks (updateMany on a numeric id) and atomic updateMany, and it yields between operations, so it
// does exercise the services' lock-then-recheck logic. It is NOT MySQL: it has no InnoDB isolation
// levels, gap locks, deadlock detection or lock timeouts. These tests do not validate real-database
// concurrency; that needs the dedicated test database (see the Step 7.9.9 report).
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const crypto = require('crypto');
const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { makeRegistrationResponse } = require('./admin-webauthn-test-authenticator');
const { hashToken } = require('../src/common/utils/token-hash');
const { ProvisioningError } = require('../src/modules/admin/auth/admin-provisioning.service');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { cancelRecoveryRequest, createRecoveryRequest } = require('../src/modules/admin/auth/admin-recovery-request.service');
const { breakGlassRecovery, breakGlassConfirmation } = require('../src/modules/admin/auth/admin-recovery-decision.service');
const {
  redeemRecoveryInvitation,
  generateRecoveryRegistrationOptions,
  verifyRecoveryPasskeyRegistration,
} = require('../src/modules/admin/auth/admin-recovery-registration.service');
const { disableAdminAccount } = require('../src/modules/admin/auth/admin-account.service');

const { db, fake, NOW, PASSWORD, seedAdmin, seedPasskey } = kit;
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'target@example.org';
const REASON = 'Lost the only hardware key and no other superadmin exists';

const savedPortal = process.env.ADMIN_PORTAL_URL;

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  process.env.ADMIN_PORTAL_URL = 'https://admin.example.org';
  mailer.sendMail.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
  if (savedPortal === undefined) delete process.env.ADMIN_PORTAL_URL; else process.env.ADMIN_PORTAL_URL = savedPortal;
});

// ---- fixtures ------------------------------------------------------------------------------

const startSession = (admin) => fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now: NOW }));
const liveInvitations = () => db.invitations.filter((i) => !i.usedAt && !i.revokedAt && i.expiresAt > at(5));
const openRequests = () => db.recoveryRequests.filter((r) => ['pending', 'approved'].includes(r.status));

// The Admin who lost their passkey, with an old passkey and a session, and an APPROVED request
// whose invitation (raw token known) is waiting.
async function approvedRecovery() {
  const admin = seedAdmin({ email: EMAIL, name: 'Tara Target', role: 'admin' });
  const oldPasskey = seedPasskey(admin);
  const session = await startSession(admin);
  const request = {
    id: 1, adminId: admin.id, requestedByAdminId: null, requestedVia: 'operator', requestIp: null, reason: 'Lost laptop',
    status: 'approved', approvalsRequired: 2, approvedAt: at(-3600), completedAt: null, expiresAt: new Date(NOW.getTime() + 7 * DAY), createdAt: at(-7200),
  };
  db.recoveryRequests.push(request);
  const token = crypto.randomBytes(32).toString('base64url');
  const invitation = {
    id: 1, adminId: admin.id, purpose: 'passkey_recovery', recoveryRequestId: 1, tokenHash: hashToken(token), sentToEmail: EMAIL,
    expiresAt: new Date(NOW.getTime() + DAY), usedAt: null, revokedAt: null, createdAt: at(-3600),
  };
  db.invitations.push(invitation);
  return { admin, oldPasskey, session, request, token, invitation };
}

const redeem = (fx) => redeemRecoveryInvitation({ token: fx.token, password: PASSWORD, now: at(1) });

// Redeemed, with registration options issued and a genuine response ready to send.
async function readyToRegister(fx) {
  const { recoveryTicket } = await redeem(fx);
  const options = await generateRecoveryRegistrationOptions({ ticket: recoveryTicket, now: at(2) });
  const reg = makeRegistrationResponse({ challenge: options.challenge });
  return { ticket: recoveryTicket, reg };
}
const verify = ({ ticket, reg }) => verifyRecoveryPasskeyRegistration({ ticket, response: reg.response, label: 'New key', now: at(3) });
const cancel = (id = 1) => cancelRecoveryRequest({ id, reason: 'Raised in error', now: at(3) });
const disable = () => disableAdminAccount({ email: EMAIL, reason: 'Left the company', now: at(3) });

// Two interleavings of "something else" with a registration/redemption:
//  - 'other starts first': both are started together. In the in-memory database the competing
//    operation reaches its transaction sooner (registration reads and burns its challenge first), so
//    it normally wins the race for the locks;
//  - 'other starts mid-transaction': the competing operation is started at the moment the
//    registration/redemption transaction is open and holds its locks (right after the new passkey is
//    inserted / the invitation is claimed), so the registration is the one that wins.
// Between them both outcomes are exercised. The tests assert what must hold in either.
const RACES = ['other starts first', 'other starts mid-transaction'];

// Wraps a transaction client so `fire` runs when the registration/redemption reaches its decisive write.
const TRIGGERS = {
  registration: (tx, fire) => ({ ...tx, adminPasskey: { ...tx.adminPasskey, create: async (args) => { fire(); return tx.adminPasskey.create(args); } } }),
  redemption: (tx, fire) => ({
    ...tx,
    adminInvitation: { ...tx.adminInvitation, updateMany: async (args) => { if (args.data && args.data.usedAt) fire(); return tx.adminInvitation.updateMany(args); } },
  }),
};

async function race(mode, otherJob, registrationJob, trigger) {
  if (mode === RACES[0]) {
    const [other, registration] = await Promise.allSettled([otherJob(), registrationJob()]);
    return { other, registration };
  }
  const original = fake.prisma.$transaction.bind(fake.prisma);
  let fired = false;
  let otherPromise = null;
  jest.spyOn(fake.prisma, '$transaction').mockImplementation((fn) => original((tx) => fn(TRIGGERS[trigger](tx, () => {
    if (!fired) {
      fired = true;
      otherPromise = otherJob();
    }
  }))));
  const [registration] = await Promise.allSettled([registrationJob()]);
  const [other] = otherPromise ? await Promise.allSettled([otherPromise]) : [{ status: 'rejected', reason: { code: 'never_started' } }];
  expect(fired).toBe(true); // the competing operation really did start inside the open transaction
  return { other, registration };
}

const newPasskeys = (fx) => db.passkeys.filter((p) => p.adminId === fx.admin.id && p.id !== fx.oldPasskey.row.id);

// ---- cancellation racing redemption ----------------------------------------------------------

describe('cancelling a recovery while the link is being redeemed', () => {
  it.each(RACES)('%s: the request ends cancelled and no usable ticket survives', async (order) => {
    const fx = await approvedRecovery();
    const { other, registration } = await race(order, () => cancel(), () => redeem(fx), 'redemption');

    expect(other.status).toBe('fulfilled'); // the cancellation always succeeds: redemption never closes a request
    expect(fx.request.status).toBe('cancelled');
    expect(liveInvitations()).toHaveLength(0);
    if (registration.status === 'fulfilled') {
      // Redeemed first: the ticket exists but is dead, because its request is no longer approved.
      await expect(generateRecoveryRegistrationOptions({ ticket: registration.value.recoveryTicket, now: at(4) })).rejects.toMatchObject({ code: 'invalid_recovery' });
    } else {
      expect(registration.reason.code).toBe('invalid_recovery');
    }
    expect(newPasskeys(fx)).toHaveLength(0);
    expect(fx.oldPasskey.row.revokedAt).toBeNull();
  });
});

// ---- cancellation racing registration --------------------------------------------------------

describe('cancelling a recovery while the new passkey is being registered', () => {
  it.each(RACES)('%s: exactly one terminal state, and the passkeys match it', async (order) => {
    const fx = await approvedRecovery();
    const ready = await readyToRegister(fx);
    const { other, registration } = await race(order, () => cancel(), () => verify(ready), 'registration');
    if (order === RACES[1]) expect(registration.status).toBe('fulfilled'); // started mid-transaction: the registration holds the locks and wins

    expect([other.status, registration.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    if (registration.status === 'fulfilled') {
      expect(other.reason).toBeInstanceOf(ProvisioningError);
      expect(other.reason.code).toBe('not_pending');
      expect(fx.request.status).toBe('completed');
      expect(newPasskeys(fx)).toHaveLength(1);
      expect(fx.oldPasskey.row.revokedAt).not.toBeNull();
    } else {
      expect(registration.reason.code).toBe('invalid_recovery');
      expect(fx.request.status).toBe('cancelled');
      expect(newPasskeys(fx)).toHaveLength(0);
      expect(fx.oldPasskey.row.revokedAt).toBeNull(); // the old passkey is untouched
      expect(db.sessions.find((s) => s.id === fx.session.sessionId).revokedAt).toBeNull();
    }
  });
});

// ---- Admin disable during recovery -----------------------------------------------------------

describe('disabling the Admin while their recovery is being registered', () => {
  it.each(RACES)('%s: never both recovered and cancelled; the account ends disabled', async (order) => {
    const fx = await approvedRecovery();
    const ready = await readyToRegister(fx);
    const { other, registration } = await race(order, disable, () => verify(ready), 'registration');
    if (order === RACES[1]) expect(registration.status).toBe('fulfilled'); // started mid-transaction: the registration holds the locks and wins

    expect(other.status).toBe('fulfilled');
    expect(fx.admin.status).toBe('disabled');
    expect(liveInvitations()).toHaveLength(0);
    if (registration.status === 'fulfilled') {
      // Recovery finished first; the disable then only ended the (already revoked) sessions.
      expect(fx.request.status).toBe('completed');
      expect(newPasskeys(fx)).toHaveLength(1);
    } else {
      expect(registration.reason.code).toBe('invalid_recovery');
      expect(fx.request.status).toBe('cancelled');
      expect(newPasskeys(fx)).toHaveLength(0);
      expect(fx.oldPasskey.row.revokedAt).toBeNull();
    }
    // Either way the target has no live session left.
    expect(db.sessions.filter((s) => s.adminId === fx.admin.id && !s.revokedAt)).toHaveLength(0);
  });

  it.each(RACES)('%s (redemption): the ticket never survives a disable', async (order) => {
    const fx = await approvedRecovery();
    const { other, registration } = await race(order, disable, () => redeem(fx), 'redemption');
    expect(other.status).toBe('fulfilled');
    expect(fx.request.status).toBe('cancelled');
    if (registration.status === 'fulfilled') {
      await expect(generateRecoveryRegistrationOptions({ ticket: registration.value.recoveryTicket, now: at(4) })).rejects.toMatchObject({ code: 'invalid_recovery' });
    }
    expect(newPasskeys(fx)).toHaveLength(0);
  });
});

// ---- break-glass racing other operator actions ------------------------------------------------

describe('break-glass racing other operator actions on the same Admin', () => {
  const breakGlass = () => breakGlassRecovery({ email: EMAIL, reason: REASON, confirmation: breakGlassConfirmation(EMAIL), now: NOW });
  const ordinary = () => createRecoveryRequest({ email: EMAIL, reason: 'Lost laptop', now: NOW });

  it.each(['break-glass first', 'ordinary first'])('%s: a break-glass and an ordinary request never both open', async (order) => {
    seedAdmin({ email: EMAIL, name: 'Tara Target' });
    const jobs = order === 'break-glass first' ? [breakGlass, ordinary] : [ordinary, breakGlass];
    const results = await Promise.allSettled(jobs.map((job) => job()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('open_request_exists');
    expect(openRequests()).toHaveLength(1);
    expect(db.invitations.length).toBeLessThanOrEqual(1);
  });

  it.each(['break-glass first', 'disable first'])('%s: no live recovery survives the Admin being disabled', async (order) => {
    const admin = seedAdmin({ email: EMAIL, name: 'Tara Target' });
    const jobs = order === 'break-glass first' ? [breakGlass, disable] : [disable, breakGlass];
    const results = await Promise.allSettled(jobs.map((job) => job()));
    expect(admin.status).toBe('disabled');
    expect(openRequests()).toHaveLength(0);
    expect(liveInvitations()).toHaveLength(0);
    const failed = results.filter((r) => r.status === 'rejected');
    failed.forEach((r) => expect(r.reason.code).toBe('target_not_active'));
  });

  it('two break-glass attempts on two different Admins both work, each with its own request and invitation', async () => {
    seedAdmin({ email: EMAIL, name: 'Tara Target' });
    seedAdmin({ email: 'other@example.org', name: 'Other' });
    const results = await Promise.allSettled([
      breakGlass(),
      breakGlassRecovery({ email: 'other@example.org', reason: REASON, confirmation: breakGlassConfirmation('other@example.org'), now: NOW }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(db.recoveryRequests).toHaveLength(2);
    expect(new Set(db.invitations.map((i) => i.recoveryRequestId)).size).toBe(2);
  });
});
