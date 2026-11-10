// Two-person recovery decisions (Step 7.9.4): the approver's passkey step-up, approval, rejection,
// and the recovery invitation issued by the second approval. Service layer only. No database:
// Prisma is the in-memory stand-in from admin-lock-fake-db.js; the REAL @simplewebauthn/server
// verifies genuine assertions built by the software authenticator; mail never leaves the process.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));
jest.mock('../src/lib/mailer', () => ({ sendMail: jest.fn() }));

const kit = require('./admin-login-test-kit');
const mailer = require('../src/lib/mailer');
const { hashToken } = require('../src/common/utils/token-hash');
const { createAdminSession } = require('../src/modules/admin/auth/admin-session.service');
const { createRecoveryRequest } = require('../src/modules/admin/auth/admin-recovery-request.service');
const { disableAdminAccount } = require('../src/modules/admin/auth/admin-account.service');
const {
  issueRecoveryStepUp,
  approveRecoveryRequest,
  rejectRecoveryRequest,
  RecoveryDecisionError,
} = require('../src/modules/admin/auth/admin-recovery-decision.service');

const { db, fake, seedAdmin, seedPasskey, makeAssertionResponse } = kit;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PORTAL = 'https://admin.example.org';
const TARGET_EMAIL = 'target@example.org';

const savedPortal = process.env.ADMIN_PORTAL_URL;

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  process.env.ADMIN_PORTAL_URL = PORTAL;
  mailer.sendMail.mockReset().mockImplementation(async () => { db.events.push('email'); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
  if (savedPortal === undefined) delete process.env.ADMIN_PORTAL_URL; else process.env.ADMIN_PORTAL_URL = savedPortal;
});

// ---- fixtures ------------------------------------------------------------------------------

const startSession = (admin, now = NOW) => fake.prisma.$transaction((tx) => createAdminSession(tx, { admin, now }));

// An active superadmin with a passkey and a live session.
async function approver(email, overrides = {}) {
  const admin = seedAdmin({ email, role: 'superadmin', ...overrides });
  const passkey = seedPasskey(admin);
  const session = await startSession(admin);
  return { admin, passkey, sessionId: session.sessionId, counter: 1 };
}

// The Admin who lost their passkey: active, with an old passkey, a session and a failed-login count.
async function targetAdmin(overrides = {}) {
  const admin = seedAdmin({ email: TARGET_EMAIL, name: 'Tara Target', role: 'admin', failedLoginCount: 3, ...overrides });
  const passkey = seedPasskey(admin);
  const session = await startSession(admin);
  return { admin, passkey, sessionId: session.sessionId };
}

async function openRequest(overrides = {}) {
  const created = await createRecoveryRequest({ email: TARGET_EMAIL, reason: 'Lost laptop', now: NOW, ...overrides });
  mailer.sendMail.mockClear();
  db.events.length = 0;
  return db.recoveryRequests.find((r) => r.id === created.request.id);
}

const base = (who, requestId) => ({ requestId, approverId: who.admin.id, sessionId: who.sessionId });
const stepUp = (kind, who, requestId, overrides = {}) => issueRecoveryStepUp({ kind, ...base(who, requestId), now: NOW, ...overrides });

// A genuine assertion for the options just issued, advancing this approver's authenticator counter.
function assertion(who, options, overrides = {}) {
  const response = makeAssertionResponse({ challenge: options.challenge, registered: who.passkey.reg, counter: who.counter, ...overrides });
  who.counter += 1;
  return response;
}

// Step-up then decision, the way a client would do it.
async function decide(kind, who, requestId, { stepNow = NOW, now = at(5), reason, mutateResponse, ...extra } = {}) {
  const issued = await stepUp(kind, who, requestId, { now: stepNow });
  const response = mutateResponse ? mutateResponse(assertion(who, issued.options)) : assertion(who, issued.options);
  const run = kind === 'approve' ? approveRecoveryRequest : rejectRecoveryRequest;
  return run({ ...base(who, requestId), response, reason, now, ...extra });
}
const approve = (who, requestId, options) => decide('approve', who, requestId, options);
const reject = (who, requestId, options) => decide('reject', who, requestId, options);

async function refusedWith(promise, code, reason) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(RecoveryDecisionError);
  expect(error.code).toBe(code);
  if (reason) expect(error.reason).toBe(reason);
  expect(Object.keys(error).sort()).toEqual(['code', 'name']); // the reason is never serialised
  return error;
}

const auditsOf = (event) => db.audits.filter((a) => a.event === event);
const invitations = () => db.invitations.filter((i) => i.purpose === 'passkey_recovery');
const approvalRows = () => db.recoveryApprovals;

// ---- 1. step-up challenge ------------------------------------------------------------------

