// Real-MySQL concurrency validation of the Admin Lock recovery lifecycle (Step 7.9.10.2).
//
// NOT a Jest test and NOT picked up by `npm test` (no *.test.js name). Run by hand, from backend/:
//
//   node tests/real-mysql/admin-recovery-concurrency.real-mysql.js
//
// It uses the REAL services against the dedicated `humancare_test` MySQL database and nothing else:
//  - tests/setup.js loads ONLY backend/.env.test, blanks dev-only keys and runs the safety guard;
//  - the Prisma client refuses to be built for any other database (NODE_ENV=test guard) and this
//    script asks the server to confirm DATABASE() before and after;
//  - mail is replaced by an in-memory sink, so nothing is sent anywhere;
//  - global setup (the database wipe) is never run.
//
// Every trial builds its OWN isolated Admins (names/emails carry this run's id), races two service
// calls with Promise.all, reads back what was persisted, checks the invariants, then deletes ONLY
// the rows it created, by explicit id. No retry logic is involved: whatever the services return or
// throw is what is recorded.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.chdir(path.join(__dirname, '..', '..'));
require('../setup.js'); // .env.test only + guard (throws if the environment is not the test sandbox)

process.env.JWT_ACCESS_SECRET = 'test-access-secret-for-real-concurrency';
process.env.ADMIN_WEBAUTHN_RP_ID = 'localhost';
process.env.ADMIN_WEBAUTHN_ORIGIN = 'http://localhost:3000';
process.env.ADMIN_WEBAUTHN_RP_NAME = 'HumanCare World Wide Admin';
process.env.ADMIN_PORTAL_URL = 'https://admin.example.org';
delete process.env.ADMIN_PASSKEY_ENFORCEMENT;

// In-memory mail sink, installed BEFORE any service loads (they destructure sendMail at require time).
const sent = [];
const mailerPath = require.resolve('../../src/lib/mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendMail: async (message) => { sent.push(message); } },
};

const bcrypt = require('bcryptjs');
const guard = require('../../src/common/safety/test-database-guard');
const { prisma } = require('../../src/db/prisma');
const { makeRegistrationResponse, makeAssertionResponse } = require('../admin-webauthn-test-authenticator');
const { hashCredentialId } = require('../../src/modules/admin/auth/admin-webauthn.helpers');
const { createAdminSession } = require('../../src/modules/admin/auth/admin-session.service');
const { createRecoveryRequest } = require('../../src/modules/admin/auth/admin-recovery-request.service');
const { disableAdminAccount, enableAdminAccount } = require('../../src/modules/admin/auth/admin-account.service');
const { beginAdminPasskeyLogin, completeAdminPasskeyLogin } = require('../../src/modules/admin/auth/admin-login.service');
const { validateAdminSession, rotateAdminRefreshToken } = require('../../src/modules/admin/auth/admin-session.service');
const {
  issueRecoveryStepUp, approveRecoveryRequest, rejectRecoveryRequest, breakGlassRecovery, breakGlassConfirmation,
} = require('../../src/modules/admin/auth/admin-recovery-decision.service');
const { redeemRecoveryInvitation } = require('../../src/modules/admin/auth/admin-recovery-registration.service');

const RUN = `ccrun-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TRIALS = Number(process.env.CC_TRIALS || 30);
const ONLY = process.env.CC_ONLY ? process.env.CC_ONLY.split(',') : null;
const OUT = process.env.CC_OUT || null;
const PASSWORD = 'CcRunPass2027x';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const REASON = `${RUN} concurrency validation`;
// Start offsets (ms) of the two racing operations; cycled across trials so both start orders and
// several degrees of overlap are exercised.
const OFFSETS = [[0, 0], [0, 1], [1, 0], [0, 2], [2, 0], [0, 4], [4, 0], [0, 0], [0, 8], [8, 0]];

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : new Promise((r) => setImmediate(r)));

// ---- safety ----------------------------------------------------------------------------------

async function confirmDatabase() {
  return guard.verifyLiveDatabase(prisma);
}

// ---- fixtures --------------------------------------------------------------------------------

class Trial {
  constructor(scenario, n) {
    this.scenario = scenario;
    this.n = n;
    this.admins = new Map(); // id -> label
    this.emails = new Set();
  }

  label(id) { return this.admins.get(id) || `#${id}`; }

  async admin(label, { role = 'admin', passkey = false, session = false } = {}) {
    const email = `${RUN}-${this.scenario.toLowerCase()}-${this.n}-${label}@example.org`;
    const now = new Date();
    const row = await prisma.adminUser.create({
      data: {
        name: `CCRUN ${RUN} ${label}`, email, passwordHash: PASSWORD_HASH, role, status: 'active',
        emailVerifiedAt: now, passwordChangedAt: now,
      },
    });
    this.admins.set(row.id, label);
    this.emails.add(email);
    const who = { admin: row, counter: 1, sessionId: null, passkey: null };
    if (passkey) {
      const reg = makeRegistrationResponse({ challenge: crypto.randomBytes(32).toString('base64url'), key: 'es256', transports: ['internal'] });
      await prisma.adminPasskey.create({
        data: {
          adminId: row.id, credentialIdHash: hashCredentialId(reg.credentialId), credentialId: Buffer.from(reg.credentialId),
          publicKey: Buffer.from(reg.publicKey), signCount: 0, transports: ['internal'],
          aaguid: '00000000-0000-0000-0000-000000000000', deviceType: 'singleDevice', backedUp: false, label: 'Passkey',
        },
      });
      who.passkey = { reg };
    }
    if (session) {
      const s = await prisma.$transaction((tx) => createAdminSession(tx, { admin: row, now: new Date() }));
      who.sessionId = s.sessionId;
    }
    return who;
  }
}

