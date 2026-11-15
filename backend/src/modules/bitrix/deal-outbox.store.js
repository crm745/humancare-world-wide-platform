// The database half of the Deal worker: claiming, fencing and recovery of "bitrix.deal.create" outbox events, as
// specified by the M6 design (prisma/schema.prisma, model IntegrationOutbox). Every statement is raw SQL because
// the lease is set AND checked with the database's own UTC clock (UTC_TIMESTAMP(3)); ordinary Prisma updates use
// the application clock, which M6 forbids mixing with it. Nothing here calls Bitrix.
//
// `db` is the Prisma client or a transaction. Functions that must be atomic are called inside the caller's
// transaction (claim opens its own).
//
// The fence: every result is ONE UPDATE that checks id, status 'processing', the attempts value this worker
// claimed, locked_by, and locked_until still in the future. 0 rows written = this worker no longer owns the
// event and must write nothing else.
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { DEAL_CREATE_EVENT, DEAL_ENTITY_TYPE, dealRecoveryIdempotencyKey } = require('./deal-outbox');

// A manual-review marker, in last_error (the status vocabulary is fixed by M6, so "ambiguous" stays the status).
const MANUAL_REVIEW_PREFIX = 'manual_review_required';
const MAX_ERROR_LENGTH = 500;

const toNumber = (value) => (value == null ? null : Number(value));

// last_error must never hold a URL, token or secret: URLs are removed and the text is capped.
function cleanError(text) {
  if (text == null) return null;
  return String(text).replace(/https?:\/\/\S+/gi, '[url]').slice(0, MAX_ERROR_LENGTH);
}

// Ids of due events of one status that are allowed to be processed AT ALL. The joins exclude Corporate Cases
// (no service request), other services, NULL review status and requests that already have a Lead. Events in manual
// review are never offered again.
async function findCandidateIds(db, status, limit) {
  const rows = await db.$queryRaw`
    SELECT o.id AS id
    FROM integration_outbox o
    JOIN cases c ON c.id = o.case_id
    JOIN service_requests sr ON sr.id = c.service_request_id
    WHERE o.event_type = ${DEAL_CREATE_EVENT}
      AND o.entity_type = ${DEAL_ENTITY_TYPE}
      AND o.status = ${status}
      AND o.next_attempt_at <= UTC_TIMESTAMP(3)
      AND (o.locked_until IS NULL OR o.locked_until <= UTC_TIMESTAMP(3))
      AND sr.service_key = ${PRIVATE_CHARTER_KEY}
      AND sr.review_status IS NOT NULL
      AND sr.bitrix_lead_id IS NULL
      AND (o.last_error IS NULL OR o.last_error NOT LIKE ${`${MANUAL_REVIEW_PREFIX}%`})
    ORDER BY o.id
    LIMIT ${limit}`;
  return rows.map((row) => Number(row.id));
}

// Takes one event, or returns null when it cannot be taken (someone else has it, it is not due, or an EARLIER event
// of the same Case is not completed). One transaction: a locking read of the event and of the Case's earlier
// events, then the compare-and-swap UPDATE. Only 'completed' events do not block a later one.
async function claim(db, { id, fromStatus, workerId, leaseSeconds }) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, status, attempts, case_id, entity_type, entity_id, idempotency_key, external_call_started_at,
             TIMESTAMPDIFF(SECOND, external_call_started_at, UTC_TIMESTAMP(3)) AS seconds_since_call
      FROM integration_outbox
      WHERE id = ${id}
        AND next_attempt_at <= UTC_TIMESTAMP(3)
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
      FOR UPDATE`;
    const row = rows[0];
    if (!row || row.status !== fromStatus) return null;

    const earlier = await tx.$queryRaw`
      SELECT id, status, last_error FROM integration_outbox
      WHERE entity_type = ${row.entity_type} AND entity_id = ${row.entity_id} AND id < ${id}
      ORDER BY id
      FOR UPDATE`;
    for (const event of earlier) {
      if (event.status === 'completed') continue;
      // A person's recovery decision (see deal-recovery.service.js) releases a failed event, or an ambiguous one in
      // manual review, in exactly two ways: for its own replacement event, and for later events once that
      // replacement has COMPLETED. Everything else still blocks, as M6 requires.
      const decided = event.status === 'failed' || (event.status === 'ambiguous' && String(event.last_error || '').startsWith(MANUAL_REVIEW_PREFIX));
      if (!decided) return null;
      const replacementKey = dealRecoveryIdempotencyKey(row.entity_id, event.id);
      if (row.idempotency_key === replacementKey) continue;
      const replacement = await tx.$queryRaw`SELECT status FROM integration_outbox WHERE idempotency_key = ${replacementKey}`;
      if (!replacement[0] || replacement[0].status !== 'completed') return null;
    }

    const changed = await tx.$executeRaw`
      UPDATE integration_outbox
      SET status = 'processing', attempts = attempts + 1, locked_by = ${workerId},
          locked_until = UTC_TIMESTAMP(3) + INTERVAL ${leaseSeconds} SECOND, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ${id} AND status = ${fromStatus} AND attempts = ${row.attempts}
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
    if (Number(changed) !== 1) return null;
    return {
      id,
      fromStatus,
      workerId,
      attempts: Number(row.attempts) + 1,
      caseId: toNumber(row.case_id),
      externalCallStartedAt: row.external_call_started_at ?? null,
      secondsSinceCall: toNumber(row.seconds_since_call),
    };
  });
}