describe('issueRecoveryStepUp', () => {
  it('issues a 120-second challenge bound to the approver, the request and the session', async () => {
    const target = await targetAdmin();
    const a = await approver('a@example.org');
    const request = await openRequest();
    const issued = await stepUp('approve', a, request.id);

    expect(issued).toMatchObject({ decision: 'approve', requestId: request.id, expiresAt: at(120) });
    expect(issued.options).toMatchObject({ rpId: 'localhost', userVerification: 'required', timeout: 120000 });
    expect(issued.options.allowCredentials).toHaveLength(1);
    expect(db.challenges).toHaveLength(1);
    expect(db.challenges[0]).toMatchObject({
      adminId: a.admin.id, purpose: 'recovery_approval', recoveryRequestId: request.id, sessionId: a.sessionId, consumedAt: null, expiresAt: at(120),
    });
    expect(db.challenges[0].challenge).toBe(issued.options.challenge);
    expect(db.passkeys.find((p) => p.adminId === target.admin.id).signCount).toBe(0);
  });

  it('uses a different purpose for rejection, and the two coexist', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    await stepUp('approve', a, request.id);
    await stepUp('reject', a, request.id);
    expect(db.challenges.map((c) => [c.purpose, c.consumedAt])).toEqual([['recovery_approval', null], ['recovery_rejection', null]]);
  });

  it('refuses a kind other than approve / reject', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    for (const kind of ['approved', 'APPROVE', undefined, '']) {
      await expect(stepUp(kind, a, request.id)).rejects.toThrow(TypeError);
    }
  });

  it('writes an audit event and no secret', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    const issued = await stepUp('approve', a, request.id);
    expect(auditsOf('admin_recovery_stepup_issued')).toEqual([
      expect.objectContaining({ actorType: 'admin', actorId: a.admin.id, detail: { recoveryRequestId: request.id, decision: 'approve', sessionId: a.sessionId } }),
    ]);
    expect(JSON.stringify(db.audits)).not.toContain(issued.options.challenge);
  });

  describe('who may ask', () => {
    let request;
    beforeEach(async () => {
      await targetAdmin();
      request = await openRequest();
    });

    it.each([
      ['an ordinary admin', { role: 'admin' }],
      ['a disabled superadmin', { status: 'disabled' }],
      ['an invited superadmin', { status: 'invited' }],
      ['a pending-passkey superadmin', { status: 'pending_passkey' }],
    ])('refuses %s', async (_label, overrides) => {
      const who = await approver('x@example.org', overrides);
      await refusedWith(stepUp('approve', who, request.id), 'not_available', 'approver_ineligible');
      expect(db.challenges).toHaveLength(0);
    });

    it('refuses the target of the request, even a superadmin', async () => {
      db.admins.find((a) => a.email === TARGET_EMAIL).role = 'superadmin';
      const targetRow = db.admins.find((a) => a.email === TARGET_EMAIL);
      const asApprover = { admin: targetRow, sessionId: db.sessions[0].id, passkey: { reg: null }, counter: 1 };
      await refusedWith(stepUp('approve', asApprover, request.id), 'not_available');
      await refusedWith(stepUp('reject', asApprover, request.id), 'not_available');
      expect(db.challenges).toHaveLength(0);
    });

    it('refuses the Admin who filed the request', async () => {
      const who = await approver('filer@example.org');
      request.requestedByAdminId = who.admin.id;
      await refusedWith(stepUp('approve', who, request.id), 'not_available', 'approver_ineligible');
    });

    it('refuses without a live session: revoked, expired, someone else\'s, or unknown', async () => {
      const who = await approver('a@example.org');
      const other = await approver('b@example.org');
      await refusedWith(stepUp('approve', who, request.id, { sessionId: other.sessionId }), 'not_available', 'session_invalid');
      await refusedWith(stepUp('approve', who, request.id, { sessionId: 999 }), 'not_available', 'session_invalid');
      await refusedWith(stepUp('approve', who, request.id, { now: at(31 * 60) }), 'not_available'); // idle timeout
      db.sessions.find((s) => s.id === who.sessionId).revokedAt = NOW;
      await refusedWith(stepUp('approve', who, request.id), 'not_available', 'session_invalid');
      expect(db.challenges).toHaveLength(0);
    });

    it('refuses an approver with no live passkey', async () => {
      const who = await approver('a@example.org');
      db.passkeys.find((p) => p.adminId === who.admin.id).revokedAt = NOW;
      await refusedWith(stepUp('approve', who, request.id), 'not_available');
    });

    it.each([
      ['unknown', () => 9999],
      ['not pending (approved)', (r) => { r.status = 'approved'; return r.id; }],
      ['not pending (rejected)', (r) => { r.status = 'rejected'; return r.id; }],
      ['not pending (cancelled)', (r) => { r.status = 'cancelled'; return r.id; }],
      ['not pending (completed)', (r) => { r.status = 'completed'; return r.id; }],
      ['not pending (expired)', (r) => { r.status = 'expired'; return r.id; }],
      ['past its deadline', (r) => { r.expiresAt = new Date(NOW.getTime() - 1); return r.id; }],
      ['at its deadline', (r) => { r.expiresAt = new Date(NOW.getTime()); return r.id; }],
    ])('refuses a request that is %s', async (_label, prepare) => {
      const who = await approver('a@example.org');
      const id = prepare(request);
      await refusedWith(stepUp('approve', who, id), 'not_available');
      expect(db.challenges).toHaveLength(0);
    });

    it('refuses once the target is no longer active', async () => {
      const who = await approver('a@example.org');
      db.admins.find((a) => a.email === TARGET_EMAIL).status = 'disabled';
      await refusedWith(stepUp('approve', who, request.id), 'not_available', 'target_unavailable');
    });

    it('refuses an approver who already decided', async () => {
      const who = await approver('a@example.org');
      await approver('b@example.org');
      await approve(who, request.id);
      await refusedWith(stepUp('approve', who, request.id), 'already_decided');
      await refusedWith(stepUp('reject', who, request.id), 'already_decided');
    });

    it('rejects bad ids', async () => {
      const who = await approver('a@example.org');
      for (const bad of [0, -1, 1.5, '1', null, undefined]) {
        await expect(stepUp('approve', who, bad)).rejects.toThrow(TypeError);
        await expect(stepUp('approve', who, request.id, { approverId: bad })).rejects.toThrow(TypeError);
        await expect(stepUp('approve', who, request.id, { sessionId: bad })).rejects.toThrow(TypeError);
      }
    });
  });

  it('a newer step-up of the same kind retires the older one', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    const first = await stepUp('approve', a, request.id);
    await stepUp('approve', a, request.id, { now: at(1) });
    // the old response signs the retired challenge: the current one is consumed, then verification fails
    await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, first.options), now: at(5) }), 'step_up_failed', 'verification_failed');
    expect(db.challenges.filter((c) => c.consumedAt === null)).toHaveLength(0);
  });

  it('an audit failure leaves no challenge behind', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    db.failAudit = true;
    await expect(stepUp('approve', a, request.id)).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(db.challenges).toHaveLength(0);
  });

  it('fails as a server fault, not a refusal, without WebAuthn configuration', async () => {
    const a = await approver('a@example.org');
    await targetAdmin();
    const request = await openRequest();
    delete process.env.ADMIN_WEBAUTHN_RP_NAME;
    await expect(stepUp('approve', a, request.id)).rejects.toThrow(/Invalid Admin Lock WebAuthn configuration/);
  });
});

