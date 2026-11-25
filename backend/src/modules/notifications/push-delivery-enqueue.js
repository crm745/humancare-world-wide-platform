// enqueuePushDeliveries(tx, notification): creates the PUSH DELIVERY rows (notification_deliveries) of ONE persisted patient notification, one per
// eligible active device of the patient. It is the only thing that puts work in front of the push delivery worker (push-delivery.service.js); it
// sends nothing itself.
//
// It must be called INSIDE the transaction that created the notification (the caller's Prisma transaction client is passed in), so that the
// notification and its deliveries commit or roll back together. It never opens a transaction of its own and refuses the shared Prisma client.
// Nothing calls it yet: wiring it into the three senders is a later phase.
//
// Who the recipient is. The ONLY thing taken from the argument is the notification's id. The notification is read again from the database and
// everything else (recipient type and id, kind, mandatory flag, deleted flag, creation time) comes from that stored row, so a caller cannot name
// another recipient or hand in a stale or doctored object.
//
// Eligibility (otherwise nothing is created and the reason is reported):
//   * the notification exists, is not soft-deleted, is a PATIENT notification of a catalogue kind that patients may receive;
//   * the patient's push preference is ON, unless the notification is MANDATORY. Mandatory means BOTH the catalogue says so for its kind (today:
//     security and payment kinds only; quotation_ready is NOT mandatory) AND the stored snapshot flag is set. `inAppEnabled` is never read:
//     switching the in-app list off does not stop a push. A patient with no preference row has the default (ON).
//   * devices: every NotificationDevice that is ACTIVE, owned by this patient (owner type "patient" and the notification's recipient id) and was
//     last registered no later than the notification was created. A device registered afterwards is a new device: it never receives an old
//     notification, not even when this helper is called again later for the same notification.
//
// Idempotency. One row per (notification, channel "push", destination "device:<NotificationDevice.id>"): the unique index
// notification_deliveries_dest_key. Rows already there are counted and left untouched (history is never changed or deleted). A concurrent
// duplicate is settled by that index: a unique violation on exactly that index proves the row exists and is counted, every other error is rethrown.
//
// Secrets. The Expo push token is never selected, copied, returned or logged by this module (only device row ids are read). The delivery row keeps
// only the device reference; the worker reads the token from the device at send time. No network, no User.pushToken, no Expo.

const catalogue = require('./notification-catalogue');

const PATIENT = 'patient';
const CHANNEL = 'push';
const PROVIDER = 'expo';

function enqueueError(code, message) {
  const err = new Error(message || code);
  err.name = 'PushEnqueueError';
  err.code = code;
  return err;
}

// A real Prisma transaction client has no $transaction (the shared client has): this refuses the shared client, so the caller cannot enqueue
// outside the transaction of its notification by accident.
function assertTransaction(tx) {
  const has = (model, fn) => tx && tx[model] && typeof tx[model][fn] === 'function';
  const complete = has('notification', 'findUnique') && has('notificationPreference', 'findUnique') && has('notificationDevice', 'findMany')
    && has('notificationDelivery', 'findMany') && has('notificationDelivery', 'create');
  if (!complete) throw enqueueError('tx_invalid', 'enqueuePushDeliveries needs a Prisma transaction client.');
  if (typeof tx.$transaction === 'function') throw enqueueError('tx_required', 'enqueuePushDeliveries must run inside the notification\'s own transaction, not on the shared client.');
}

// A unique violation of the delivery destination index (and no other constraint).
function isDestinationConflict(err) {
  if (!err || err.code !== 'P2002') return false;
  const target = err.meta && err.meta.target;
  return /dest_key/i.test(Array.isArray(target) ? target.join(',') : String(target || ''));
}

const skipped = (notificationId, reason) => ({ notificationId, enqueued: 0, alreadyQueued: 0, skipped: reason });

/**
 * @param {object} tx            the caller's Prisma TRANSACTION client
 * @param {{ id: number }} notification   the persisted notification (only its id is used)
 * @returns {Promise<{ notificationId: number|null, enqueued: number, alreadyQueued: number, skipped: string|null }>}
 *          skipped is null when the notification was eligible and had active devices; otherwise a short reason code. Never holds a token.
 */
async function enqueuePushDeliveries(tx, notification) {
  assertTransaction(tx);
  const id = notification && notification.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw enqueueError('notification_id_invalid', 'A persisted notification with a positive id is required.');

  const row = await tx.notification.findUnique({
    where: { id },
    select: { id: true, recipientType: true, recipientId: true, kind: true, isMandatory: true, deletedAt: true, createdAt: true },
  });
  if (!row) return skipped(id, 'notification_not_found');
  if (row.deletedAt) return skipped(id, 'notification_deleted');
  if (row.recipientType !== PATIENT) return skipped(id, 'recipient_not_patient');
  if (!Number.isSafeInteger(row.recipientId) || row.recipientId <= 0) return skipped(id, 'recipient_invalid');
  if (!catalogue.validateKindForRecipient(row.kind, PATIENT).ok) return skipped(id, 'kind_not_eligible');

  const mandatory = row.isMandatory === true && catalogue.classifyMandatory(row.kind) === true;
  if (!mandatory) {
    const preference = await tx.notificationPreference.findUnique({
      where: { ownerType_ownerId: { ownerType: PATIENT, ownerId: row.recipientId } },
      select: { pushEnabled: true },
    });
    if (preference && preference.pushEnabled === false) return skipped(id, 'push_disabled'); // no row = the default (ON)
  }

  // Only ids: the token is never read here.
  const devices = await tx.notificationDevice.findMany({
    where: { ownerType: PATIENT, ownerId: row.recipientId, status: 'active', lastRegisteredAt: { lte: row.createdAt } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (devices.length === 0) return skipped(id, 'no_active_devices');

  const existing = await tx.notificationDelivery.findMany({ where: { notificationId: row.id, channel: CHANNEL }, select: { destinationKey: true } });
  const queued = new Set(existing.map((d) => d.destinationKey));

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const device of devices) {
    const destinationKey = `device:${device.id}`;
    if (queued.has(destinationKey)) { alreadyQueued += 1; continue; }
    try {
      await tx.notificationDelivery.create({
        data: {
          notificationId: row.id, recipientType: PATIENT, recipientId: row.recipientId, channel: CHANNEL, provider: PROVIDER,
          deviceId: device.id, destinationKey,
        },
        select: { id: true },
      });
      enqueued += 1;
    } catch (err) {
      if (!isDestinationConflict(err)) throw err; // anything else is a real problem: the caller's transaction rolls back
      alreadyQueued += 1; // the unique index says the row exists (another transaction just wrote it)
    }
  }
  return { notificationId: row.id, enqueued, alreadyQueued, skipped: null };
}

// The explicit "queue nothing" dependency for a run that must never create push deliveries (a scoped or synthetic Bitrix detection, an operator script
// with --no-push). It has the same shape as enqueuePushDeliveries, touches nothing and reads nothing: a caller passes it as `enqueuePush`.
async function suppressedEnqueuePush(_tx, notification) {
  return { notificationId: notification && Number.isSafeInteger(notification.id) ? notification.id : null, enqueued: 0, alreadyQueued: 0, skipped: 'suppressed' };
}

module.exports = { enqueuePushDeliveries, suppressedEnqueuePush, isDestinationConflict };
