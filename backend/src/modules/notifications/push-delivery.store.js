// The database half of the push delivery worker: claiming, fencing, recovery and expiry of "push" rows of notification_deliveries (and the
// history rows in notification_delivery_attempts). Same design as bitrix/deal-outbox.store.js: every statement that touches a lease or a
// deadline is raw SQL, because the lease is SET and CHECKED with the database's own UTC clock (UTC_TIMESTAMP(3)); ordinary Prisma updates use the
// application clock, which must not be mixed with it. Nothing here calls Expo.
//
// `db` is the Prisma client or a transaction client.
//
// THE FENCE. Every write a worker makes about a delivery it claimed is ONE UPDATE that checks the id, the status it expects ('sending' for a send,
// 'accepted' for a receipt check), `locked_by` (this worker) and `locked_until` still in the future. Rows written = 1 means this worker still owned
// the row; 0 means it was cancelled (device registry: ownership transfer, unregister), expired or reclaimed meanwhile, and the worker writes
// NOTHING else about the delivery. A cancelled or reclaimed delivery is therefore never overwritten.
//
// ATTEMPTS. attempt_count is the number of attempts that COUNT toward the limit of three. beginAttempt increments it and inserts the attempt row
// ("started") in ONE transaction, and only while the lease is held and will outlive the request. A "started" attempt is the evidence that a request
// may have left the process: a lease that expires while one is "started" ends in "uncertain", never in a re-send.
// An attempt that Expo answered with HTTP 401/403 (the ACCESS TOKEN was rejected: a problem of the whole worker, not of this delivery) is VOIDED:
// its attempt row is kept as history (failed, expo_unauthorized) but the delivery gets the attempt back (refundAttempt), so a credential problem
// never uses up a delivery's three attempts. Because of that, attempt_count can be lower than the number of attempt rows, so the number of a new
// attempt row is the highest existing number + 1 (never attempt_count + 1), and "the latest attempt" means the highest number.
//
// Nothing here stores or logs an Expo push token: a delivery holds only a reference to the device row.

const { SYNTHETIC_IDENTITY_PREFIX } = require('./push-delivery.config'); // the synthetic E2E identity is never contacted
const MAX_TEXT = 300;

const SEND_STATUSES = new Set(['accepted', 'pending', 'failed', 'uncertain', 'cancelled']);
const RECEIPT_STATUSES = new Set(['accepted', 'delivered', 'failed', 'uncertain']);

const marks = (list) => list.map(() => '?').join(', ');

// last_error / error_message: short, no URL, no push token.
function cleanText(text) {
  if (text == null) return null;
  return String(text).replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, '[token]').replace(/https?:\/\/\S+/gi, '[url]').slice(0, MAX_TEXT);
}

// ---- sending ---------------------------------------------------------------------------------------------------------------------------------

// Ids of due, unclaimed push deliveries. A delivery whose notification belongs to a synthetic E2E identity is never offered.
async function findDueIds(db, limit) {
  const rows = await db.$queryRaw`
    SELECT d.id AS id
    FROM notification_deliveries d
    WHERE d.channel = 'push'
      AND d.status = 'pending'
      AND d.next_attempt_at <= UTC_TIMESTAMP(3)
      AND (d.locked_until IS NULL OR d.locked_until <= UTC_TIMESTAMP(3))
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        JOIN service_requests sr ON sr.id = n.service_request_id
        WHERE n.id = d.notification_id AND sr.patient_name LIKE ${`${SYNTHETIC_IDENTITY_PREFIX}%`}
      )
    ORDER BY d.next_attempt_at, d.id
    LIMIT ${limit}`;
  return rows.map((row) => Number(row.id));
}

// Takes one delivery with a single compare-and-swap UPDATE. Two workers (or two passes) racing for the same id: exactly one UPDATE matches.
// Returns { id, workerId } or null.
async function claim(db, { id, workerId, leaseSeconds }) {
  const changed = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = 'sending', locked_by = ${workerId},
        locked_until = UTC_TIMESTAMP(3) + INTERVAL ${leaseSeconds} SECOND, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${id} AND channel = 'push' AND status = 'pending'
      AND next_attempt_at <= UTC_TIMESTAMP(3)
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
  return Number(changed) === 1 ? { id, workerId } : null;
}