// ---- 2. approval, rejection and the invitation ---------------------------------------------

describe('approval', () => {
  let target; let a; let b; let request;
  beforeEach(async () => {
    target = await targetAdmin();
    a = await approver('a@example.org');
    b = await approver('b@example.org');
    request = await openRequest();
  });

  it('the first approval is recorded and the request stays pending, with no invitation or email', async () => {
    const result = await approve(a, request.id, { reason: 'Verified by phone' });
    expect(result).toEqual({
      decision: 'approve', requestId: request.id, status: 'pending', validApprovals: 1, invitation: null, emailDelivered: null, emailError: null,
    });
    expect(request.status).toBe('pending');
    expect(approvalRows()).toEqual([expect.objectContaining({
      requestId: request.id, approverId: a.admin.id, approverRole: 'superadmin', decision: 'approved', reason: 'Verified by phone',
    })]);
    expect(invitations()).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(auditsOf('admin_recovery_approval_recorded')[0]).toMatchObject({
      actorType: 'admin',
      actorId: a.admin.id,
      detail: { adminId: target.admin.id, recoveryRequestId: request.id, decision: 'approved', decidedAt: at(5).toISOString(), validApprovals: 1, approvalsRequired: 2 },
    });
  });

  it('two distinct approvals approve the request and create exactly one linked recovery invitation', async () => {
    await approve(a, request.id);
    const result = await approve(b, request.id, { now: at(10) });

    expect(result).toMatchObject({ status: 'approved', validApprovals: 2, emailDelivered: true, emailError: null });
    expect(request).toMatchObject({ status: 'approved', approvedAt: at(10) });
    expect(approvalRows().map((r) => r.approverId).sort()).toEqual([a.admin.id, b.admin.id].sort());

    expect(invitations()).toHaveLength(1);
    expect(invitations()[0]).toMatchObject({
      adminId: target.admin.id,
      purpose: 'passkey_recovery',
      recoveryRequestId: request.id,
      sentToEmail: TARGET_EMAIL,
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date(at(10).getTime() + DAY),
    });
    expect(result.invitation).toEqual({ id: invitations()[0].id, expiresAt: new Date(at(10).getTime() + DAY) });
    expect(auditsOf('admin_recovery_approved')).toHaveLength(1);
    expect(auditsOf('admin_recovery_invitation_created')[0].detail).toMatchObject({ recoveryRequestId: request.id, invitationId: result.invitation.id });
  });

  it('stores only a hash of the token, and the email carries the only copy of the link', async () => {
    await approve(a, request.id);
    await approve(b, request.id, { now: at(10) });
    const [message] = mailer.sendMail.mock.calls[0];
    const token = /#token=([A-Za-z0-9_-]{43})$/m.exec(message.text)[1];
    expect(message.text).toContain(`${PORTAL}/recover-passkey#token=${token}`);
    expect(message).toMatchObject({ to: TARGET_EMAIL, sensitive: true });
    expect(invitations()[0].tokenHash).toBe(hashToken(token));
    expect(invitations()[0].tokenHash).not.toBe(token);
    // the token is nowhere else
    const everything = JSON.stringify({ audits: db.audits, invitations: db.invitations, requests: db.recoveryRequests, approvals: db.recoveryApprovals, logs: console.error.mock.calls });
    expect(everything).not.toContain(token);
    expect(db.events.indexOf('commit')).toBeGreaterThan(-1);
    expect(db.events.lastIndexOf('commit')).toBeLessThan(db.events.indexOf('email')); // sent only after the commit
  });

  it('keeps the request\'s original seven-day deadline', async () => {
    const deadline = request.expiresAt;
    await approve(a, request.id);
    await approve(b, request.id, { now: at(10) });
    expect(request.expiresAt).toEqual(deadline);
    expect(deadline).toEqual(new Date(NOW.getTime() + 7 * DAY));
  });

  it('refuses a third approval once the request is approved', async () => {
    const c = await approver('c@example.org');
    await approve(a, request.id);
    await approve(b, request.id, { now: at(10) });
    await refusedWith(stepUp('approve', c, request.id, { now: at(11) }), 'not_available');
    expect(invitations()).toHaveLength(1);
  });

  it('refuses a second decision by the same approver, however it is attempted', async () => {
    await approve(a, request.id);
    await refusedWith(approve(a, request.id, { now: at(20) }), 'already_decided');
    await refusedWith(reject(a, request.id, { now: at(20) }), 'already_decided');
    expect(approvalRows()).toHaveLength(1);
    expect(request.status).toBe('pending');
  });

  it('leaves the target\'s passkeys, sessions, password state and failed-login counter exactly as they were', async () => {
    const before = JSON.stringify({
      admin: db.admins.find((x) => x.id === target.admin.id),
      passkeys: db.passkeys.filter((p) => p.adminId === target.admin.id),
      sessions: db.sessions.filter((s) => s.adminId === target.admin.id),
      tokens: db.refreshTokens.filter((t) => t.sessionId === target.sessionId),
    }, (k, v) => (k === 'updatedAt' ? undefined : v));
    await approve(a, request.id);
    await approve(b, request.id, { now: at(10) });
    const after = JSON.stringify({
      admin: db.admins.find((x) => x.id === target.admin.id),
      passkeys: db.passkeys.filter((p) => p.adminId === target.admin.id),
      sessions: db.sessions.filter((s) => s.adminId === target.admin.id),
      tokens: db.refreshTokens.filter((t) => t.sessionId === target.sessionId),
    }, (k, v) => (k === 'updatedAt' ? undefined : v));
    expect(after).toBe(before);
    expect(db.admins.find((x) => x.id === target.admin.id)).toMatchObject({ failedLoginCount: 3, status: 'active' });
    expect(db.passkeys.find((p) => p.adminId === target.admin.id)).toMatchObject({ revokedAt: null, signCount: 0 });
  });

  it('advances only the approver\'s own passkey counter, once', async () => {
    await approve(a, request.id);
    expect(db.passkeys.find((p) => p.adminId === a.admin.id)).toMatchObject({ signCount: 1, lastUsedAt: at(5) });
    expect(db.passkeys.find((p) => p.adminId === b.admin.id).signCount).toBe(0);
  });

  it('does not touch the approver\'s or the target\'s lockout counters', async () => {
    a.admin.failedLoginCount = 2;
    await approve(a, request.id);
    expect(a.admin.failedLoginCount).toBe(2);
    expect(db.admins.find((x) => x.id === target.admin.id).failedLoginCount).toBe(3);
  });

  describe('the passkey step-up is enforced', () => {
    it('an approval challenge cannot authorise a rejection (and the reverse)', async () => {
      const issued = await stepUp('approve', a, request.id);
      const response = assertion(a, issued.options);
      await refusedWith(rejectRecoveryRequest({ ...base(a, request.id), response, now: at(5) }), 'step_up_failed', 'challenge_unavailable');
      expect(request.status).toBe('pending');

      const rejection = await stepUp('reject', a, request.id, { now: at(6) });
      // the approval challenge exists but the response signs the rejection challenge: it cannot verify
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, rejection.options), now: at(7) }), 'step_up_failed', 'verification_failed');
      expect(approvalRows()).toHaveLength(0);
      expect(request.status).toBe('pending');
    });

    it('a challenge for another request cannot be used', async () => {
      const second = seedAdmin({ email: 'second-target@example.org' });
      seedPasskey(second);
      const other = await createRecoveryRequest({ email: 'second-target@example.org', reason: 'Another loss', now: NOW });
      const issued = await stepUp('approve', a, request.id);
      await refusedWith(
        approveRecoveryRequest({ ...base(a, other.request.id), response: assertion(a, issued.options), now: at(5) }),
        'step_up_failed', 'challenge_unavailable',
      );
      expect(approvalRows()).toHaveLength(0);
    });

    it('a challenge issued for another session cannot be used', async () => {
      const second = await startSession(a.admin, at(1));
      const issued = await stepUp('approve', a, request.id);
      await refusedWith(
        approveRecoveryRequest({ requestId: request.id, approverId: a.admin.id, sessionId: second.sessionId, response: assertion(a, issued.options), now: at(5) }),
        'step_up_failed', 'challenge_unavailable',
      );
    });

    it('another Admin\'s challenge or credential cannot be used', async () => {
      const issued = await stepUp('approve', a, request.id);
      // b submits a's response under b's own identity: b has no open challenge
      await refusedWith(
        approveRecoveryRequest({ ...base(b, request.id), response: assertion(a, issued.options), now: at(5) }),
        'step_up_failed', 'challenge_unavailable',
      );
      // b has a challenge but answers it with a's credential
      const own = await stepUp('approve', b, request.id, { now: at(1) });
      await refusedWith(
        approveRecoveryRequest({ ...base(b, request.id), response: makeAssertionResponse({ challenge: own.options.challenge, registered: a.passkey.reg, counter: 5 }), now: at(5) }),
        'step_up_failed', 'unknown_credential',
      );
    });

    it('an expired challenge is refused (valid at 119 s, refused at 120 s)', async () => {
      const issued = await stepUp('approve', a, request.id);
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(120) }), 'step_up_failed', 'challenge_unavailable');
      const again = await stepUp('approve', a, request.id, { now: at(200) });
      await expect(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, again.options), now: at(319) })).resolves.toMatchObject({ status: 'pending' });
    });

    it('a replayed response is refused, and a failed assertion burns its challenge', async () => {
      const issued = await stepUp('approve', a, request.id);
      const response = assertion(a, issued.options);
      await approveRecoveryRequest({ ...base(a, request.id), response, now: at(5) });
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response, now: at(6) }), 'already_decided');

      const second = await stepUp('approve', b, request.id, { now: at(7) });
      const forged = assertion(b, second.options, { origin: 'https://evil.example' });
      await refusedWith(approveRecoveryRequest({ ...base(b, request.id), response: forged, now: at(8) }), 'step_up_failed', 'verification_failed');
      expect(db.challenges.find((c) => c.adminId === b.admin.id).consumedAt).not.toBeNull();
      await refusedWith(approveRecoveryRequest({ ...base(b, request.id), response: assertion(b, second.options), now: at(9) }), 'step_up_failed', 'challenge_unavailable');
      expect(approvalRows()).toHaveLength(1);
    });

    it('refuses a wrong-origin, wrong-RP and user-verification-less assertion and a counter regression', async () => {
      db.passkeys.find((p) => p.adminId === a.admin.id).signCount = 5;
      a.counter = 6;
      for (const overrides of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { flags: 0x01 }]) {
        const issued = await stepUp('approve', a, request.id);
        await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options, overrides), now: at(5) }), 'step_up_failed');
      }
      const issued = await stepUp('approve', a, request.id);
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options, { counter: 3 }), now: at(5) }), 'step_up_failed', 'counter_regression');
      expect(approvalRows()).toHaveLength(0);
      expect(db.passkeys.find((p) => p.adminId === a.admin.id).signCount).toBe(5);
      expect(db.passkeys.find((p) => p.adminId === a.admin.id).revokedAt).toBeNull();
      expect(auditsOf('admin_passkey_counter_regression')).toHaveLength(1);
    });

    it('refuses malformed responses without burning the challenge', async () => {
      const issued = await stepUp('approve', a, request.id);
      for (const response of [undefined, null, 'x', {}, { id: 'a' }]) {
        await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response, now: at(5) }), 'step_up_failed', 'invalid_response');
      }
      expect(db.challenges[0].consumedAt).toBeNull();
      await expect(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(6) })).resolves.toMatchObject({ status: 'pending' });
    });
  });

  describe('eligibility is checked again when the decision is recorded', () => {
    it('an approver demoted after the step-up cannot approve, and keeps their challenge', async () => {
      const issued = await stepUp('approve', a, request.id);
      a.admin.role = 'admin';
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) }), 'not_available', 'approver_ineligible');
      expect(db.challenges[0].consumedAt).toBeNull();
      expect(approvalRows()).toHaveLength(0);
    });

    it('an approver disabled after the step-up cannot approve', async () => {
      const issued = await stepUp('approve', a, request.id);
      a.admin.status = 'disabled';
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) }), 'not_available');
    });

    it('a session revoked after the step-up cannot be used to decide', async () => {
      const issued = await stepUp('approve', a, request.id);
      db.sessions.find((s) => s.id === a.sessionId).revokedAt = at(1);
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) }), 'not_available', 'session_invalid');
    });

    it('a disabled target blocks the final approval and no invitation appears', async () => {
      await approve(a, request.id);
      const issued = await stepUp('approve', b, request.id, { now: at(6) });
      db.admins.find((x) => x.email === TARGET_EMAIL).status = 'disabled';
      await refusedWith(approveRecoveryRequest({ ...base(b, request.id), response: assertion(b, issued.options), now: at(7) }), 'not_available', 'target_unavailable');
      expect(request.status).toBe('pending');
      expect(invitations()).toHaveLength(0);
    });

    it('an earlier approver who is later demoted does not count: the second approval then leaves the request pending', async () => {
      const c = await approver('c@example.org');
      await approve(a, request.id);
      a.admin.role = 'admin'; // demoted before the next approval
      const second = await approve(b, request.id, { now: at(10) });
      expect(second).toMatchObject({ status: 'pending', validApprovals: 1, invitation: null });
      expect(request.status).toBe('pending');
      expect(invitations()).toHaveLength(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();

      const third = await approve(c, request.id, { now: at(20) });
      expect(third).toMatchObject({ status: 'approved', validApprovals: 2 });
      expect(invitations()).toHaveLength(1);
      expect(approvalRows()).toHaveLength(3); // the demoted approval stays on record, uncounted
    });

    it('an earlier approver who is later disabled does not count either', async () => {
      const c = await approver('c@example.org');
      await approve(a, request.id);
      a.admin.status = 'disabled';
      expect(await approve(b, request.id, { now: at(10) })).toMatchObject({ status: 'pending', validApprovals: 1 });
      expect(await approve(c, request.id, { now: at(20) })).toMatchObject({ status: 'approved', validApprovals: 2 });
    });
  });

  describe('invitation expiry', () => {
    it('is capped by the request\'s own deadline when that comes first', async () => {
      request.expiresAt = new Date(at(10).getTime() + 3 * HOUR);
      await approve(a, request.id);
      const result = await approve(b, request.id, { now: at(10) });
      expect(invitations()[0].expiresAt).toEqual(request.expiresAt);
      expect(result.invitation.expiresAt).toEqual(new Date(at(10).getTime() + 3 * HOUR));
      expect(mailer.sendMail.mock.calls[0][0].text).toContain(request.expiresAt.toUTCString());
    });

    it('is 24 hours when the request has more than that left, and exact at the boundary', async () => {
      request.expiresAt = new Date(at(10).getTime() + DAY);
      await approve(a, request.id);
      await approve(b, request.id, { now: at(10) });
      expect(invitations()[0].expiresAt).toEqual(new Date(at(10).getTime() + DAY));

      fake.reset();
      db.auditClock = NOW;
      await targetAdmin();
      const c = await approver('c@example.org');
      const d = await approver('d@example.org');
      const longRequest = await openRequest();
      await approve(c, longRequest.id);
      await approve(d, longRequest.id, { now: at(10) });
      expect(invitations()[0].expiresAt).toEqual(new Date(at(10).getTime() + DAY)); // 7 days left: 24 h applies
    });

    it('is never created for a request that has expired or is no longer pending', async () => {
      const issued = await stepUp('approve', a, request.id);
      request.expiresAt = at(5); // the deadline passes before the decision is recorded
      await refusedWith(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) }), 'not_available');
      expect(invitations()).toHaveLength(0);
      expect(approvalRows()).toHaveLength(0);
    });

    it('is never duplicated: a live recovery invitation for the request stops the approval and rolls it back', async () => {
      await approve(a, request.id);
      db.invitations.push({
        id: 50, adminId: target.admin.id, purpose: 'passkey_recovery', recoveryRequestId: request.id, tokenHash: 'a'.repeat(64),
        sentToEmail: TARGET_EMAIL, expiresAt: at(3600), usedAt: null, revokedAt: null,
      });
      await expect(approve(b, request.id, { now: at(10) })).rejects.toThrow('live recovery invitation already exists');
      expect(request.status).toBe('pending');
      expect(approvalRows()).toHaveLength(1);
      expect(invitations()).toHaveLength(1);
      expect(db.passkeys.find((p) => p.adminId === b.admin.id).signCount).toBe(0);
    });
  });

  describe('email', () => {
    it('a failed invitation email keeps the approval and invitation, and records the failure safely', async () => {
      mailer.sendMail.mockRejectedValue(new Error('SMTP down: secret-host.internal'));
      await approve(a, request.id);
      const result = await approve(b, request.id, { now: at(10) });
      expect(result).toMatchObject({ status: 'approved', emailDelivered: false, emailError: 'SMTP down: secret-host.internal' });
      expect(request.status).toBe('approved');
      expect(invitations()).toHaveLength(1);
      const failed = auditsOf('admin_recovery_invitation_delivery_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].detail).toEqual({ adminId: target.admin.id, recoveryRequestId: request.id, kind: 'invitation', invitationId: invitations()[0].id });
      expect(JSON.stringify(failed[0])).not.toMatch(/SMTP|secret-host|token/i);
      expect(auditsOf('admin_recovery_invitation_sent')).toHaveLength(0);
    });

    it('a successful one is recorded too', async () => {
      await approve(a, request.id);
      await approve(b, request.id, { now: at(10) });
      expect(auditsOf('admin_recovery_invitation_sent')).toHaveLength(1);
    });

    it('even if recording the outcome fails as well, the decision stands', async () => {
      await approve(a, request.id);
      mailer.sendMail.mockImplementation(async () => { db.failAudit = true; throw new Error('down'); });
      await expect(approve(b, request.id, { now: at(10) })).resolves.toMatchObject({ status: 'approved', emailDelivered: false });
      expect(request.status).toBe('approved');
    });

    it('needs a portal URL before anything is committed or consumed', async () => {
      delete process.env.ADMIN_PORTAL_URL;
      const issued = await stepUp('approve', a, request.id);
      await expect(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) })).rejects.toThrow(/ADMIN_PORTAL_URL/);
      expect(db.challenges[0].consumedAt).toBeNull();
      expect(approvalRows()).toHaveLength(0);
    });
  });

  describe('atomicity', () => {
    it('an audit failure leaves no partial decision (the challenge stays burned)', async () => {
      const issued = await stepUp('approve', a, request.id);
      const response = assertion(a, issued.options);
      db.failAudit = true;
      await expect(approveRecoveryRequest({ ...base(a, request.id), response, now: at(5) })).rejects.toThrow('audit write failed');
      db.failAudit = false;
      expect(approvalRows()).toHaveLength(0);
      expect(request.status).toBe('pending');
      expect(db.passkeys.find((p) => p.adminId === a.admin.id)).toMatchObject({ signCount: 0, lastUsedAt: null });
      expect(db.challenges[0].consumedAt).not.toBeNull();
      await expect(approve(a, request.id, { now: at(20) })).resolves.toMatchObject({ status: 'pending' }); // a fresh step-up works
    });

    it('a database failure while recording the decision leaves nothing behind', async () => {
      const issued = await stepUp('approve', a, request.id);
      db.failCreate = 'recoveryApprovals';
      await expect(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) })).rejects.toThrow('recoveryApprovals create failed');
      db.failCreate = null;
      expect(approvalRows()).toHaveLength(0);
      expect(db.passkeys.find((p) => p.adminId === a.admin.id).signCount).toBe(0);
    });

    it('a failure creating the invitation rolls the final approval back completely', async () => {
      await approve(a, request.id);
      const issued = await stepUp('approve', b, request.id, { now: at(6) });
      db.failCreate = 'invitations';
      await expect(approveRecoveryRequest({ ...base(b, request.id), response: assertion(b, issued.options), now: at(7) })).rejects.toThrow('invitations create failed');
      db.failCreate = null;
      expect(request).toMatchObject({ status: 'pending', approvedAt: null });
      expect(approvalRows()).toHaveLength(1);
      expect(invitations()).toHaveLength(0);
      expect(db.passkeys.find((p) => p.adminId === b.admin.id).signCount).toBe(0);
      expect(mailer.sendMail).not.toHaveBeenCalled();
      await expect(approve(b, request.id, { now: at(20) })).resolves.toMatchObject({ status: 'approved' });
    });

    it('a database failure while verifying propagates instead of being reported as a refusal', async () => {
      const issued = await stepUp('approve', a, request.id);
      const boom = new Error('database down');
      jest.spyOn(fake.prisma.adminPasskey, 'findFirst').mockRejectedValue(boom);
      await expect(approveRecoveryRequest({ ...base(a, request.id), response: assertion(a, issued.options), now: at(5) })).rejects.toBe(boom);
      expect(approvalRows()).toHaveLength(0);
    });
  });
});

