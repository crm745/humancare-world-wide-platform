// Per-device sessions for patients and corporate users (table auth_sessions, model AuthSession). Admins have their own (AdminSession) and are not touched here.
//
// WHAT A SESSION IS. One row per signed-in device. Its id is the `sid` claim of every access and refresh token issued for it. The row, not the token, decides whether the device is still signed in:
//   revoked     the device signed out, another device ended it, a password was reset, the account was retired, or a refresh token was REUSED (theft signal)
//   idle        no authenticated request for IDLE_MS (30 minutes): enforced here, on every request, whatever the app does
//   expired     older than SESSION_LIFETIME_MS (7 days): the refresh policy. A refresh token's own expiry is set to the session's, so a refresh token never outlives it
// REFRESH ROTATION. Each refresh issues a new refresh token (a new random id, `jti`). Only SHA-256 hashes of the CURRENT and the PREVIOUS jti are stored. A token that matches the current one is used;
// the previous one is also accepted for ROTATION_GRACE_MS (a refresh whose answer was lost on a bad connection must not log the person out); any other token is a replay of an old one: the whole session
// is revoked. Rotation is a conditional update, so two refreshes with the same token cannot both win.
// LEGACY TOKENS. Tokens issued before this existed carry no `sid`. Their refresh token is exchanged ONCE for a session (the old checks still apply, tokenVersion included); their access token is refused
// in production (see legacyAccessTokensAllowed) and lives at most 15 minutes anyway.
const crypto = require('crypto');
const { prisma } = require('../../db/prisma');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IDLE_MS = 30 * MINUTE_MS; // the server-enforced idle timeout
const SESSION_LIFETIME_MS = 7 * DAY_MS; // the refresh-token policy: a session, and so its refresh tokens, end 7 days after sign-in
const ACTIVITY_WRITE_MS = MINUTE_MS; // lastActivityAt is written at most once a minute per session
const ROTATION_GRACE_MS = MINUTE_MS; // the previous refresh token still works this long after it was rotated (a lost answer)
const USER_AGENT_MAX = 255;

const SUBJECTS = Object.freeze({ PATIENT: 'patient', CORPORATE: 'corporate' });
const REASONS = Object.freeze({
  LOGOUT: 'logout',
  DEVICE_REMOVED: 'device_removed',
  OTHERS_REMOVED: 'others_removed',
  PASSWORD_RESET: 'password_reset',
  PASSWORD_CHANGED: 'password_changed',
  ACCOUNT_RETIRED: 'account_retired',
  REFRESH_REUSE: 'refresh_reuse',
  IDLE: 'idle',
});

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const newJti = () => crypto.randomBytes(24).toString('hex');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isSessionId = (value) => typeof value === 'string' && SESSION_ID.test(value);

// Whether the generated Prisma client knows the table. Only false when the client was not regenerated after the migration: development then keeps working on legacy tokens (with a warning) and
// production refuses to start (see assertSessionsReady).
const sessionsAvailable = () => Boolean(prisma && prisma.authSession && typeof prisma.authSession.create === 'function');
function assertSessionsReady(env = process.env) {
  if (sessionsAvailable()) return true;
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('The Prisma client has no AuthSession model: run "npx prisma generate" and the auth_sessions migration before starting.');
  if (String(env.NODE_ENV).toLowerCase() !== 'test') console.warn('Sessions are unavailable (the Prisma client was not regenerated): signing in issues legacy tokens. Run "npx prisma generate".');
  return false;
}