async function openPendingRequest(target) {
  const created = await createRecoveryRequest({ email: target.admin.email, reason: REASON, now: new Date() });
  sent.length = 0;
  return created.request.id;
}

async function prepare(kind, who, requestId) {
  const issued = await issueRecoveryStepUp({ kind, requestId, approverId: who.admin.id, sessionId: who.sessionId, now: new Date() });
  const response = makeAssertionResponse({ challenge: issued.options.challenge, registered: who.passkey.reg, counter: who.counter });
  who.counter += 1;
  return response;
}

const decideWith = (kind, who, requestId, response) => (kind === 'approve' ? approveRecoveryRequest : rejectRecoveryRequest)({
  requestId, approverId: who.admin.id, sessionId: who.sessionId, response, now: new Date(),
});

// ---- racing and recording --------------------------------------------------------------------

function classify(err) {
  const text = String(err && err.message || '');
  const mysql = (text.match(/\b(1213|1205)\b/) || [])[0] || null;
  return {
    name: err && err.name,
    code: (err && err.code) || null,
    mysql,
    deadlockText: /deadlock/i.test(text),
    lockTimeoutText: /lock wait timeout/i.test(text),
    message: (() => { const t = text.replace(/\s+/g, ' '); return t.length > 260 ? `${t.slice(0, 90)} ... ${t.slice(-160)}` : t; })(),
    meta: err && err.meta ? JSON.stringify(err.meta).slice(0, 200) : null,
  };
}

function summarize(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const k of ['status', 'validApprovals', 'decision']) if (value[k] !== undefined) out[k] = value[k];
  if (value.request && value.request.status) out.requestStatus = value.request.status;
  if (value.invitation !== undefined) out.invitation = Boolean(value.invitation);
  if (value.admin && value.admin.status) out.adminStatus = value.admin.status;
  if (value.cancelledRecoveryRequests !== undefined) out.cancelledRecoveryRequests = value.cancelledRecoveryRequests;
  if (value.revokedRecoveryInvitations !== undefined) out.revokedRecoveryInvitations = value.revokedRecoveryInvitations;
  return out;
}

