// The database half of the Deal DOCUMENT worker (see deal-document-worker.service.js): which document events are due, lease
// recovery for them, and the per-Deal file lease. Raw SQL on the database's own clock (UTC_TIMESTAMP(3)), exactly like
// deal-outbox.store.js, whose claim / markExternalCallStarted / writeResult are REUSED unchanged (they work on any outbox row:
// the lease, the fence and the attempts value are the same for every event type). Nothing here calls Bitrix.
//
// One document event = one attempt. An automatic retry or an Admin retry is a NEW event with a new key, so every event has its
// own entity ("<shareId>:attach:<try>") and a failed attempt never blocks the next one or another document.
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const base = require('./deal-outbox.store');

const ATTACH_EVENT = 'bitrix.deal.document.attach';
const REMOVE_EVENT = 'bitrix.deal.document.remove';
const EVENT_TYPES = [ATTACH_EVENT, REMOVE_EVENT];
const ENTITY_TYPE = 'deal_document_share';

const attachKey = (shareId, tryNumber) => `${ATTACH_EVENT}:share:${shareId}:try:${tryNumber}`;
const removeKey = (shareId, tryNumber) => `${REMOVE_EVENT}:share:${shareId}:try:${tryNumber}`;
const entityOf = (shareId, kind, tryNumber) => `${shareId}:${kind}:${tryNumber}`;

const marks = (list) => list.map(() => '?').join(', ');

// Ids of due document events of one status for APPROVED Private Charter requests. With a scope ({ caseIds }) only those Cases'
// events are offered; an empty or malformed scope is refused (never read as "everything").
async function findCandidateIds(db, status, limit, scope) {
  const caseIds = base.normalizeCaseIds(scope && scope.caseIds);
  const rows = await db.$queryRawUnsafe(
    `SELECT o.id AS id
     FROM integration_outbox o
     JOIN cases c ON c.id = o.case_id
     JOIN service_requests sr ON sr.id = c.service_request_id
     WHERE o.event_type IN (${marks(EVENT_TYPES)})
       AND o.entity_type = ?
       AND o.status = ?
       AND o.next_attempt_at <= UTC_TIMESTAMP(3)
       AND (o.locked_until IS NULL OR o.locked_until <= UTC_TIMESTAMP(3))
       AND sr.service_key = ?
       AND sr.review_status = 'approved'
       AND (o.last_error IS NULL OR o.last_error NOT LIKE ?)
       ${caseIds ? `AND o.case_id IN (${marks(caseIds)})` : ''}
     ORDER BY o.id
     LIMIT ?`,
    ...EVENT_TYPES, ENTITY_TYPE, status, PRIVATE_CHARTER_KEY, `${base.MANUAL_REVIEW_PREFIX}%`, ...(caseIds || []), limit,
  );
  return rows.map((row) => Number(row.id));
}

// Expired leases of document events (same rules as deal-outbox.store.js): no call started -> back to pending (or failed after too
// many claims); a call WAS started -> ambiguous (reconciled by reading the Deal, never repeated blindly).
async function recoverExpiredLeases(db, { maxClaims, caseIds }) {
  const scope = base.normalizeCaseIds(caseIds);
  const where = `event_type IN (${marks(EVENT_TYPES)}) AND entity_type = ? AND status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)`
    + `${scope ? ` AND case_id IN (${marks(scope)})` : ''}`;
  const params = [...EVENT_TYPES, ENTITY_TYPE, ...(scope || [])];
  const failed = await db.$executeRawUnsafe(
    `UPDATE integration_outbox SET status = 'failed', last_error = 'lease_expired_repeatedly_before_any_external_call',
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE ${where} AND external_call_started_at IS NULL AND attempts >= ?`, ...params, maxClaims);
  const pending = await db.$executeRawUnsafe(
    `UPDATE integration_outbox SET status = 'pending', next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE ${where} AND external_call_started_at IS NULL AND attempts < ?`, ...params, maxClaims);
  const ambiguous = await db.$executeRawUnsafe(
    `UPDATE integration_outbox SET status = 'ambiguous', last_error = 'lease_expired_during_external_call',
        next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE ${where} AND external_call_started_at IS NOT NULL`, ...params);
  return { failed: Number(failed), pending: Number(pending), ambiguous: Number(ambiguous) };
}

// The event's type, entity and payload (claim() does not return them).
async function loadEvent(db, id) {
  const rows = await db.$queryRawUnsafe('SELECT id, event_type, entity_id, case_id, status, payload FROM integration_outbox WHERE id = ?', id);
  if (!rows[0]) return null;
  const row = rows[0];
  let payload = row.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  return { id: Number(row.id), eventType: row.event_type, entityId: row.entity_id, caseId: row.case_id == null ? null : Number(row.case_id), status: row.status, payload };
}

// The per-Deal file lease. Bitrix replaces a file field's whole list on update, so only one worker at a time may read-modify-write
// one Deal's files. Taken with a compare-and-swap on the database clock; the holder may extend its own lease. Returns true when held.
async function acquireFileLease(db, linkId, workerId, seconds) {
  const changed = await db.$executeRawUnsafe(
    `UPDATE bitrix_deal_links
     SET file_locked_by = ?, file_locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND, updated_at = UTC_TIMESTAMP(3)
     WHERE id = ? AND (file_locked_until IS NULL OR file_locked_until <= UTC_TIMESTAMP(3) OR file_locked_by = ?)`,
    workerId, seconds, linkId, workerId,
  );
  return Number(changed) === 1;
}

async function releaseFileLease(db, linkId, workerId) {
  await db.$executeRawUnsafe('UPDATE bitrix_deal_links SET file_locked_by = NULL, file_locked_until = NULL, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND file_locked_by = ?', linkId, workerId);
}

module.exports = {
  ATTACH_EVENT, REMOVE_EVENT, EVENT_TYPES, ENTITY_TYPE, attachKey, removeKey, entityOf,
  findCandidateIds, recoverExpiredLeases, loadEvent, acquireFileLease, releaseFileLease,
  // reused unchanged from the Deal-creation store
  claim: base.claim, markExternalCallStarted: base.markExternalCallStarted, writeResult: base.writeResult,
  MANUAL_REVIEW_PREFIX: base.MANUAL_REVIEW_PREFIX, normalizeCaseIds: base.normalizeCaseIds,
};