// Everything the worker re-checks right before sending, in ordinary reads (no clock involved). The device's token is read here, at send time,
// and only here.
async function loadForSend(db, id) {
  return db.notificationDelivery.findUnique({
    where: { id },
    select: {
      id: true, status: true, lockedBy: true, channel: true, notificationId: true, recipientType: true, recipientId: true,
      attemptCount: true, deviceId: true, destinationKey: true, createdAt: true, // createdAt: the start of the 24 h window the Expo TTL is counted in
      notification: {
        select: {
          id: true, recipientType: true, recipientId: true, title: true, body: true, data: true, serviceRequestId: true, isMandatory: true, deletedAt: true,
          serviceRequest: { select: { patientName: true } },
        },
      },
      device: { select: { id: true, ownerType: true, ownerId: true, status: true, expoPushToken: true } },
    },
  });
}

async function loadPatientPushPreference(db, patientId) {
  const row = await db.notificationPreference.findUnique({
    where: { ownerType_ownerId: { ownerType: 'patient', ownerId: patientId } },
    select: { pushEnabled: true },
  });
  return row ? row.pushEnabled : true; // no row = the default (ON)
}

// Starts an attempt: counts it and writes its "started" row, together, only while this worker holds the lease and the lease will outlive the
// request. The row's number is the highest existing number + 1 (see ATTEMPTS above). Returns { attemptNumber, attemptCount } (the counted
// attempt, 1 to 3) or null (the lease is gone or too short: nothing was written, nothing may be sent).
async function beginAttempt(db, claimed, { attemptCount, minLeaseLeftSeconds }) {
  return db.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE notification_deliveries
      SET attempt_count = attempt_count + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ${claimed.id} AND status = 'sending' AND locked_by = ${claimed.workerId} AND attempt_count = ${attemptCount}
        AND locked_until > UTC_TIMESTAMP(3) + INTERVAL ${minLeaseLeftSeconds} SECOND`;
    if (Number(changed) !== 1) return null;
    const last = await tx.notificationDeliveryAttempt.findFirst({ where: { deliveryId: claimed.id }, orderBy: { attemptNumber: 'desc' }, select: { attemptNumber: true } });
    const attemptNumber = (last ? last.attemptNumber : 0) + 1;
    await tx.notificationDeliveryAttempt.create({ data: { deliveryId: claimed.id, attemptNumber, status: 'started', provider: 'expo' } });
    return { attemptNumber, attemptCount: attemptCount + 1 };
  });
}

// The fenced result of a send (or of a cancellation before any attempt). One UPDATE; the lease is released.
//   accepted   the ticket id is kept; the first receipt check is due after `receiptDelaySeconds`
//   pending    a retry, due after `delaySeconds`. With `refundAttempt` the attempt is given back (a voided attempt, see ATTEMPTS)
//   failed / cancelled / uncertain   terminal (closed_at set)
// Returns the number of rows written: 1 = recorded, 0 = this worker no longer owned the delivery and wrote nothing.
async function writeSendOutcome(db, claimed, { status, code = null, message = null, ticketId = null, delaySeconds = 0, receiptDelaySeconds = 0, refundAttempt = false }) {
  if (!SEND_STATUSES.has(status)) throw new Error(`Not a send outcome: ${status}`);
  const refund = refundAttempt === true && status === 'pending' ? 1 : 0;
  const changed = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = ${status}, last_error_code = ${code}, last_error = ${cleanText(message)},
        attempt_count = CASE WHEN ${refund} = 1 THEN GREATEST(attempt_count - 1, 0) ELSE attempt_count END,
        provider_message_id = COALESCE(${ticketId}, provider_message_id),
        accepted_at = CASE WHEN ${status} = 'accepted' THEN UTC_TIMESTAMP(3) ELSE accepted_at END,
        closed_at = CASE WHEN ${status} IN ('failed', 'cancelled', 'uncertain') THEN UTC_TIMESTAMP(3) ELSE closed_at END,
        next_attempt_at = CASE WHEN ${status} = 'accepted' THEN UTC_TIMESTAMP(3) + INTERVAL ${receiptDelaySeconds} SECOND
                               WHEN ${status} = 'pending' THEN UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND
                               ELSE next_attempt_at END,
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND status = 'sending' AND locked_by = ${claimed.workerId} AND locked_until > UTC_TIMESTAMP(3)`;
  return Number(changed);
}

// Finishes the attempt row ("started" -> accepted / failed / uncertain). Only a "started" row is ever changed; a finished one is history.
function finishAttempt(db, deliveryId, attemptNumber, { status, ticketId = null, code = null, message = null }) {
  return db.notificationDeliveryAttempt.updateMany({
    where: { deliveryId, attemptNumber, status: 'started' },
    data: { status, providerMessageId: ticketId, errorCode: code, errorMessage: cleanText(message), finishedAt: new Date() },
  });
}

