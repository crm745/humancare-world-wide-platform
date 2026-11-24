// The database half of the quotation sync worker: claiming, fencing and recovery of "bitrix.quotation.sync" outbox events. The lease is
// set and checked with the database's own UTC clock (UTC_TIMESTAMP(3)), exactly like deal-outbox.store.js, which is NOT changed and whose
// statements only ever match "bitrix.deal.create". Nothing here calls Bitrix24.
//
// Simpler than the Deal event on purpose: a quotation event makes NO external write, so there is no "call started" evidence and no
// ambiguous state; a Bitrix read can simply be tried again. A result is ONE fenced UPDATE (id, status 'processing', the attempts value
// this worker claimed, locked_by, a lease still in the future); 0 rows = the lease was lost and the worker writes nothing else.
const { QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE } = require('./quotation-outbox');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { normalizeCaseIds } = require('./deal-outbox.store');

const MAX_ERROR_LENGTH = 500;
const toNumber = (v) => (v == null ? null : Number(v));
const marks = (list) => list.map(() => '?').join(', ');
const cleanError = (text) => (text == null ? null : String(text).replace(/https?:\/\/\S+/gi, '[url]').slice(0, MAX_ERROR_LENGTH));

// Due, unlocked events of Private Charter Cases in the review workflow, without a Lead, whose request is approved. `caseIds` limits a pass to
// those Cases (the scoped test runner); an empty or malformed list is refused, never read as "everything".
async function findCandidateIds(db, limit, scope, profile = null) {
  const caseIds = normalizeCaseIds(scope && scope.caseIds);
  const rows = await db.$queryRawUnsafe(
    `SELECT o.id AS id
     FROM integration_outbox o
     JOIN cases c ON c.id = o.case_id
     JOIN service_requests sr ON sr.id = c.service_request_id
     WHERE o.event_type = ? AND o.entity_type = ? AND o.status = 'pending'
       AND o.next_attempt_at <= UTC_TIMESTAMP(3)
       AND (o.locked_until IS NULL OR o.locked_until <= UTC_TIMESTAMP(3))
       AND sr.service_key = ? AND sr.review_status = 'approved' AND sr.bitrix_lead_id IS NULL
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.profile')), 'test') = ?
       ${caseIds ? `AND o.case_id IN (${marks(caseIds)})` : ''}
     ORDER BY o.id
     LIMIT ?`,
    QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE, PRIVATE_CHARTER_KEY, profile, ...(caseIds || []), limit,
  );
  return rows.map((r) => Number(r.id));
}

/** Takes one due event, or null when it cannot be taken (someone else holds it, or it is not due). */
async function claim(db, { id, workerId, leaseSeconds }) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, status, attempts, case_id, entity_id
      FROM integration_outbox
      WHERE id = ${id} AND event_type = ${QUOTATION_SYNC_EVENT} AND entity_type = ${QUOTATION_ENTITY_TYPE}
        AND next_attempt_at <= UTC_TIMESTAMP(3) AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
      FOR UPDATE`;
    const row = rows[0];
    if (!row || row.status !== 'pending') return null;
    const changed = await tx.$executeRaw`
      UPDATE integration_outbox
      SET status = 'processing', attempts = attempts + 1, locked_by = ${workerId},
          locked_until = UTC_TIMESTAMP(3) + INTERVAL ${leaseSeconds} SECOND, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ${id} AND status = 'pending' AND attempts = ${row.attempts}
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
    if (Number(changed) !== 1) return null;
    return { id, workerId, attempts: Number(row.attempts) + 1, caseId: toNumber(row.case_id), dealId: String(row.entity_id) };
  });
}

/** The single fenced result: 'completed', 'failed', or 'pending' (a retry after `delaySeconds`). Rows written: 1 = recorded, 0 = lease lost. */
async function writeResult(db, claimed, { status, lastError = null, delaySeconds = 0 }) {
  if (!['completed', 'failed', 'pending'].includes(status)) throw new Error('Unsupported quotation event status.');
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

/** Expired leases: back to 'pending', or 'failed' after `maxClaims` claims. Only this event type; with `caseIds` only those Cases. */
async function recoverExpiredLeases(db, { maxClaims, caseIds }) {
  const scoped = normalizeCaseIds(caseIds);
  const where = `event_type = ? AND entity_type = ? AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)${scoped ? ` AND case_id IN (${marks(scoped)})` : ''}`;
  const args = [QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE, ...(scoped || [])];
  const failed = await db.$executeRawUnsafe(
    `UPDATE integration_outbox SET status = 'failed', last_error = 'lease_expired_repeatedly', locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE ${where} AND attempts >= ?`, ...args, maxClaims);
  const pending = await db.$executeRawUnsafe(
    `UPDATE integration_outbox SET status = 'pending', next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE ${where} AND attempts < ?`, ...args, maxClaims);
  return { failed: Number(failed), pending: Number(pending) };
}

module.exports = { findCandidateIds, claim, writeResult, recoverExpiredLeases, cleanError };
