// The database half of the Razorpay webhook inbox: the RECEIVER writes allow-listed events into integration_inbox (storeEvent), and the WORKER
// claims, leases, retries and records the result of them (findDueIds, claim, holdLease, writeResult, retryOrFail, recoverExpiredLeases). A separate store from
// the Bitrix one (modules/bitrix/deal-inbox.store.js), which is hard-wired to source "bitrix24" and is NOT touched, parameterized or imported here.
//
// Rows: source "razorpay"; external_event_id = the Razorpay event id, or the deterministic "sha256:<hex of the raw body>" fallback; status
// "received" (a supported event for the worker) or "ignored" (final: an unsupported or unusable event, kept for reconciliation). The payload is
// whatever razorpay-webhook.events.js built: allow-listed fields only.
//
// `db` is the Prisma client. Nothing here reads or writes a payment, and nothing here logs.
const SOURCE = 'razorpay';

// ---- the receiver half ------------------------------------------------------------------------------------------------------------------

// Stores one event. Resolves { stored: true } or { stored: false, duplicate: true } when the same event id is already there (the unique key
// (source, external_event_id), Prisma error P2002). Any other failure is thrown for the caller to answer with a 5xx so that Razorpay retries.
async function storeEvent(db, { externalEventId, eventType, entityType, entityId, occurredAt, payload, status, lastError }) {
  try {
    await db.integrationInbox.create({
      data: {
        source: SOURCE,
        externalEventId,
        eventType: eventType.slice(0, 64),
        entityType,
        entityId,
        externalOccurredAt: occurredAt,
        payload,
        status,
        lastError,
        nextAttemptAt: new Date(0), // due at once: no application clock involved
        ...(status === 'ignored' ? { processedAt: new Date() } : {}),
      },
    });
    return { stored: true };
  } catch (err) {
    if (err && err.code === 'P2002') return { stored: false, duplicate: true };
    throw err;
  }
}

// True when an event for the same entity (order or refund) with exactly the same body fingerprint is already stored. The event id header is NOT
// signed, so a signed body replayed with a different id header would otherwise be stored a second time; the fingerprint of the signed bytes
// closes that. Narrowed by (source, entity type, entity id) first, so it only ever looks at a handful of rows.
async function bodyAlreadyStored(db, { entityType, entityId, bodySha256 }) {
  if (!entityType || !entityId) return false;
  const rows = await db.integrationInbox.findMany({ where: { source: SOURCE, entityType, entityId }, select: { payload: true }, take: 200 });
  return rows.some((row) => row && row.payload && row.payload.bodySha256 === bodySha256);
}

// ---- the worker half: claim, lease, fenced result, retry, recovery -------------------------------------------------------------------------
// Same rules as the Bitrix inbox (M6 design) and the same CLOCK rule: every lease and every scheduling comparison is made by the database with its own
// UTC clock (UTC_TIMESTAMP(3)), never with the application clock and never mixed with MySQL's session-local NOW(), so workers on hosts with
// different clocks agree. That is why these statements are raw SQL. EVERY statement is restricted to source = 'razorpay': this store can neither claim,
// finish nor recover an event of any other source (a Bitrix24 event, for example), whatever id it is given.
//
// Row states (the existing schema; nothing is added):
//   received    waiting. Due when next_attempt_at has passed and no live lease exists.
//   processing  claimed: locked_by / locked_until hold the lease; attempts counts claims (a crash mid-event still used one).
//   processed   final: applied.            ignored   final: nothing to apply.            failed   final: gave up (an alert is the caller's job).
// A final row is never claimed again, so an event is never applied twice.
//
// THE FENCE: a result is ONE UPDATE that checks id, source, status "processing", the attempts value this worker claimed, locked_by, AND that the lease
// has not expired (locked_until in the future). Zero rows written means the lease was lost (it expired, or a newer worker holds the event): the
// caller must write nothing else. So a stalled worker can never overwrite the result of the worker that took over.
//
// Nothing here logs and nothing here reads or writes a Payment: applying an event is the caller's job. `db` is the Prisma client or a transaction;
// writeResult is meant to run in the SAME transaction as the changes the event causes, so the result and the changes commit or roll back together.
const LEASE_SECONDS = 120; // how long a claim is held before another worker may take the event over
const MAX_ATTEMPTS = 8; // claims an event may use; the 8th unsuccessful attempt is final (same policy as the Bitrix inbox)
const BATCH_SIZE = 10; // events a worker pass claims
const MAX_ERROR_LENGTH = 200;
const MAX_DELAY_SECONDS = 24 * 60 * 60;
const FINAL_STATUSES = Object.freeze(['processed', 'ignored', 'failed']);
const RESULT_STATUSES = Object.freeze([...FINAL_STATUSES, 'received']);
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const isCount = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Delay before an unsuccessful event is tried again: 60 s per attempt, at most 15 minutes (the Bitrix inbox rule).
const retryDelaySeconds = (attempts) => Math.min(60 * Math.max(1, attempts), 900);