// The delivery result and the attempt result together: after a crash in between, the two can never disagree. The attempt is finished even if
// the fence was lost (the history must say what Expo answered); only the delivery write is fenced. Returns the delivery rows written (1 or 0).
async function recordAttemptOutcome(db, claimed, attemptNumber, outcome) {
  const attemptStatus = outcome.status === 'accepted' ? 'accepted' : outcome.status === 'uncertain' ? 'uncertain' : 'failed';
  return db.$transaction(async (tx) => {
    const written = await writeSendOutcome(tx, claimed, outcome);
    await finishAttempt(tx, claimed.id, attemptNumber, {
      status: attemptStatus, ticketId: outcome.ticketId || null, code: outcome.code || null, message: outcome.message || null,
    });
    return written;
  });
}

// ---- recovery and expiry ---------------------------------------------------------------------------------------------------------------------

// Expired leases, never by the expired worker (each statement is a compare-and-swap on the status and the expiry). The LATEST attempt (the one with
// the highest number) tells what the dead or late worker got as far as:
//   (a) it was ACCEPTED by Expo (the worker's lease ran out before it could write the result): the delivery adopts that ticket and becomes
//       'accepted', so its receipt is still checked. It is never sent again.
//   (b) it is "started" or 'uncertain' (a request may have left): the delivery is 'uncertain' (reconciliation by a person, never a re-send).
//   (c) no attempt was started this time (or it ended in a failure that is safe to repeat): back to 'pending'.
//   (d) a "started" attempt older than the lease (its worker is gone, or the delivery was cancelled meanwhile) -> its attempt row is 'uncertain'.
//   (e) an 'accepted' delivery whose receipt-check lease expired -> the lease is released (it is checked again).
// The statements run in this order on purpose: (a) and (b) must see the attempts before (c) can put a delivery back.
async function recoverExpiredLeases(db, { leaseSeconds, receiptDelaySeconds }) {
  const adopted = await db.$executeRaw`
    UPDATE notification_deliveries d
    JOIN notification_delivery_attempts a ON a.delivery_id = d.id
      AND a.attempt_number = (SELECT MAX(x.attempt_number) FROM notification_delivery_attempts x WHERE x.delivery_id = d.id)
    SET d.status = 'accepted', d.provider_message_id = a.provider_message_id, d.accepted_at = UTC_TIMESTAMP(3), d.last_error_code = NULL,
        d.next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ${receiptDelaySeconds} SECOND,
        d.locked_by = NULL, d.locked_until = NULL, d.updated_at = UTC_TIMESTAMP(3)
    WHERE d.channel = 'push' AND d.status = 'sending' AND d.locked_until <= UTC_TIMESTAMP(3)
      AND a.status = 'accepted' AND a.provider_message_id IS NOT NULL`;
  const uncertain = await db.$executeRaw`
    UPDATE notification_deliveries d
    SET d.status = 'uncertain', d.last_error_code = 'lease_expired_during_send', d.closed_at = UTC_TIMESTAMP(3),
        d.locked_by = NULL, d.locked_until = NULL, d.updated_at = UTC_TIMESTAMP(3)
    WHERE d.channel = 'push' AND d.status = 'sending' AND d.locked_until <= UTC_TIMESTAMP(3)
      AND EXISTS (
        SELECT 1 FROM notification_delivery_attempts a
        WHERE a.delivery_id = d.id AND (a.status = 'started'
          OR (a.status = 'uncertain' AND a.attempt_number = (SELECT MAX(x.attempt_number) FROM notification_delivery_attempts x WHERE x.delivery_id = d.id)))
      )`;
  const pending = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = 'pending', next_attempt_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE channel = 'push' AND status = 'sending' AND locked_until <= UTC_TIMESTAMP(3)`;
  const attempts = await db.$executeRaw`
    UPDATE notification_delivery_attempts
    SET status = 'uncertain', error_code = 'lease_expired', finished_at = UTC_TIMESTAMP(3)
    WHERE status = 'started' AND started_at <= UTC_TIMESTAMP(3) - INTERVAL ${leaseSeconds + 60} SECOND`;
  const receipts = await db.$executeRaw`
    UPDATE notification_deliveries
    SET locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE channel = 'push' AND status = 'accepted' AND locked_until IS NOT NULL AND locked_until <= UTC_TIMESTAMP(3)`;
  return { adopted: Number(adopted), uncertain: Number(uncertain), pending: Number(pending), attempts: Number(attempts), receipts: Number(receipts) };
}

// A delivery still PENDING `expiryHours` after it was created is closed and never sent: 'cancelled' if no attempt was ever made, 'failed' if it
// was tried and kept failing. An 'accepted' delivery that never got a receipt within `receiptMaxAgeHours` (Expo clears receipts after 24 h) is
// 'uncertain'. Rows being worked on (a live lease) are left to their worker.
async function expireStale(db, { expiryHours, receiptMaxAgeHours }) {
  const cancelled = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = 'cancelled', last_error_code = 'expired', closed_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE channel = 'push' AND status = 'pending' AND attempt_count = 0
      AND created_at <= UTC_TIMESTAMP(3) - INTERVAL ${expiryHours} HOUR
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
  const failed = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = 'failed', last_error_code = 'expired', closed_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE channel = 'push' AND status = 'pending' AND attempt_count > 0
      AND created_at <= UTC_TIMESTAMP(3) - INTERVAL ${expiryHours} HOUR
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
  const receiptExpired = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = 'uncertain', last_error_code = 'receipt_expired', closed_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE channel = 'push' AND status = 'accepted' AND accepted_at <= UTC_TIMESTAMP(3) - INTERVAL ${receiptMaxAgeHours} HOUR
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`;
  return { cancelled: Number(cancelled), failed: Number(failed), receiptExpired: Number(receiptExpired) };
}