describe('rejection', () => {
  let target; let a; let b; let request;
  beforeEach(async () => {
    target = await targetAdmin();
    a = await approver('a@example.org');
    b = await approver('b@example.org');
    request = await openRequest();
  });

  it('one eligible rejection rejects the request, records who and why, and tells the target', async () => {
    const result = await reject(a, request.id, { reason: 'Not verified' });
    expect(result).toMatchObject({ decision: 'reject', status: 'rejected', invitation: null, emailDelivered: true });
    expect(request.status).toBe('rejected');
    expect(approvalRows()).toEqual([expect.objectContaining({ approverId: a.admin.id, decision: 'rejected', reason: 'Not verified', approverRole: 'superadmin' })]);
    expect(auditsOf('admin_recovery_rejected')[0]).toMatchObject({
      actorType: 'admin', actorId: a.admin.id, detail: { adminId: target.admin.id, recoveryRequestId: request.id, decision: 'rejected', decidedAt: at(5).toISOString() },
    });
    const [message] = mailer.sendMail.mock.calls[0];
    expect(message).toMatchObject({ to: TARGET_EMAIL, subject: expect.stringContaining('rejected') });
    expect(`${message.text}${message.html}`).not.toMatch(/https?:|token|#/i);
    expect(invitations()).toHaveLength(0);
  });

  it('rejects even after an approval', async () => {
    await approve(a, request.id);
    await expect(reject(b, request.id, { now: at(10) })).resolves.toMatchObject({ status: 'rejected' });
    expect(invitations()).toHaveLength(0);
  });

  it('after a rejection nobody can approve or reject, and no invitation can appear', async () => {
    const c = await approver('c@example.org');
    await reject(a, request.id);
    await refusedWith(stepUp('approve', b, request.id, { now: at(10) }), 'not_available');
    await refusedWith(stepUp('reject', c, request.id, { now: at(10) }), 'not_available');
    expect(request.status).toBe('rejected');
    expect(invitations()).toHaveLength(0);
  });

  it('a rejection issued before another approver finalised cannot undo the approval', async () => {
    const issued = await stepUp('reject', b, request.id);
    await approve(a, request.id, { now: at(6) });
    const c = await approver('c@example.org');
    await approve(c, request.id, { now: at(7) });
    expect(request.status).toBe('approved');
    await refusedWith(rejectRecoveryRequest({ ...base(b, request.id), response: assertion(b, issued.options), now: at(8) }), 'not_available');
    expect(request.status).toBe('approved');
  });

  it('the reason is optional but validated', async () => {
    await expect(reject(a, request.id, { reason: undefined })).resolves.toMatchObject({ status: 'rejected' });
    fake.reset();
    db.auditClock = NOW;
    await targetAdmin();
    const c = await approver('c@example.org');
    const second = await openRequest();
    const issued = await stepUp('reject', c, second.id);
    await expect(rejectRecoveryRequest({ ...base(c, second.id), response: assertion(c, issued.options), reason: 'bad\u0007', now: at(5) })).rejects.toMatchObject({ code: 'invalid_reason' });
    expect(second.status).toBe('pending');
  });

  it('a failed rejection email keeps the rejection and records only ids', async () => {
    mailer.sendMail.mockRejectedValue(new Error('SMTP down'));
    const result = await reject(a, request.id);
    expect(result).toMatchObject({ status: 'rejected', emailDelivered: false, emailError: 'SMTP down' });
    expect(request.status).toBe('rejected');
    expect(auditsOf('admin_recovery_notification_failed')[0].detail).toEqual({ adminId: target.admin.id, recoveryRequestId: request.id, kind: 'rejection' });
  });

  it('an audit failure leaves the request pending', async () => {
    const issued = await stepUp('reject', a, request.id);
    const response = assertion(a, issued.options);
    db.failAudit = true;
    await expect(rejectRecoveryRequest({ ...base(a, request.id), response, now: at(5) })).rejects.toThrow('audit write failed');
    db.failAudit = false;
    expect(request.status).toBe('pending');
    expect(approvalRows()).toHaveLength(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('the target cannot reject their own recovery', async () => {
    db.admins.find((x) => x.email === TARGET_EMAIL).role = 'superadmin';
    const targetRow = db.admins.find((x) => x.email === TARGET_EMAIL);
    await refusedWith(
      rejectRecoveryRequest({ requestId: request.id, approverId: targetRow.id, sessionId: target.sessionId, response: {}, now: at(5) }),
      'step_up_failed', // the response is checked first; with a real one it is refused as not_available (above)
    );
    expect(request.status).toBe('pending');
  });
});

// ---- 3. concurrency ------------------------------------------------------------------------

describe('concurrent decisions', () => {
  let a; let b; let c; let request;
  beforeEach(async () => {
    await targetAdmin();
    a = await approver('a@example.org');
    b = await approver('b@example.org');
    c = await approver('c@example.org');
    request = await openRequest();
  });

  // Step-ups done up front; only the decisions race.
  async function ready(kind, who) {
    const issued = await stepUp(kind, who, request.id);
    return { who, response: assertion(who, issued.options) };
  }
  const submit = (kind, { who, response }, now = at(5)) => (kind === 'approve' ? approveRecoveryRequest : rejectRecoveryRequest)({ ...base(who, request.id), response, now });

  it('two approvals at the same moment: both count, exactly one finalises, exactly one invitation', async () => {
    const [ra, rb] = await Promise.all([ready('approve', a), ready('approve', b)]);
    const results = await Promise.allSettled([submit('approve', ra), submit('approve', rb)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.map((r) => r.value.status).sort()).toEqual(['approved', 'pending']);
    expect(request.status).toBe('approved');
    expect(approvalRows()).toHaveLength(2);
    expect(invitations()).toHaveLength(1);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(auditsOf('admin_recovery_approved')).toHaveLength(1);
  });

  it('three approvals at once: one finalises, the late one is refused, still one invitation', async () => {
    const [ra, rb, rc] = await Promise.all([ready('approve', a), ready('approve', b), ready('approve', c)]);
    const results = await Promise.allSettled([submit('approve', ra), submit('approve', rb), submit('approve', rc)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.code).toBe('not_available');
    expect(request.status).toBe('approved');
    expect(approvalRows()).toHaveLength(2);
    expect(invitations()).toHaveLength(1);
  });

  it('an approval racing a rejection ends in exactly one terminal state', async () => {
    for (let round = 0; round < 6; round += 1) {
      fake.reset();
      db.auditClock = NOW;
      kit.setEnv();
      process.env.ADMIN_PORTAL_URL = PORTAL;
      await targetAdmin();
      [a, b, c] = [await approver('a@example.org'), await approver('b@example.org'), await approver('c@example.org')];
      request = await openRequest();
      await approve(c, request.id); // one approval already in place

      const [ra, rb] = await Promise.all([ready('approve', a), ready('reject', b)]);
      const jobs = [submit('approve', ra), submit('reject', rb)];
      if (round % 2) jobs.reverse();
      const results = await Promise.allSettled(jobs);

      expect(['approved', 'rejected']).toContain(request.status);
      if (request.status === 'approved') {
        expect(invitations()).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1); // the rejection came too late
      } else {
        expect(invitations()).toHaveLength(0);
      }
      expect(auditsOf('admin_recovery_approved').length + auditsOf('admin_recovery_rejected').length).toBe(1);
    }
  });

  it('two rejections at once: one rejects, the other is refused', async () => {
    const [ra, rb] = await Promise.all([ready('reject', a), ready('reject', b)]);
    const results = await Promise.allSettled([submit('reject', ra), submit('reject', rb)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('not_available');
    expect(request.status).toBe('rejected');
    expect(approvalRows()).toHaveLength(1);
  });

  it.each(['approval first', 'disable first'])('the final approval racing the disabling of the target (%s): the request ends cancelled with no live invitation', async (order) => {
    const [ra, rb] = await Promise.all([ready('approve', a), ready('approve', b)]);
    await submit('approve', ra);
    const disable = () => disableAdminAccount({ email: TARGET_EMAIL, reason: 'Left the company', now: at(10) });
    const jobs = order === 'approval first' ? [() => submit('approve', rb, at(10)), disable] : [disable, () => submit('approve', rb, at(10))];
    const results = await Promise.allSettled(jobs.map((job) => job()));
    const disabled = order === 'approval first' ? results[1] : results[0];
    const finalApproval = order === 'approval first' ? results[0] : results[1];

    expect(disabled.status).toBe('fulfilled');
    expect(request.status).toBe('cancelled');
    expect(invitations().filter((i) => !i.revokedAt && !i.usedAt)).toHaveLength(0);
    if (finalApproval.status === 'rejected') expect(finalApproval.reason.code).toBe('not_available');
  });

  it('the same response submitted twice at once is accepted once', async () => {
    const one = await ready('approve', a);
    const results = await Promise.allSettled([submit('approve', one), submit('approve', one)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['step_up_failed', 'already_decided']).toContain(results.find((r) => r.status === 'rejected').reason.code);
    expect(approvalRows()).toHaveLength(1);
  });

  it('a decision racing the disabling of an approver is either recorded before it, or refused after it', async () => {
    const [ra, rb] = await Promise.all([ready('approve', a), ready('approve', b)]);
    await submit('approve', ra);
    const results = await Promise.allSettled([
      submit('approve', rb, at(10)),
      fake.prisma.$transaction(async (tx) => {
        const held = await tx.adminUser.updateMany({ where: { id: a.admin.id }, data: { updatedAt: at(10) } });
        if (held.count === 1) await tx.adminUser.updateMany({ where: { id: a.admin.id }, data: { status: 'disabled' } });
      }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Whichever came first, an approval counts only if its approver was still an active superadmin
    // when the second one was recorded.
    const second = results[0].value;
    if (second.status === 'approved') {
      expect(a.admin.status).toBe('disabled'); // a was disabled only after b finalised
      expect(invitations()).toHaveLength(1);
    } else {
      expect(second.validApprovals).toBe(1);
      expect(invitations()).toHaveLength(0);
    }
  });
});
