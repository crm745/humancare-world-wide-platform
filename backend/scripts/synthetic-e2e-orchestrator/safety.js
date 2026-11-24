// Shared safety primitives for the synthetic E2E orchestrator:
//   - the protected-request guard (155, 156, 157 must never be touched by this feature)
//   - the never-delete audit table list (cleanup.js must never attempt to delete these)
//   - PID-verified phone-number locking, to stop two concurrent runs from using the same
//     Firebase test number
//
// Pure where possible; the only I/O is the phone-lock files under the run-local directory and the
// process checks delegated to processGuard.js.
const fs = require('fs');
const path = require('path');
const processGuard = require('./processGuard');

// ---- protected requests ------------------------------------------------------------------------
// These three requests must never be marked, approved, verified against, or deleted by this
// feature, regardless of how a runId or manifest is constructed. Checked first, unconditionally,
// before any other guard.
const PROTECTED_REQUEST_IDS = Object.freeze([155, 156, 157]);

class ProtectedResourceError extends Error {
  constructor(requestId) {
    super(`request ${requestId} is protected and may never be touched by the synthetic E2E orchestrator`);
    this.name = 'ProtectedResourceError';
    this.code = 'protected_request';
    this.requestId = requestId;
  }
}

function assertNotProtected(requestId) {
  const id = Number(requestId);
  if (PROTECTED_REQUEST_IDS.includes(id)) throw new ProtectedResourceError(id);
  return id;
}

// ---- audit preservation -------------------------------------------------------------------------
// Tables cleanup.js must never issue a DELETE against, under any flag, for any reason. This list is
// the single source of truth the cleanup module consults; it exists so the "never delete audit
// evidence" rule is enforced in one place rather than scattered through conditional logic.
//   request_events        append-only business audit trail (RequestEvent.serviceRequest is
//                         onDelete: Restrict in prisma/schema.prisma — the database itself refuses
//                         to delete a service_requests row while these exist)
//   security_events       account security log; explicitly has no foreign key ("the history
//                         outlives a deleted account" — prisma/schema.prisma SecurityEvent) and is
//                         never touched regardless
//   cases                 Case.serviceRequest is onDelete: Restrict
//   bitrix_deal_links      the Deal-creation record and its profile stamp
//   integration_outbox      the queued (never sent) Bitrix event
const NEVER_DELETE_TABLES = Object.freeze([
  'request_events', 'security_events', 'cases', 'bitrix_deal_links', 'integration_outbox',
]);

// ---- phone-number locking ------------------------------------------------------------------------
// One lock file per phone number, under `locksDir` (expected: backend/.synthetic-e2e-runs/.phone-locks).
// Content: { runId, pid, acquiredAt }. A lock is only ever removed by the run that proves it owns it
// (its own runId matches), or — for recovery of a genuinely abandoned lock — only after the recorded
// PID is confirmed not alive (never from age alone, and never when the enumeration itself failed).
const STALE_GRACE_MS = 10 * 60 * 1000; // minimum age before even a confirmed-dead PID's lock is reclaimed

class LockUnavailableError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LockUnavailableError';
    this.code = code;
  }
}

function lockPathFor(locksDir, phoneNumber) {
  const safe = String(phoneNumber).replace(/[^A-Za-z0-9+]/g, '_');
  return path.join(locksDir, `${safe}.lock.json`);
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.runId !== 'string' || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Attempts to acquire `phoneNumber` for `runId`. Returns the lock path on success, or null if the
// number is (or may be) held by another live run — never throws for ordinary contention. Throws
// LockUnavailableError only when ownership of an existing lock cannot be established at all (the
// process-state check itself failed) — per "fail closed if lock ownership cannot be established".
function tryAcquirePhoneLock(locksDir, phoneNumber, runId, { now = Date.now, guard = processGuard } = {}) {
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = lockPathFor(locksDir, phoneNumber);
  const record = { runId, pid: process.pid, acquiredAt: new Date(now()).toISOString() };

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx'); // atomic create; fails if the file already exists
    fs.writeFileSync(fd, JSON.stringify(record, null, 2));
    fs.closeSync(fd);
    return lockPath;
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (err.code !== 'EEXIST') throw new LockUnavailableError(`could not create lock file: ${err.message}`, 'lock_io_error');
  }

  // Contention: an existing lock is present. Never assumed stale from age alone.
  const existing = readLock(lockPath);
  if (!existing) {
    // Unreadable/corrupt lock file: ownership cannot be established. Fail closed — do not reclaim.
    return null;
  }
  if (existing.runId === runId) return lockPath; // this run already owns it (re-entrant call)

  let state;
  try {
    state = guard.processState(existing.pid);
  } catch (err) {
    // The liveness check itself failed: ownership cannot be established. Fail closed.
    throw new LockUnavailableError(`could not verify ownership of the lock on ${phoneNumber}: ${err.message}`, 'ownership_unverifiable');
  }

  if (state.alive && state.isNode) {
    // A live node process holds this PID: treat as a possibly-active run. Never reclaim.
    return null;
  }
  if (state.alive && !state.isNode) {
    // The PID is alive but is NOT a node process: conclusive proof of PID reuse / staleness, no age
    // grace period needed (the original process is provably gone).
  } else {
    // PID does not exist at all: likely dead, but still require a minimum grace period before
    // reclaiming, to avoid racing a run that is mid-crash-recovery.
    const age = now() - Date.parse(existing.acquiredAt || 0);
    if (!(age >= STALE_GRACE_MS)) return null;
  }

  // Reclaim: overwrite, then read back to confirm we are now the owner before using the number.
  try {
    fs.writeFileSync(lockPath, JSON.stringify(record, null, 2));
  } catch (err) {
    throw new LockUnavailableError(`could not reclaim lock on ${phoneNumber}: ${err.message}`, 'lock_io_error');
  }
  const confirmed = readLock(lockPath);
  if (!confirmed || confirmed.runId !== runId) return null;
  return lockPath;
}

// Releases a lock only if it can prove, by reading the file back, that the given runId is the
// current owner. Never deletes a lock it does not recognize as its own.
function releasePhoneLock(lockPath, runId) {
  const existing = readLock(lockPath);
  if (!existing) return { released: false, reason: 'not_found' };
  if (existing.runId !== runId) return { released: false, reason: 'not_owner' };
  try {
    fs.unlinkSync(lockPath);
    return { released: true };
  } catch (err) {
    return { released: false, reason: 'io_error', detail: err.message };
  }
}

module.exports = {
  PROTECTED_REQUEST_IDS, ProtectedResourceError, assertNotProtected,
  NEVER_DELETE_TABLES,
  LockUnavailableError, lockPathFor, readLock, tryAcquirePhoneLock, releasePhoneLock,
};