// ---- receipts --------------------------------------------------------------------------------------------------------------------------------

// Ids of 'accepted' deliveries whose receipt check is due and that nobody is checking. Terminal rows are never offered.
async function findReceiptDueIds(db, limit) {
  const rows = await db.$queryRaw`
    SELECT id FROM notification_deliveries
    WHERE channel = 'push' AND status = 'accepted' AND provider_message_id IS NOT NULL
      AND next_attempt_at <= UTC_TIMESTAMP(3)
      AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))
    ORDER BY next_attempt_at, id
    LIMIT ${limit}`;
  return rows.map((row) => Number(row.id));
}

// Leases the given ids for a receipt check (the same compare-and-swap, status stays 'accepted'), then returns the rows this worker now holds.
async function claimReceipts(db, ids, { workerId, leaseSeconds }) {
  if (ids.length === 0) return [];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Receipt claim needs positive whole ids.');
  await db.$executeRawUnsafe(
    `UPDATE notification_deliveries
     SET locked_by = ?, locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND, updated_at = UTC_TIMESTAMP(3)
     WHERE id IN (${marks(ids)}) AND channel = 'push' AND status = 'accepted' AND provider_message_id IS NOT NULL
       AND next_attempt_at <= UTC_TIMESTAMP(3) AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`,
    workerId, leaseSeconds, ...ids,
  );
  return db.notificationDelivery.findMany({
    where: { id: { in: ids }, status: 'accepted', lockedBy: workerId },
    select: { id: true, providerMessageId: true, deviceId: true, recipientId: true },
  });
}

// The fenced result of a receipt check. 'accepted' = still waiting: look again after `delaySeconds`. delivered / failed / uncertain are terminal.
// 0 rows written = the lease was lost; nothing else is written.
async function writeReceiptOutcome(db, claimed, { status, code = null, message = null, delaySeconds = 0 }) {
  if (!RECEIPT_STATUSES.has(status)) throw new Error(`Not a receipt outcome: ${status}`);
  const changed = await db.$executeRaw`
    UPDATE notification_deliveries
    SET status = ${status}, last_error_code = ${code}, last_error = ${cleanText(message)},
        delivered_at = CASE WHEN ${status} = 'delivered' THEN UTC_TIMESTAMP(3) ELSE delivered_at END,
        closed_at = CASE WHEN ${status} IN ('delivered', 'failed', 'uncertain') THEN UTC_TIMESTAMP(3) ELSE closed_at END,
        next_attempt_at = CASE WHEN ${status} = 'accepted' THEN UTC_TIMESTAMP(3) + INTERVAL ${delaySeconds} SECOND ELSE next_attempt_at END,
        locked_by = NULL, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
    WHERE id = ${claimed.id} AND status = 'accepted' AND locked_by = ${claimed.workerId} AND locked_until > UTC_TIMESTAMP(3)`;
  return Number(changed);
}

// When the latest attempt of a delivery started (the application clock, like the row itself).
async function latestAttemptStart(db, deliveryId) {
  const row = await db.notificationDeliveryAttempt.findFirst({ where: { deliveryId }, orderBy: { attemptNumber: 'desc' }, select: { startedAt: true } });
  return row ? row.startedAt : null;
}