// Access tokens without a `sid` (issued before sessions existed) are accepted outside production (so the existing tests and a half-upgraded development setup keep working) and refused in production, where
// they could not be revoked. AUTH_ALLOW_LEGACY_TOKENS=true / false overrides either way.
function legacyAccessTokensAllowed(env = process.env) {
  const value = String(env.AUTH_ALLOW_LEGACY_TOKENS || '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return String(env.NODE_ENV).toLowerCase() !== 'production';
}

// A short, harmless description of the device for the list of signed-in devices. Never stored beyond 255 characters and never used to identify anyone.
const describeUserAgent = (userAgent) => (typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim().slice(0, USER_AGENT_MAX) : null);

const subjectWhere = (subjectType, subjectId) => (subjectType === SUBJECTS.CORPORATE ? { corporateUserId: subjectId } : { userId: subjectId });
const rowBelongsTo = (row, subjectType, subjectId) => (subjectType === SUBJECTS.CORPORATE ? row.corporateUserId === subjectId : subjectType === SUBJECTS.PATIENT ? row.userId === subjectId : false);

// ---- creating ---------------------------------------------------------------------------------------------------------------------------
// -> { id, jti, expiresAt }. The jti goes into the first refresh token; only its hash is stored. The only writer of the table (it enforces exactly one subject).
async function createSession({ subjectType, subjectId, userAgent = null, now = new Date() }) {
  if (subjectType !== SUBJECTS.PATIENT && subjectType !== SUBJECTS.CORPORATE) throw new Error('Unknown session subject');
  if (!Number.isInteger(subjectId)) throw new Error('A session needs the account id');
  const id = crypto.randomUUID();
  const jti = newJti();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  await prisma.authSession.create({
    data: {
      id,
      ...subjectWhere(subjectType, subjectId),
      refreshHash: sha256(jti),
      createdAt: now,
      lastActivityAt: now,
      absoluteExpiresAt: expiresAt,
      userAgent: describeUserAgent(userAgent),
    },
  });
  return { id, jti, expiresAt };
}

// ---- checking an access token (every authenticated request) ------------------------------------------------------------------------------
// -> { ok: true } or { ok: false, reason: 'session_revoked' | 'session_idle' | 'session_expired' | 'session_unknown' }. Refreshes lastActivityAt at most once a minute.
async function checkAccessSession(payload, now = new Date()) {
  const row = isSessionId(payload && payload.sid) ? await prisma.authSession.findUnique({ where: { id: payload.sid } }) : null;
  if (!row || !rowBelongsTo(row, payload.role, payload.sub)) return { ok: false, reason: 'session_unknown' };
  if (row.revokedAt) return { ok: false, reason: 'session_revoked' };
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'session_expired' };
  if (now.getTime() - row.lastActivityAt.getTime() >= IDLE_MS) {
    await prisma.authSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, revokedReason: REASONS.IDLE } });
    return { ok: false, reason: 'session_idle' };
  }
  if (now.getTime() - row.lastActivityAt.getTime() >= ACTIVITY_WRITE_MS) {
    // conditional on the value we read: a concurrent request that already moved it forward is not overwritten with an older time
    await prisma.authSession.updateMany({ where: { id: row.id, revokedAt: null, lastActivityAt: row.lastActivityAt }, data: { lastActivityAt: now } });
  }
  return { ok: true, session: row };
}

// ---- refreshing --------------------------------------------------------------------------------------------------------------------------
// `payload` is a verified refresh token with a `sid` and a `jti`. -> { ok: true, session, jti, expiresAt } (a NEW jti to put in the new refresh token) or { ok: false, reason }:
//   'session_unknown' | 'session_revoked' | 'session_expired' | 'session_idle' | 'refresh_reused' (the session is revoked now) | 'refresh_conflict' (a concurrent refresh won: nothing is revoked, try again)
async function rotateRefresh(payload, now = new Date()) {
  const row = isSessionId(payload && payload.sid) ? await prisma.authSession.findUnique({ where: { id: payload.sid } }) : null;
  if (!row || !rowBelongsTo(row, payload.role, payload.sub) || typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'session_unknown' };
  if (row.revokedAt) return { ok: false, reason: 'session_revoked' };
  if (row.absoluteExpiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'session_expired' };
  if (now.getTime() - row.lastActivityAt.getTime() >= IDLE_MS) {
    await prisma.authSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, revokedReason: REASONS.IDLE } });
    return { ok: false, reason: 'session_idle' };
  }
  const presented = sha256(payload.jti);
  const isCurrent = presented === row.refreshHash;
  const isPreviousInGrace = !isCurrent && row.previousHash && presented === row.previousHash && row.rotatedAt && now.getTime() - row.rotatedAt.getTime() <= ROTATION_GRACE_MS;
  if (!isCurrent && !isPreviousInGrace) {
    // an old refresh token used again: somebody has a copy. End the session.
    await prisma.authSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, revokedReason: REASONS.REFRESH_REUSE } });
    return { ok: false, reason: 'refresh_reused' };
  }
  const jti = newJti();
  const won = await prisma.authSession.updateMany({
    where: { id: row.id, revokedAt: null, refreshHash: row.refreshHash },
    data: { previousHash: presented, refreshHash: sha256(jti), rotatedAt: now, lastActivityAt: now },
  });
  if (won.count === 0) return { ok: false, reason: 'refresh_conflict' };
  return { ok: true, session: row, jti, expiresAt: row.absoluteExpiresAt };
}

