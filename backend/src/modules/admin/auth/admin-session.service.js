// Database-backed Admin dashboard sessions: creation (with the concurrent-session limit), validation
// on every request, refresh-token rotation with reuse detection, and logout.
//
// The database is the authority. An access token only names a session (`sid`); whether that
// session, and the Admin behind it, are still good - and what role the Admin has - is always
// read from the database. Raw refresh tokens exist only in memory here and in the caller's hands;
// only their SHA-256 is stored, and they are never logged or audited.
//
// `db` is a root Prisma client (it needs $transaction) unless a function says it takes a
// transaction client (`tx`).
const crypto = require('crypto');
const { prisma } = require('../../../db/prisma');
const { hashToken } = require('../../../common/utils/token-hash');
const { ADMIN_LOCK_POLICY } = require('./admin-lock.config');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { signAdminAccessToken } = require('./admin-token.service');

const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Last-activity is written at most this often, so a busy dashboard does not write on every request.
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = Math.floor(ADMIN_LOCK_POLICY.accessTokenTtlMs / 1000);

// The one error for every unusable session or refresh token. It says nothing about why.
class AdminSessionError extends Error {
  constructor() {
    super('Your session is not valid. Please sign in again.');
    this.name = 'AdminSessionError';
    this.code = 'invalid_session';
  }
}

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

// Idle time is measured from `now`, but can never run past the session's absolute end.
function nextIdleExpiry(now, absoluteExpiresAt) {
  const idle = now.getTime() + ADMIN_LOCK_POLICY.sessionIdleTimeoutMs;
  return new Date(Math.min(idle, absoluteExpiresAt.getTime()));
}

function newRefreshToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

// Revokes the sessions and every still-active refresh token belonging to them. Rows are kept.
async function revokeSessionRows(tx, sessionIds, reason, now, revokedBy = null) {
  if (sessionIds.length === 0) return;
  await tx.adminSession.updateMany({
    where: { id: { in: sessionIds }, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason, revokedBy },
  });
  await tx.adminRefreshToken.updateMany({
    where: { sessionId: { in: sessionIds }, revokedAt: null },
    data: { revokedAt: now },
  });
}

// Best-effort revoke used when a request notices a session has ended (idle, absolute, Admin no
// longer active). Nothing depends on it: the checks that found the problem already refuse the request.
async function revokeBestEffort(db, sessionId, reason, now) {
  try {
    await db.$transaction((tx) => revokeSessionRows(tx, [sessionId], reason, now));
  } catch (err) {
    console.error(`Could not record an ended Admin session (${err.code || err.name}).`);
  }
}

// Creates a session and its first refresh token for an Admin who has just completed BOTH login
// factors. Must run inside the caller's transaction (`tx`) AFTER that transaction has locked and
// revalidated the Admin row, which is what serialises the concurrent-session count.
// If the Admin already has the maximum number of live sessions, the oldest are revoked (reason
// "session_limit", audited) so that, with the new one, there are never more than the maximum.
// Returns { sessionId, refreshToken (raw), refreshExpiresAt, idleExpiresAt, absoluteExpiresAt }.
async function createAdminSession(tx, { admin, now = new Date(), ipAddress = null, userAgent = null } = {}) {
  const max = ADMIN_LOCK_POLICY.maxConcurrentSessions;

  const live = await tx.adminSession.findMany({
    where: { adminId: admin.id, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
  });
  live.sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id));
  const excess = live.length - (max - 1);
  if (excess > 0) {
    const doomed = live.slice(0, excess);
    await revokeSessionRows(tx, doomed.map((s) => s.id), 'session_limit', now);
    for (const session of doomed) {
      await recordAdminAuditEvent({
        actorType: 'system',
        event: 'admin.session_revoked',
        identifier: admin.email,
        detail: { adminId: admin.id, sessionId: session.id, reason: 'session_limit' },
        db: tx,
      });
    }
  }

  const absoluteExpiresAt = new Date(now.getTime() + ADMIN_LOCK_POLICY.sessionAbsoluteLifetimeMs);
  const idleExpiresAt = nextIdleExpiry(now, absoluteExpiresAt);
  const session = await tx.adminSession.create({
    data: {
      adminId: admin.id,
      createdAt: now,
      lastActivityAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      ipAddress: clip(ipAddress, 64),
      userAgent: clip(userAgent, 255),
    },
  });
  const { token, tokenHash } = newRefreshToken();
  await tx.adminRefreshToken.create({ data: { sessionId: session.id, tokenHash, expiresAt: absoluteExpiresAt } });

  return { sessionId: session.id, refreshToken: token, refreshExpiresAt: absoluteExpiresAt, idleExpiresAt, absoluteExpiresAt };
}