// ---- devices ---------------------------------------------------------------------------------------------------------------------------------

// A send was told "DeviceNotRegistered" for `token`: deactivate that device, but only if it still holds that very token (a device that has since
// registered a new token is fine). Returns the rows changed.
async function deactivateDeviceForToken(db, deviceRowId, token) {
  const { count } = await db.notificationDevice.updateMany({
    where: { id: deviceRowId, status: 'active', expoPushToken: token },
    data: { status: 'inactive', disabledAt: new Date() },
  });
  return count;
}

// A RECEIPT said "DeviceNotRegistered". The token is not kept, so the guard is time: deactivate only a device that has not registered again since
// the attempt started (a device that re-registered after the send has a new, unproven token and stays active).
async function deactivateDeviceUnchangedSince(db, deviceRowId, attemptStartedAt) {
  const { count } = await db.notificationDevice.updateMany({
    where: { id: deviceRowId, status: 'active', lastRegisteredAt: { lte: attemptStartedAt } },
    data: { status: 'inactive', disabledAt: new Date() },
  });
  return count;
}

// After a device is deactivated: its other open deliveries will never be sendable.
async function cancelOpenDeliveriesForDevice(db, deviceRowId, code, exceptId) {
  const { count } = await db.notificationDelivery.updateMany({
    where: { deviceId: deviceRowId, status: { in: ['pending', 'sending'] }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    data: { status: 'cancelled', closedAt: new Date(), lockedBy: null, lockedUntil: null, lastErrorCode: code },
  });
  return count;
}

// ---- monitoring ------------------------------------------------------------------------------------------------------------------------------

// Aggregate counts for the operational summary (push-delivery.monitor.js). ONE read-only SELECT: no row is written, nothing identifies a delivery,
// a patient or a device. Open work (pending / sending / accepted) is counted whatever its age; failed, uncertain and expired deliveries only when
// they were closed within the last `windowHours`. "expired" = closed by the 24 h expiry (last_error_code 'expired'); it is not also counted as failed.
// oldestPendingSeconds: the age of the oldest pending delivery (null when nothing is pending).
async function deliveryMetrics(db, { windowHours = 24 } = {}) {
  const hours = Number.isSafeInteger(windowHours) && windowHours > 0 ? windowHours : 24;
  const rows = await db.$queryRaw`
    SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'sending' THEN 1 END) AS sending,
      COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted,
      COUNT(CASE WHEN status = 'failed' AND closed_at > UTC_TIMESTAMP(3) - INTERVAL ${hours} HOUR
                  AND (last_error_code IS NULL OR last_error_code <> 'expired') THEN 1 END) AS failed,
      COUNT(CASE WHEN status = 'uncertain' AND closed_at > UTC_TIMESTAMP(3) - INTERVAL ${hours} HOUR THEN 1 END) AS uncertain,
      COUNT(CASE WHEN last_error_code = 'expired' AND closed_at > UTC_TIMESTAMP(3) - INTERVAL ${hours} HOUR THEN 1 END) AS expired,
      TIMESTAMPDIFF(SECOND, MIN(CASE WHEN status = 'pending' THEN created_at END), UTC_TIMESTAMP(3)) AS oldest_pending_seconds
    FROM notification_deliveries
    WHERE channel = 'push'
      AND (status IN ('pending', 'sending', 'accepted') OR closed_at > UTC_TIMESTAMP(3) - INTERVAL ${hours} HOUR)`;
  const r = rows && rows[0] ? rows[0] : {};
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));
  return {
    pending: n(r.pending), sending: n(r.sending), accepted: n(r.accepted), failed: n(r.failed), uncertain: n(r.uncertain), expired: n(r.expired),
    oldestPendingSeconds: r.oldest_pending_seconds === null || r.oldest_pending_seconds === undefined ? null : Math.max(0, Number(r.oldest_pending_seconds)),
  };
}

module.exports = {
  SYNTHETIC_IDENTITY_PREFIX, cleanText,
  findDueIds, claim, loadForSend, loadPatientPushPreference, beginAttempt, writeSendOutcome, finishAttempt, recordAttemptOutcome,
  recoverExpiredLeases, expireStale,
  findReceiptDueIds, claimReceipts, writeReceiptOutcome, latestAttemptStart,
  deactivateDeviceForToken, deactivateDeviceUnchangedSince, cancelOpenDeliveriesForDevice,
  deliveryMetrics,
};