// A new refresh token id for an existing session (the first-login password change hands back a fresh pair on the same device). -> { jti, expiresAt } or null when the session is gone.
async function renewRefresh(sessionId, now = new Date()) {
  const row = isSessionId(sessionId) ? await prisma.authSession.findUnique({ where: { id: sessionId } }) : null;
  if (!row || row.revokedAt || row.absoluteExpiresAt.getTime() <= now.getTime()) return null;
  const jti = newJti();
  const done = await prisma.authSession.updateMany({ where: { id: row.id, revokedAt: null }, data: { previousHash: row.refreshHash, refreshHash: sha256(jti), rotatedAt: now, lastActivityAt: now } });
  return done.count === 1 ? { jti, expiresAt: row.absoluteExpiresAt } : null;
}

// ---- revoking ----------------------------------------------------------------------------------------------------------------------------
// One session of this account. -> true when a live session was ended (false: not found, not this account's, or already ended). Another account's session id behaves exactly like an unknown one.
async function revokeSession({ sessionId, subjectType, subjectId, reason, now = new Date() }) {
  if (!isSessionId(sessionId)) return false;
  const done = await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null, ...subjectWhere(subjectType, subjectId) }, data: { revokedAt: now, revokedReason: reason } });
  return done.count === 1;
}

// Every live session of the account, or every one except `exceptSessionId`. -> how many were ended.
async function revokeAllSessions({ subjectType, subjectId, reason, exceptSessionId = null, now = new Date() }) {
  if (!sessionsAvailable()) return 0;
  const where = { revokedAt: null, ...subjectWhere(subjectType, subjectId), ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) };
  const done = await prisma.authSession.updateMany({ where, data: { revokedAt: now, revokedReason: reason } });
  return done.count;
}

// The signed-in devices of the account: live sessions only (not revoked, not expired, not idle). `currentSessionId` marks the one asking.
async function listSessions({ subjectType, subjectId, currentSessionId = null, now = new Date() }) {
  const rows = await prisma.authSession.findMany({
    where: { ...subjectWhere(subjectType, subjectId), revokedAt: null, absoluteExpiresAt: { gt: now } },
    orderBy: { lastActivityAt: 'desc' },
    take: 50,
  });
  return rows
    .filter((row) => now.getTime() - row.lastActivityAt.getTime() < IDLE_MS)
    .map((row) => ({ id: row.id, device: row.userAgent, createdAt: row.createdAt, lastActivityAt: row.lastActivityAt, expiresAt: row.absoluteExpiresAt, current: row.id === currentSessionId }));
}

// Housekeeping, not scheduled by the app: removes sessions that ended or expired more than `olderThanDays` ago. -> how many rows were removed.
async function purgeEndedSessions({ olderThanDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  const done = await prisma.authSession.deleteMany({ where: { OR: [{ absoluteExpiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
  return done.count;
}

module.exports = {
  IDLE_MS, SESSION_LIFETIME_MS, ACTIVITY_WRITE_MS, ROTATION_GRACE_MS, SUBJECTS, REASONS,
  sha256, isSessionId, sessionsAvailable, assertSessionsReady, legacyAccessTokensAllowed,
  createSession, checkAccessSession, rotateRefresh, renewRefresh, revokeSession, revokeAllSessions, listSessions, purgeEndedSessions,
};