// Sets external_call_started_at BEFORE the Bitrix call, only for the current claimant, and only if the lease will
// outlive the call (`minRemainingSeconds` = request timeout + margin). The evidence is written once and never
// overwritten or cleared. Returns true when it was written.
async function markExternalCallStarted(db, claimed, minRemainingSeconds) {
  const changed = await db.$executeRaw`
    UPDATE integration_outbox
    SET external_call_started_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND status = 'processing' AND attempts = ${claimed.attempts} AND locked_by = ${claimed.workerId}
      AND locked_until > UTC_TIMESTAMP(3) + INTERVAL ${minRemainingSeconds} SECOND
      AND external_call_started_at IS NULL`;
  return Number(changed) === 1;
}

// The single fenced result UPDATE for completed / failed / ambiguous (and a reschedule). The lease is released.
// Returns the number of rows written: 1 = recorded, 0 = this worker lost its lease and wrote nothing.
async function writeResult(db, claimed, { status, lastError = null, delaySeconds = 0 }) {
  const changed = await db.$executeRaw`
    UPDATE integration_outbox
    SET status = ${status}, last_error = ${cleanError(lastError)},
        next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND,
        completed_at = CASE WHEN ${status} = 'completed' THEN UTC_TIMESTAMP(3) ELSE completed_at END,
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND status = 'processing' AND attempts = ${claimed.attempts} AND locked_by = ${claimed.workerId}
      AND locked_until > UTC_TIMESTAMP(3)`;
  return Number(changed);
}

// Expired leases (never by the expired worker; a compare-and-swap on status 'processing' and the expiry):
//   (a) no external call was started      -> back to 'pending' (or 'failed' once claimed too many times);
//   (b) an external call WAS started      -> 'ambiguous' (outcome unknown; reconciliation, never a re-send).
// 'failed' events are never touched.
async function recoverExpiredLeases(db, { maxClaims }) {
  const failed = await db.$executeRaw`
    UPDATE integration_outbox
    SET status = 'failed', last_error = 'lease_expired_repeatedly_before_any_external_call',
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE event_type = ${DEAL_CREATE_EVENT} AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)
      AND external_call_started_at IS NULL AND attempts >= ${maxClaims}`;
  const pending = await db.$executeRaw`
    UPDATE integration_outbox
    SET status = 'pending', next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE event_type = ${DEAL_CREATE_EVENT} AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)
      AND external_call_started_at IS NULL AND attempts < ${maxClaims}`;
  const ambiguous = await db.$executeRaw`
    UPDATE integration_outbox
    SET status = 'ambiguous', last_error = 'lease_expired_during_external_call',
        next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE event_type = ${DEAL_CREATE_EVENT} AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)
      AND external_call_started_at IS NOT NULL`;
  return { failed: Number(failed), pending: Number(pending), ambiguous: Number(ambiguous) };
}

module.exports = {
  findCandidateIds, claim, markExternalCallStarted, writeResult, recoverExpiredLeases, cleanError, MANUAL_REVIEW_PREFIX,
};