// Checks, against the database, that a session named by an access token is usable right now.
// Returns { session, admin } or null. It rejects (and, best-effort, ends) sessions that are past
// their idle or absolute limit or whose Admin is no longer active; rejects revoked sessions and
// sessions that belong to someone else. A usable session's idle clock is moved forward, but only
// once per ACTIVITY_WRITE_INTERVAL_MS and never past the absolute end. The caller takes the role
// from `admin` (the database), not from the token.
async function validateAdminSession({ sessionId, adminId, now = new Date(), db = prisma } = {}) {
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(adminId) || adminId <= 0) return null;

  const session = await db.adminSession.findUnique({ where: { id: sessionId } });
  if (!session || session.adminId !== adminId || session.revokedAt) return null;
  if (!(session.absoluteExpiresAt > now)) {
    await revokeBestEffort(db, session.id, 'absolute_timeout', now);
    return null;
  }
  if (!(session.idleExpiresAt > now)) {
    await revokeBestEffort(db, session.id, 'idle_timeout', now);
    return null;
  }

  const admin = await db.adminUser.findUnique({ where: { id: adminId } });
  if (!admin || admin.status !== 'active') {
    await revokeBestEffort(db, session.id, 'admin_inactive', now);
    return null;
  }

  if (now.getTime() - session.lastActivityAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS) {
    // Conditional: a session revoked or ended meanwhile is not revived by an activity write.
    await db.adminSession.updateMany({
      where: { id: session.id, revokedAt: null, absoluteExpiresAt: { gt: now } },
      data: { lastActivityAt: now, idleExpiresAt: nextIdleExpiry(now, session.absoluteExpiresAt) },
    });
  }
  return { session, admin };
}

