// Database half of the inbound Deal-stage processor: claiming, fencing and recovery of integration_inbox rows,
// following the M6 inbox rules. Every statement is raw SQL so the lease is set AND checked with the database's own
// UTC clock (UTC_TIMESTAMP(3)); ordinary Prisma updates would use the application clock. Nothing here calls Bitrix.
//
// The fence is the same as the outbox's: a result is ONE UPDATE that checks id, status 'processing', the attempts
// value this worker claimed, locked_by, and locked_until still in the future. 0 rows = the lease was lost and the
// worker must write nothing else. Per-Deal ordering is not needed for correctness (the processor re-reads the Deal's
// current state and compares modified times), so claiming is per row.
const SOURCE = 'bitrix24';
const DEAL_EVENT = 'ONCRMDEALUPDATE';
const MAX_ERROR_LENGTH = 200;

// last_error holds a short code only: letters, digits and a few separators, capped.
function cleanCode(text) {
  if (text == null) return null;
  return String(text).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, MAX_ERROR_LENGTH);
}

async function findDueIds(db, limit) {
  const rows = await db.$queryRaw`
    SELECT id FROM integration_inbox
    WHERE source = ${SOURCE} AND event_type = ${DEAL_EVENT} AND status = 'received'
      AND next_attempt_at <= UTC_TIMESTAMP(3)
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
    ORDER BY id
    LIMIT ${limit}`;
  return rows.map((row) => Number(row.id));
}

// Compare-and-swap claim. Returns the claim, or null when another worker got there first.
async function claim(db, { id, workerId, leaseSeconds }) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, attempts, entity_id, external_occurred_at FROM integration_inbox
      WHERE id = ${id} AND status = 'received' AND next_attempt_at <= UTC_TIMESTAMP(3)
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
      FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    const changed = await tx.$executeRaw`
      UPDATE integration_inbox
      SET status = 'processing', attempts = attempts + 1, locked_by = ${workerId},
          locked_until = UTC_TIMESTAMP(3) + INTERVAL ${leaseSeconds} SECOND, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ${id} AND status = 'received' AND attempts = ${row.attempts}
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
    if (Number(changed) !== 1) return null;
    return { id, workerId, attempts: Number(row.attempts) + 1, dealId: String(row.entity_id), occurredAt: row.external_occurred_at ?? null };
  });
}

// The fenced result write: 'processed' | 'ignored' (final) | 'failed' (final) | 'received' (try again after
// `delaySeconds`). Returns the rows written (1 = recorded, 0 = lease lost).
async function writeResult(db, claimed, { status, lastError = null, delaySeconds = 0 }) {
  const changed = await db.$executeRaw`
    UPDATE integration_inbox
    SET status = ${status}, last_error = ${cleanCode(lastError)},
        next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND,
        processed_at = CASE WHEN ${status} IN ('processed', 'ignored', 'failed') THEN UTC_TIMESTAMP(3) ELSE processed_at END,
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND status = 'processing' AND attempts = ${claimed.attempts} AND locked_by = ${claimed.workerId}
      AND locked_until > UTC_TIMESTAMP(3)`;
  return Number(changed);
}

// Expired leases: applying an event is idempotent (current state is re-read, stage events are keyed), so an
// event whose worker died simply goes back to 'received'; past the cap it becomes 'failed'.
async function recoverExpiredLeases(db, { maxAttempts }) {
  const failed = await db.$executeRaw`
    UPDATE integration_inbox
    SET status = 'failed', last_error = 'lease_expired_repeatedly', locked_by = NULL, locked_until = NULL,
        processed_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
    WHERE source = ${SOURCE} AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3) AND attempts >= ${maxAttempts}`;
  const again = await db.$executeRaw`
    UPDATE integration_inbox
    SET status = 'received', next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE source = ${SOURCE} AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3) AND attempts < ${maxAttempts}`;
  return { failed: Number(failed), again: Number(again) };
}

module.exports = { findDueIds, claim, writeResult, recoverExpiredLeases, cleanCode, SOURCE, DEAL_EVENT };