// last_error holds a short code only: letters, digits and a few separators, capped. Never free text.
function cleanCode(text) {
  if (text === null || text === undefined) return null;
  return String(text).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, MAX_ERROR_LENGTH);
}

// The stored payload as an object: a JSON column read through raw SQL may come back parsed or as text.
function readPayload(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

// Ids of Razorpay events that are due: waiting, past their scheduled time and with no live lease, oldest first.
async function findDueIds(db, limit = BATCH_SIZE) {
  if (!isCount(limit, 1, 100)) throw new RangeError('limit must be a whole number from 1 to 100');
  const rows = await db.$queryRaw`
    SELECT id FROM integration_inbox
    WHERE source = ${SOURCE} AND status = 'received'
      AND next_attempt_at <= UTC_TIMESTAMP(3)
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
    ORDER BY id
    LIMIT ${limit}`;
  return rows.map((row) => Number(row.id));
}

// Compare-and-swap claim. Resolves the claim, or null when the event is not claimable (not a Razorpay event, not waiting, not due, leased, or another
// worker got there first). The claim carries what the processor needs and nothing the receiver did not already allow-list.
async function claim(db, { id, workerId, leaseSeconds = LEASE_SECONDS }) {
  if (!isCount(id, 1, Number.MAX_SAFE_INTEGER)) throw new RangeError('id must be a positive whole number');
  if (typeof workerId !== 'string' || !WORKER_ID.test(workerId)) throw new RangeError('workerId must be a short identifier');
  if (!isCount(leaseSeconds, 1, 3600)) throw new RangeError('leaseSeconds must be a whole number from 1 to 3600');
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, attempts, external_event_id, event_type, entity_type, entity_id, external_occurred_at, payload FROM integration_inbox
      WHERE id = ${id} AND source = ${SOURCE} AND status = 'received' AND next_attempt_at <= UTC_TIMESTAMP(3)
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
      FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    const changed = await tx.$executeRaw`
      UPDATE integration_inbox
      SET status = 'processing', attempts = attempts + 1, locked_by = ${workerId},
          locked_until = UTC_TIMESTAMP(3) + INTERVAL ${leaseSeconds} SECOND, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ${id} AND source = ${SOURCE} AND status = 'received' AND attempts = ${row.attempts}
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
    if (Number(changed) !== 1) return null;
    return {
      id: Number(row.id),
      workerId,
      attempts: Number(row.attempts) + 1,
      externalEventId: String(row.external_event_id),
      eventType: String(row.event_type),
      entityType: row.entity_type == null ? null : String(row.entity_type),
      entityId: row.entity_id == null ? null : String(row.entity_id),
      occurredAt: row.external_occurred_at ?? null,
      payload: readPayload(row.payload),
    };
  });
}

// The FENCED result write: "processed" | "ignored" | "failed" (final) or "received" (try again after delaySeconds). Resolves the number of rows written:
// 1 = recorded, 0 = the lease was lost and NOTHING was written. last_error is a short sanitised code.
async function writeResult(db, claimed, { status, lastError = null, delaySeconds = 0 }) {
  if (!RESULT_STATUSES.includes(status)) throw new RangeError('status is not a result status');
  if (!isCount(delaySeconds, 0, MAX_DELAY_SECONDS)) throw new RangeError('delaySeconds must be a whole number from 0 to 86400');
  if (!claimed || !isCount(claimed.id, 1, Number.MAX_SAFE_INTEGER) || !isCount(claimed.attempts, 1, 1000) || typeof claimed.workerId !== 'string') throw new TypeError('a claim is required');
  const changed = await db.$executeRaw`
    UPDATE integration_inbox
    SET status = ${status}, last_error = ${cleanCode(lastError)},
        next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND,
        processed_at = CASE WHEN ${status} IN ('processed', 'ignored', 'failed') THEN UTC_TIMESTAMP(3) ELSE processed_at END,
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND source = ${SOURCE} AND status = 'processing' AND attempts = ${claimed.attempts} AND locked_by = ${claimed.workerId}
      AND locked_until > UTC_TIMESTAMP(3)`;
  return Number(changed);
}

// Locks THIS worker's claim and confirms it is still valid: the row is "processing", for the attempts value this worker claimed, owned by it, with a live lease
// (database clock). Resolves true or false. It is the FIRST statement of a processing transaction: a worker that has already lost its lease learns it
// before it changes anything, and while the transaction runs nobody else can take the event over or finish it. The lock is on the inbox row only, taken
// before any invoice or payment row (nothing that locks an invoice ever waits for an inbox row), so it cannot take part in a deadlock.
async function holdLease(db, claimed) {
  if (!claimed || !isCount(claimed.id, 1, Number.MAX_SAFE_INTEGER) || !isCount(claimed.attempts, 1, 1000) || typeof claimed.workerId !== 'string') throw new TypeError('a claim is required');
  const rows = await db.$queryRaw`
    SELECT id FROM integration_inbox
    WHERE id = ${claimed.id} AND source = ${SOURCE} AND status = 'processing' AND attempts = ${claimed.attempts} AND locked_by = ${claimed.workerId}
      AND locked_until > UTC_TIMESTAMP(3)
    FOR UPDATE`;
  return rows.length === 1;
}

// An unsuccessful attempt: schedule the retry, or, once the claim used the last allowed attempt, record the FINAL failure. Resolves
// { status: "received" | "failed", delaySeconds, written } where written is the fenced row count (0 = lease lost, nothing written).
async function retryOrFail(db, claimed, { code }) {
  const exhausted = claimed.attempts >= MAX_ATTEMPTS;
  const status = exhausted ? 'failed' : 'received';
  const delaySeconds = exhausted ? 0 : retryDelaySeconds(claimed.attempts);
  const written = await writeResult(db, claimed, { status, lastError: code, delaySeconds });
  return { status, delaySeconds, written };
}

// Expired leases: applying an event is idempotent by design, so an event whose worker died simply returns to "received" (due now); one that has used
// every attempt becomes "failed" instead. Only Razorpay rows are looked at. Resolves { failed, again } (row counts).
async function recoverExpiredLeases(db, { maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!isCount(maxAttempts, 1, 1000)) throw new RangeError('maxAttempts must be a whole number from 1 to 1000');
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

module.exports = {
  storeEvent, bodyAlreadyStored, findDueIds, claim, holdLease, writeResult, retryOrFail, recoverExpiredLeases, retryDelaySeconds, cleanCode, readPayload,
  SOURCE, LEASE_SECONDS, MAX_ATTEMPTS, BATCH_SIZE, FINAL_STATUSES, RESULT_STATUSES,
};