// Exchanges a refresh token for a new access token and a new refresh token (rotation).
//  - unused, valid token: marked used and replaced (replacedById), new tokens returned;
//  - a USED token presented within the reuse grace (10 s): { status: 'retry' }, nothing revoked
//    (a benign race such as two tabs; the caller should retry with the newer cookie);
//  - a used token presented after the grace: reuse - the session and all its tokens are revoked
//    and audited, and the call fails;
//  - anything else unusable (unknown, revoked, expired, idle/absolute-expired session, inactive
//    Admin): AdminSessionError, with idle/absolute/inactive sessions also ended.
// Returns { status: 'rotated', accessToken, refreshToken, ... } or { status: 'retry' }; throws
// AdminSessionError. The new tokens leave this function only after the commit.
async function rotateAdminRefreshToken({ refreshToken, ipAddress = null, now = new Date(), db = prisma } = {}) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
  if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_PATTERN.test(refreshToken)) throw new AdminSessionError();

  const found = await db.adminRefreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
  if (!found) throw new AdminSessionError();

  const outcome = await db.$transaction(async (tx) => {
    // Lock the session (only while it is not revoked): concurrent refreshes queue here.
    const locked = await tx.adminSession.updateMany({ where: { id: found.sessionId, revokedAt: null }, data: { revokedAt: null } });
    if (locked.count !== 1) return { kind: 'refuse' };

    const token = await tx.adminRefreshToken.findUnique({ where: { id: found.id } });
    const session = await tx.adminSession.findUnique({ where: { id: found.sessionId } });
    if (!token || !session || session.revokedAt) return { kind: 'refuse' };

    if (token.usedAt) {
      if (now.getTime() - token.usedAt.getTime() <= ADMIN_LOCK_POLICY.refreshTokenReuseGraceMs) return { kind: 'retry' };
      // A token that was already exchanged is being presented again, outside the grace window.
      await revokeSessionRows(tx, [session.id], 'refresh_reuse', now);
      await recordAdminAuditEvent({
        actorType: 'system',
        event: 'admin.refresh_reuse_detected',
        ipAddress,
        detail: { adminId: session.adminId, sessionId: session.id },
        db: tx,
      });
      return { kind: 'refuse' }; // committed: the revocation must stand
    }
    // The session's own limits first, so a session that has run out is ended (with the reason)
    // even though its tokens, which expire with it, would also be refused.
    if (!(session.absoluteExpiresAt > now)) {
      await revokeSessionRows(tx, [session.id], 'absolute_timeout', now);
      return { kind: 'refuse' };
    }
    if (!(session.idleExpiresAt > now)) {
      await revokeSessionRows(tx, [session.id], 'idle_timeout', now);
      return { kind: 'refuse' };
    }
    const admin = await tx.adminUser.findUnique({ where: { id: session.adminId } });
    if (!admin || admin.status !== 'active') {
      await revokeSessionRows(tx, [session.id], 'admin_inactive', now);
      return { kind: 'refuse' };
    }
    if (token.revokedAt || !(token.expiresAt > now)) return { kind: 'refuse' };

    const fresh = newRefreshToken();
    const created = await tx.adminRefreshToken.create({
      data: { sessionId: session.id, tokenHash: fresh.tokenHash, expiresAt: session.absoluteExpiresAt },
    });
    const consumed = await tx.adminRefreshToken.updateMany({
      where: { id: token.id, usedAt: null, revokedAt: null },
      data: { usedAt: now, replacedById: created.id },
    });
    if (consumed.count !== 1) throw new AdminSessionError(); // rolls the new token back
    await tx.adminSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastActivityAt: now, idleExpiresAt: nextIdleExpiry(now, session.absoluteExpiresAt) },
    });

    // Role comes from the database; signed last so a signing failure rolls everything back.
    const accessToken = signAdminAccessToken({ adminId: admin.id, role: admin.role, sessionId: session.id });
    return {
      kind: 'rotated',
      accessToken,
      refreshToken: fresh.token,
      refreshExpiresAt: session.absoluteExpiresAt,
      accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };
  });

  if (outcome.kind === 'retry') return { status: 'retry' };
  if (outcome.kind !== 'rotated') throw new AdminSessionError();
  return {
    status: 'rotated',
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken,
    refreshExpiresAt: outcome.refreshExpiresAt,
    accessTokenExpiresInSeconds: outcome.accessTokenExpiresInSeconds,
  };
}

// Ends one session (logout): revokes it and all its refresh tokens and audits it, atomically.
// `adminId` must own the session. Idempotent: returns { revoked: false } if there was nothing to revoke.
async function revokeAdminSession({ sessionId, adminId, ipAddress = null, now = new Date(), db = prisma } = {}) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(adminId) || adminId <= 0) return { revoked: false };

  return db.$transaction(async (tx) => {
    const ended = await tx.adminSession.updateMany({
      where: { id: sessionId, adminId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'logout', revokedBy: adminId },
    });
    if (ended.count !== 1) return { revoked: false };
    await tx.adminRefreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } });
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: adminId,
      event: 'admin_logout',
      ipAddress,
      detail: { sessionId },
      db: tx,
    });
    return { revoked: true };
  });
}

module.exports = {
  createAdminSession,
  validateAdminSession,
  rotateAdminRefreshToken,
  revokeAdminSession,
  revokeSessionRows,
  AdminSessionError,
  ACTIVITY_WRITE_INTERVAL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
};