async function race(ops, offsets) {
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(ops.map(async ([name, fn], i) => {
    await sleep(offsets[i]);
    const started = process.hrtime.bigint();
    try {
      const value = await fn();
      return { name, ok: true, value: summarize(value), raw: value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    } catch (err) {
      return { name, ok: false, error: classify(err), ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }
  }));
  return { results, totalMs: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// ---- reading back what was persisted ---------------------------------------------------------

async function snapshot(trial, eventBaseline) {
  const ids = [...trial.admins.keys()];
  const now = new Date();
  const admins = await prisma.adminUser.findMany({ where: { id: { in: ids } } });
  const requests = await prisma.adminRecoveryRequest.findMany({ where: { adminId: { in: ids } }, orderBy: { id: 'asc' } });
  const reqIds = requests.map((r) => r.id);
  const approvals = await prisma.adminRecoveryApproval.findMany({ where: { requestId: { in: reqIds } }, orderBy: { id: 'asc' } });
  const invitations = await prisma.adminInvitation.findMany({ where: { adminId: { in: ids } }, orderBy: { id: 'asc' } });
  const sessions = await prisma.adminSession.findMany({ where: { adminId: { in: ids } } });
  const events = await attributedEvents(trial, eventBaseline);
  const byName = {};
  for (const e of events.mine) byName[e.event] = (byName[e.event] || 0) + 1;
  return {
    admins: Object.fromEntries(admins.map((a) => [trial.label(a.id), { status: a.status }])),
    requests: requests.map((r) => ({ id: r.id, adminLabel: trial.label(r.adminId), status: r.status, via: r.requestedVia, approvalsRequired: r.approvalsRequired })),
    approvals: approvals.map((a) => ({ requestId: a.requestId, by: trial.label(a.approverId), decision: a.decision })),
    invitations: invitations.map((i) => ({
      id: i.id, requestId: i.recoveryRequestId, purpose: i.purpose,
      live: !i.usedAt && !i.revokedAt && i.expiresAt > now, used: Boolean(i.usedAt), revoked: Boolean(i.revokedAt),
    })),
    liveSessions: sessions.filter((s) => !s.revokedAt).length,
    events: byName,
    eventIds: events.mine.map((e) => e.id),
    unattributedEventIds: events.other.map((e) => e.id),
  };
}

async function attributedEvents(trial, baseline) {
  const ids = new Set(trial.admins.keys());
  const rows = await prisma.securityEvent.findMany({ where: { id: { gt: baseline } }, orderBy: { id: 'asc' } });
  const mine = [];
  const other = [];
  for (const e of rows) {
    const d = e.detail && typeof e.detail === 'object' ? e.detail : {};
    const hit = (e.actorId && ids.has(e.actorId)) || ids.has(d.adminId) || (e.identifier && trial.emails.has(e.identifier));
    (hit ? mine : other).push(e);
  }
  return { mine, other };
}

async function cleanup(trial, eventBaseline) {
  const ids = [...trial.admins.keys()];
  if (ids.length === 0) return { deleted: 0, leftovers: 0 };
  const reqIds = (await prisma.adminRecoveryRequest.findMany({ where: { adminId: { in: ids } }, select: { id: true } })).map((r) => r.id);
  const sessionIds = (await prisma.adminSession.findMany({ where: { adminId: { in: ids } }, select: { id: true } })).map((s) => s.id);
  const ev = await attributedEvents(trial, eventBaseline);
  await prisma.adminWebAuthnChallenge.deleteMany({ where: { adminId: { in: ids } } });
  await prisma.adminRecoveryApproval.deleteMany({ where: { OR: [{ requestId: { in: reqIds } }, { approverId: { in: ids } }] } });
  await prisma.adminInvitation.deleteMany({ where: { adminId: { in: ids } } });
  await prisma.adminRecoveryRequest.deleteMany({ where: { id: { in: reqIds } } });
  await prisma.adminRefreshToken.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await prisma.adminSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.adminPasskey.deleteMany({ where: { adminId: { in: ids } } });
  if (ev.mine.length) await prisma.securityEvent.deleteMany({ where: { id: { in: ev.mine.map((e) => e.id) } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
  const leftovers = (await prisma.adminUser.count({ where: { id: { in: ids } } }))
    + (await prisma.adminRecoveryRequest.count({ where: { adminId: { in: ids } } }))
    + (await prisma.adminInvitation.count({ where: { adminId: { in: ids } } }))
    + (await prisma.adminPasskey.count({ where: { adminId: { in: ids } } }))
    + (await prisma.adminSession.count({ where: { adminId: { in: ids } } }));
  return { deleted: ids.length, leftovers, unattributedEvents: ev.other.length };
}

// ---- invariants ------------------------------------------------------------------------------
// Each check returns the list of ways the PERSISTED state disagrees with itself or with what the
// calls reported. An empty list = consistent, whichever side won or failed.

const openReq = (s) => s.requests.filter((r) => r.status === 'pending' || r.status === 'approved');
const liveInv = (s) => s.invitations.filter((i) => i.live && i.purpose === 'passkey_recovery');
const okCount = (results) => results.filter((r) => r.ok).length;

function checkCreateRace(s, results) {
  const v = [];
  if (s.requests.length !== okCount(results)) v.push(`requests committed (${s.requests.length}) != successful calls (${okCount(results)})`);
  if (openReq(s).length > 1) v.push(`${openReq(s).length} open requests`);
  if ((s.events.admin_recovery_requested || 0) !== s.requests.length) v.push(`requested events (${s.events.admin_recovery_requested || 0}) != requests (${s.requests.length})`);
  if (sent.filter((m) => /passkey recovery was requested/i.test(m.subject || '')).length !== okCount(results)) v.push('notification count != successful calls');
  return v;
}

function checkDecisionState(s, results, committedBeforeRace = 0) {
  const v = [];
  const req = s.requests[0];
  const approved = s.approvals.filter((a) => a.decision === 'approved');
  const rejected = s.approvals.filter((a) => a.decision === 'rejected');
  if (s.requests.length !== 1) v.push(`expected exactly 1 request, found ${s.requests.length}`);
  if (!req) return v;
  if (new Set(s.approvals.map((a) => a.by)).size !== s.approvals.length) v.push('duplicate approver rows');
  if (req.status === 'approved') {
    if (approved.length !== 2) v.push(`approved with ${approved.length} approvals`);
    if (rejected.length) v.push('approved request carries a rejection row (mixed terminal state)');
    if (liveInv(s).length !== 1) v.push(`approved request has ${liveInv(s).length} live invitations (expected 1)`);
  } else {
    if (s.invitations.length) v.push(`request is ${req.status} but ${s.invitations.length} invitation(s) exist`);
    if (req.status === 'rejected' && rejected.length !== 1) v.push(`rejected with ${rejected.length} rejection rows`);
    if (req.status === 'pending' && rejected.length) v.push('pending request carries a rejection row');
  }
  if (s.invitations.length > 1) v.push(`${s.invitations.length} invitations issued`);
  const ev = (n) => s.events[n] || 0;
  if (ev('admin_recovery_approval_recorded') !== approved.length) v.push(`approval_recorded events (${ev('admin_recovery_approval_recorded')}) != approved rows (${approved.length})`);
  if (ev('admin_recovery_approved') !== (req.status === 'approved' ? 1 : 0)) v.push(`approved events (${ev('admin_recovery_approved')}) mismatch status ${req.status}`);
  if (ev('admin_recovery_rejected') !== (req.status === 'rejected' ? 1 : 0)) v.push(`rejected events (${ev('admin_recovery_rejected')}) mismatch status ${req.status}`);
  if (ev('admin_recovery_invitation_created') !== s.invitations.length) v.push(`invitation_created events (${ev('admin_recovery_invitation_created')}) != invitations (${s.invitations.length})`);
  const reportedOk = results.filter((r) => r.ok).length;
  if (reportedOk + committedBeforeRace !== s.approvals.length) v.push(`successful calls (${reportedOk}) + committed before the race (${committedBeforeRace}) != decision rows (${s.approvals.length})`);
  return v;
}

function checkDisableRace(s, results, { disableName, expectNoOpenRequestBefore }) {
  const v = [];
  const disabled = results.find((r) => r.name === disableName);
  if (disabled.ok && s.admins.target.status !== 'disabled') v.push('disable reported success but target is not disabled');
  if (!disabled.ok && s.admins.target.status === 'disabled') v.push('disable reported failure but target is disabled');
  if (s.admins.target.status === 'disabled') {
    if (openReq(s).length) v.push(`${openReq(s).length} open request(s) survive for the disabled Admin`);
    if (liveInv(s).length) v.push(`${liveInv(s).length} live recovery invitation(s) survive for the disabled Admin`);
  }
  const cancelledRows = s.requests.filter((r) => r.status === 'cancelled').length;
  if ((s.events.admin_recovery_cancelled || 0) !== cancelledRows) v.push(`cancelled events (${s.events.admin_recovery_cancelled || 0}) != cancelled requests (${cancelledRows})`);
  const created = (s.events.admin_recovery_requested || 0) + (s.events.admin_recovery_break_glass || 0);
  if (created !== s.requests.length) v.push(`request-creation events (${created}) != requests (${s.requests.length})`);
  if ((s.events.admin_account_disabled || 0) !== (s.admins.target.status === 'disabled' ? 1 : 0)) v.push('disabled event count mismatch');
  if (s.invitations.length !== (s.events.admin_recovery_invitation_created || 0)) v.push(`invitations (${s.invitations.length}) != invitation_created events (${s.events.admin_recovery_invitation_created || 0})`);
  void expectNoOpenRequestBefore;
  return v;
}

// ---- scenarios -------------------------------------------------------------------------------

const SCENARIOS = {
  // A: two operators open a recovery request for the same Admin.
  async A(t, off) {
    const target = await t.admin('target');
    const race1 = await race([
      ['create1', () => createRecoveryRequest({ email: target.admin.email, reason: REASON, now: new Date() })],
      ['create2', () => createRecoveryRequest({ email: target.admin.email, reason: REASON, now: new Date() })],
    ], off);
    return { race: race1, check: checkCreateRace };
  },

  // B: the two approvals of one request arrive together.
  async B(t, off) {
    const target = await t.admin('target');
    const s1 = await t.admin('s1', { role: 'superadmin', passkey: true, session: true });
    const s2 = await t.admin('s2', { role: 'superadmin', passkey: true, session: true });
    const requestId = await openPendingRequest(target);
    const r1 = await prepare('approve', s1, requestId);
    const r2 = await prepare('approve', s2, requestId);
    const race1 = await race([
      ['approve-s1', () => decideWith('approve', s1, requestId, r1)],
      ['approve-s2', () => decideWith('approve', s2, requestId, r2)],
    ], off);
    return {
      race: race1,
      check(s, results) {
        const v = checkDecisionState(s, results);
        const req = s.requests[0];
        if (req && okCount(results) === 2 && results.filter((r) => r.value && r.value.status === 'approved').length !== 1) v.push('both calls succeeded but not exactly one reported "approved"');
        if (req && okCount(results) === 2 && req.status !== 'approved') v.push('two successful approvals but request not approved');
        return v;
      },
    };
  },

  // C1: S1 already approved; S2 approves while S3 rejects.   C2: nobody has decided yet.
  async C1(t, off) { return decisionVsRejection(t, off, true); },
  async C2(t, off) { return decisionVsRejection(t, off, false); },

  // D1: disable vs create, no open request beforehand.   D2: an open request already exists.
  async D1(t, off) { return disableVsCreate(t, off, false); },
  async D2(t, off) { return disableVsCreate(t, off, true); },

  // E1: disable vs break-glass, no open request.   E2: an open request already exists (break-glass
  // is then refused whichever way it goes, but the lock ordering is the same).
  async E1(t, off) { return disableVsBreakGlass(t, off, false); },
  async E2(t, off) { return disableVsBreakGlass(t, off, true); },

  // F (supplementary): a first approval races a competing request creation for the same target.
  async F(t, off) {
    const target = await t.admin('target');
    const s1 = await t.admin('s1', { role: 'superadmin', passkey: true, session: true });
    const requestId = await openPendingRequest(target);
    const r1 = await prepare('approve', s1, requestId);
    const race1 = await race([
      ['approve-s1', () => decideWith('approve', s1, requestId, r1)],
      ['create', () => createRecoveryRequest({ email: target.admin.email, reason: REASON, now: new Date() })],
    ], off);
    return {
      race: race1,
      check(s, results) {
        const v = [];
        if (s.requests.length !== 1) v.push(`expected 1 request, found ${s.requests.length}`);
        if (results.find((x) => x.name === 'create').ok) v.push('a second request was created while one was open');
        if (s.approvals.length !== (results.find((x) => x.name === 'approve-s1').ok ? 1 : 0)) v.push('approval rows disagree with the reported outcome');
        if ((s.events.admin_recovery_requested || 0) !== s.requests.length) v.push('requested events != requests');
        return v;
      },
    };
  },

  // L (supplementary): Admin disable vs a concurrent sign-in of the same Admin. A session the sign-in
  // commits while the disable waits for the Admin lock must still be revoked by the disable, so that
  // nothing made during the race becomes usable again when the Admin is re-enabled.
  async L(t, off) {
    const target = await t.admin('target', { passkey: true });
    const { loginTicket, options } = await beginAdminPasskeyLogin({ email: target.admin.email, password: PASSWORD, ipAddress: '203.0.113.9', now: new Date() });
    const response = makeAssertionResponse({ challenge: options.challenge, registered: target.passkey.reg, counter: 1 });
    const race1 = await race([
      ['login', () => completeAdminPasskeyLogin({ loginTicket, response, now: new Date(), ipAddress: '203.0.113.9', userAgent: 'ccrun' })],
      ['disable', () => disableAdminAccount({ email: target.admin.email, reason: REASON, now: new Date() })],
    ], off);

    // State right after the race, before the Admin is re-enabled.
    const sessions = await prisma.adminSession.findMany({ where: { adminId: target.admin.id } });
    const tokens = await prisma.adminRefreshToken.findMany({ where: { sessionId: { in: sessions.map((x) => x.id) } } });
    const afterRace = {
      status: (await prisma.adminUser.findUnique({ where: { id: target.admin.id } })).status,
      sessions: sessions.length,
      unrevokedSessions: sessions.filter((x) => !x.revokedAt).length,
      unrevokedTokens: tokens.filter((x) => !x.revokedAt).length,
    };

    // Re-enable, then try to use everything the race produced.
    const loginResult = race1.results.find((x) => x.name === 'login');
    let enabled = null;
    try { enabled = (await enableAdminAccount({ email: target.admin.email, now: new Date() })).admin.status; } catch (err) { enabled = `error:${err.code || err.name}`; }
    const usable = { sessions: 0, refresh: 0 };
    for (const x of sessions) {
      if (await validateAdminSession({ sessionId: x.id, adminId: target.admin.id, now: new Date() })) usable.sessions += 1;
    }
    if (loginResult.ok && loginResult.raw && loginResult.raw.refreshToken) {
      try { await rotateAdminRefreshToken({ refreshToken: loginResult.raw.refreshToken, now: new Date() }); usable.refresh += 1; } catch { /* refused: expected */ }
    }
    return {
      race: race1,
      extra: { redeem: `sessions=${afterRace.sessions}` },
      check(s, results) {
        const v = [];
        const login = results.find((x) => x.name === 'login');
        const disable = results.find((x) => x.name === 'disable');
        if (!disable.ok) v.push('disable did not succeed');
        if (afterRace.status !== 'disabled') v.push('Admin is not disabled after the race');
        if (afterRace.unrevokedSessions) v.push(`${afterRace.unrevokedSessions} session(s) left unrevoked after disable`);
        if (afterRace.unrevokedTokens) v.push(`${afterRace.unrevokedTokens} refresh token(s) left unrevoked after disable`);
        if (login.ok && afterRace.sessions !== 1) v.push('login succeeded but its session is not persisted');
        if (!login.ok && afterRace.sessions !== 0) v.push('login failed but a session exists');
        if (enabled !== 'active') v.push(`re-enable gave ${enabled}`);
        if (usable.sessions) v.push(`${usable.sessions} session(s) usable after re-enable`);
        if (usable.refresh) v.push('a refresh token rotated after re-enable');
        if ((s.events.admin_account_disabled || 0) !== 1) v.push('disabled event count mismatch');
        return v;
      },
    };
  },

  // G (supplementary): a rejection races a break-glass for the same target (lock order: request->Admin vs Admin->request).
  async G(t, off) {
    const target = await t.admin('target');
    const s1 = await t.admin('s1', { role: 'superadmin', passkey: true, session: true });
    const requestId = await openPendingRequest(target);
    const r1 = await prepare('reject', s1, requestId);
    const race1 = await race([
      ['reject-s1', () => decideWith('reject', s1, requestId, r1)],
      ['break-glass', () => breakGlassRecovery({ email: target.admin.email, reason: `${REASON} break-glass`, confirmation: breakGlassConfirmation(target.admin.email), now: new Date() })],
    ], off);
    return {
      race: race1,
      check(s, results) {
        const v = [];
        const rej = results.find((x) => x.name === 'reject-s1');
        const bg = results.find((x) => x.name === 'break-glass');
        // Break-glass may legitimately succeed AFTER the rejection committed (the request is closed then);
        // it must never succeed while the request is still open, and never leave two open requests.
        if (bg.ok && !(rej.ok && s.requests[0] && s.requests[0].status === 'rejected')) v.push('break-glass succeeded without the first request being closed');
        if (bg.ok && s.requests.length !== 2) v.push('break-glass committed but the request set is not [rejected, break_glass]');
        if (!bg.ok && s.requests.length !== 1) v.push('break-glass failed but a second request exists');
        if (openReq(s).length > 1) v.push('more than one open request');
        if (rej.ok && s.requests[0] && s.requests[0].status !== 'rejected') v.push('rejection reported but request not rejected');
        if (!rej.ok && s.requests[0] && s.requests[0].status !== 'pending') v.push('rejection failed but request changed');
        if (liveInv(s).length !== (bg.ok ? 1 : 0)) v.push('live invitation count does not match break-glass outcome');
        if ((s.events.admin_recovery_break_glass || 0) !== (bg.ok ? 1 : 0)) v.push('break-glass event count mismatch');
        if ((s.events.admin_recovery_rejected || 0) !== (rej.ok ? 1 : 0)) v.push('rejected event count mismatch');
        return v;
      },
    };
  },
};

async function decisionVsRejection(t, off, priorApproval) {
  const target = await t.admin('target');
  const s1 = await t.admin('s1', { role: 'superadmin', passkey: true, session: true });
  const s2 = await t.admin('s2', { role: 'superadmin', passkey: true, session: true });
  const s3 = await t.admin('s3', { role: 'superadmin', passkey: true, session: true });
  const requestId = await openPendingRequest(target);
  if (priorApproval) {
    await decideWith('approve', s1, requestId, await prepare('approve', s1, requestId));
    sent.length = 0;
  }
  const approver = priorApproval ? s2 : s1;
  const rejecter = priorApproval ? s3 : s2;
  const ra = await prepare('approve', approver, requestId);
  const rr = await prepare('reject', rejecter, requestId);
  const race1 = await race([
    ['approve', () => decideWith('approve', approver, requestId, ra)],
    ['reject', () => decideWith('reject', rejecter, requestId, rr)],
  ], off);
  return {
    race: race1,
    check(s, results) {
      // The prior approval (C1) was committed before the race, so it counts in the row totals.
      const baseline = priorApproval ? 1 : 0;
      const v = checkDecisionState(s, results, baseline);
      if (s.requests[0] && !['approved', 'rejected'].includes(s.requests[0].status) && okCount(results) > 0 && baseline + okCount(results) >= 2) {
        // not necessarily wrong (approve then reject always ends rejected), flagged only if inconsistent above
      }
      if (okCount(results) === 2 && priorApproval) v.push('both the approval and the rejection reported success');
      return v;
    },
  };
}

async function disableVsCreate(t, off, existingRequest) {
  const target = await t.admin('target', { passkey: true, session: true });
  if (existingRequest) await openPendingRequest(target);
  const race1 = await race([
    ['disable', () => disableAdminAccount({ email: target.admin.email, reason: REASON, now: new Date() })],
    ['create', () => createRecoveryRequest({ email: target.admin.email, reason: REASON, now: new Date() })],
  ], off);
  return { race: race1, check: (s, results) => checkDisableRace(s, results, { disableName: 'disable' }) };
}

async function disableVsBreakGlass(t, off, existingRequest) {
  const target = await t.admin('target', { passkey: true, session: true });
  await t.admin('s1', { role: 'superadmin', passkey: true, session: true }); // 1 eligible approver (< 2): break-glass is allowed
  if (existingRequest) await openPendingRequest(target);
  const race1 = await race([
    ['disable', () => disableAdminAccount({ email: target.admin.email, reason: REASON, now: new Date() })],
    ['break-glass', () => breakGlassRecovery({ email: target.admin.email, reason: `${REASON} break-glass`, confirmation: breakGlassConfirmation(target.admin.email), now: new Date() })],
  ], off);
  // Can a disabled Admin still use whatever invitation was issued? Try the link from the mail sink.
  let redeem = null;
  const bgMail = sent.find((m) => /recover/i.test(m.subject || '') && /[A-Za-z0-9_-]{43}/.test(m.text || ''));
  if (bgMail) {
    const token = (bgMail.text.match(/[A-Za-z0-9_-]{43}/) || [])[0];
    try {
      await redeemRecoveryInvitation({ token, password: PASSWORD, now: new Date() });
      redeem = 'REDEEMED';
    } catch (err) {
      redeem = `refused:${err && (err.code || err.name)}`;
    }
  }
  return {
    race: race1,
    extra: { redeem },
    check(s, results) {
      const v = checkDisableRace(s, results, { disableName: 'disable' });
      if (redeem === 'REDEEMED' && s.admins.target.status === 'disabled') v.push('the disabled Admin redeemed a recovery invitation');
      if (existingRequest && results.find((x) => x.name === 'break-glass').ok) v.push('break-glass succeeded while a request was open');
      return v;
    },
  };
}

// ---- server counters -------------------------------------------------------------------------

async function lockStatus() {
  const rows = await prisma.$queryRawUnsafe("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits','Innodb_row_lock_time','Innodb_row_lock_time_max','Innodb_row_lock_current_waits')");
  return Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
}

async function deadlockCounter() {
  try {
    const rows = await prisma.$queryRawUnsafe("SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'");
    return rows.length ? Number(rows[0].COUNT) : null;
  } catch {
    return null; // needs PROCESS; the test account does not have it
  }
}

// ---- main ------------------------------------------------------------------------------------

async function main() {
  const live = await confirmDatabase();
  const [{ v: version, iso, t: lockWait, d: deadlockDetect }] = await prisma.$queryRawUnsafe('SELECT VERSION() v, @@transaction_isolation iso, @@innodb_lock_wait_timeout t, @@innodb_deadlock_detect d');
  const server = { version, isolation: iso, lockWaitTimeoutSeconds: Number(lockWait), deadlockDetect: Number(deadlockDetect), database: live.database, account: live.account };

  // Refuse to start on a database with recovery data we did not create.
  const preCounts = {};
  for (const [name, model] of [['admin_users', prisma.adminUser], ['admin_recovery_requests', prisma.adminRecoveryRequest], ['admin_recovery_approvals', prisma.adminRecoveryApproval], ['admin_invitations', prisma.adminInvitation], ['admin_sessions', prisma.adminSession], ['admin_passkeys', prisma.adminPasskey], ['admin_webauthn_challenges', prisma.adminWebAuthnChallenge], ['security_events', prisma.securityEvent]]) {
    preCounts[name] = await model.count();
  }
  if (preCounts.admin_recovery_requests || preCounts.admin_invitations || preCounts.admin_recovery_approvals) {
    throw new Error('The test database already holds recovery requests/invitations/approvals that this run did not create; refusing to race on top of them.');
  }
  const preAdmins = await prisma.adminUser.findMany({ orderBy: { id: 'asc' } });
  const preAdminJson = new Map(preAdmins.map((a) => [a.id, JSON.stringify(a)]));
  const preAdminRows = new Map(preAdmins.map((a) => [a.id, a]));
  const maxEvent = (await prisma.securityEvent.aggregate({ _max: { id: true } }))._max.id || 0;
  const deadlocksBefore = await deadlockCounter();
  console.log(`RUN ${RUN}: ${live.database} as ${live.account}, MySQL ${version}, ${iso}, lock wait ${lockWait}s, deadlock detect ${deadlockDetect}, ${TRIALS} trials/scenario`);

  const report = { run: RUN, server, preCounts, trialsPerScenario: TRIALS, scenarios: {} };
  const allAdminIds = [];

  for (const [name, fn] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    const before = await lockStatus();
    const agg = {
      trials: 0, inconsistent: 0, deadlock: 0, p2034: 0, lockTimeout: 0, txTimeoutP2028: 0, otherTxError: 0,
      outcomes: {}, finalStates: {}, errorSamples: {}, violations: {}, setupFailures: 0, cleanupLeftovers: 0, unattributedEvents: 0, redeem: {},
      maxMs: 0,
    };
    for (let n = 0; n < TRIALS; n += 1) {
      const trial = new Trial(name, n);
      const eventBaseline = (await prisma.securityEvent.aggregate({ _max: { id: true } }))._max.id || 0;
      sent.length = 0;
      let ran;
      try {
        ran = await fn(trial, OFFSETS[n % OFFSETS.length]);
      } catch (err) {
        agg.setupFailures += 1;
        agg.errorSamples[`setup:${classify(err).message.slice(0, 120)}`] = 1;
        allAdminIds.push(...trial.admins.keys());
        const c = await cleanup(trial, eventBaseline);
        agg.cleanupLeftovers += c.leftovers;
        continue;
      }
      agg.trials += 1;
      const { results } = ran.race;
      agg.maxMs = Math.max(agg.maxMs, ...results.map((r) => r.ms));
      let snap;
      try {
        snap = await snapshot(trial, eventBaseline);
        const violations = ran.check(snap, results);
        if (violations.length) {
          agg.inconsistent += 1;
          for (const x of violations) agg.violations[x] = (agg.violations[x] || 0) + 1;
        }
        if (ran.extra && ran.extra.redeem) agg.redeem[ran.extra.redeem] = (agg.redeem[ran.extra.redeem] || 0) + 1;
        for (const r of results) {
          if (r.ok) continue;
          const e = r.error;
          const isDeadlock = e.mysql === '1213' || e.deadlockText;
          const isTimeout = e.mysql === '1205' || e.lockTimeoutText;
          if (isDeadlock) agg.deadlock += 1;
          if (isTimeout) agg.lockTimeout += 1;
          if (e.code === 'P2034') agg.p2034 += 1;
          if (e.code === 'P2028') agg.txTimeoutP2028 += 1;
          if (!isDeadlock && !isTimeout && e.name !== 'ProvisioningError' && e.name !== 'RecoveryDecisionError') agg.otherTxError += 1;
          const key = `${e.name}/${e.code || '-'}/${e.mysql || '-'}: ${e.message.length > 120 ? e.message.slice(-120) : e.message}${e.meta ? ` meta=${e.meta}` : ''}`;
          agg.errorSamples[key] = (agg.errorSamples[key] || 0) + 1;
        }
        const sig = results.map((r) => `${r.name}=${r.ok ? `ok${r.value && r.value.status ? `(${r.value.status})` : r.value && r.value.requestStatus ? `(${r.value.requestStatus})` : ''}` : `${r.error.name === 'ProvisioningError' || r.error.name === 'RecoveryDecisionError' ? r.error.code : `${r.error.code || r.error.name}${r.error.mysql ? `/${r.error.mysql}` : ''}`}`}`).join(' | ');
        agg.outcomes[sig] = (agg.outcomes[sig] || 0) + 1;
        const fin = JSON.stringify({
          target: snap.admins.target && snap.admins.target.status,
          req: snap.requests.map((r) => `${r.via}:${r.status}`),
          appr: snap.approvals.map((a) => `${a.by}:${a.decision}`),
          inv: snap.invitations.map((i) => (i.live ? 'live' : i.revoked ? 'revoked' : i.used ? 'used' : 'expired')),
        });
        agg.finalStates[fin] = (agg.finalStates[fin] || 0) + 1;
      } finally {
        allAdminIds.push(...trial.admins.keys());
        const c = await cleanup(trial, eventBaseline);
        agg.cleanupLeftovers += c.leftovers;
        agg.unattributedEvents += c.unattributedEvents || 0;
      }
    }
    const after = await lockStatus();
    agg.serverLockDelta = {
      rowLockWaits: after.Innodb_row_lock_waits - before.Innodb_row_lock_waits,
      rowLockTimeMsTotal: after.Innodb_row_lock_time - before.Innodb_row_lock_time,
      rowLockTimeMaxMs: after.Innodb_row_lock_time_max,
    };
    report.scenarios[name] = agg;
    console.log(`${name}: trials=${agg.trials} inconsistent=${agg.inconsistent} deadlock=${agg.deadlock} P2034=${agg.p2034} lockTimeout=${agg.lockTimeout} P2028=${agg.txTimeoutP2028} otherErr=${agg.otherTxError} unattributedEvents=${agg.unattributedEvents} leftovers=${agg.cleanupLeftovers} lockWaits=${agg.serverLockDelta.rowLockWaits}`);
  }

  // ---- final verification ----
  const deadlocksAfter = await deadlockCounter();
  report.innodbDeadlocksCounter = { before: deadlocksBefore, after: deadlocksAfter };
  const postCounts = {};
  for (const [name, model] of [['admin_users', prisma.adminUser], ['admin_recovery_requests', prisma.adminRecoveryRequest], ['admin_recovery_approvals', prisma.adminRecoveryApproval], ['admin_invitations', prisma.adminInvitation], ['admin_sessions', prisma.adminSession], ['admin_passkeys', prisma.adminPasskey], ['admin_webauthn_challenges', prisma.adminWebAuthnChallenge], ['security_events', prisma.securityEvent]]) {
    postCounts[name] = await model.count();
  }
  report.postCounts = postCounts;
  report.countsMatchBaseline = JSON.stringify(preCounts) === JSON.stringify(postCounts);
  report.runAdminsRemaining = await prisma.adminUser.count({ where: { id: { in: allAdminIds } } });
  report.runAdminsCreated = allAdminIds.length;
  report.runNamedAdminsRemaining = await prisma.adminUser.count({ where: { email: { contains: RUN } } });
  report.eventsAboveBaselineRemaining = await prisma.securityEvent.count({ where: { id: { gt: maxEvent } } });

  const postAdmins = await prisma.adminUser.findMany({ where: { id: { in: [...preAdminRows.keys()] } }, orderBy: { id: 'asc' } });
  const changed = [];
  for (const a of postAdmins) {
    if (JSON.stringify(a) === preAdminJson.get(a.id)) continue;
    const old = preAdminRows.get(a.id);
    changed.push({ id: a.id, columns: Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(old[k])) });
  }
  report.preexistingAdmins = { count: preAdmins.length, missing: preAdmins.length - postAdmins.length, changed };
  report.finalDatabase = await confirmDatabase();
  console.log(JSON.stringify({
    countsMatchBaseline: report.countsMatchBaseline, runAdminsCreated: report.runAdminsCreated, runAdminsRemaining: report.runAdminsRemaining,
    runNamedAdminsRemaining: report.runNamedAdminsRemaining, eventsAboveBaselineRemaining: report.eventsAboveBaselineRemaining,
    preexistingAdmins: report.preexistingAdmins, innodbDeadlocksCounter: report.innodbDeadlocksCounter, finalDatabase: report.finalDatabase,
  }, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}

main()
  .catch((err) => { console.error(`HARNESS ABORTED: ${err.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
