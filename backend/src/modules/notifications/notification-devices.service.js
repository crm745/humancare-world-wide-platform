// Patient push-device registry: register and unregister one app installation.
//
// Patient only. The owner is ALWAYS the authenticated patient's User id, handed in by the controller from `req.user.id`;
// no function here reads an owner (type or id) from a request body, query or route. Corporate devices are not handled.
//
// Model (see NotificationDevice in schema.prisma): one row per app installation (`deviceId`, an app-generated UUID, globally
// unique) holding the CURRENT owner and the CURRENT Expo push token (globally unique). The row is never duplicated for an
// installation: another account signing in on the same installation takes the SAME row over, and a new Expo token for the
// same installation replaces the old one on that row. A device is deactivated (status "inactive", disabledAt), never deleted.
//
// Registration, in one transaction:
//   1. read the row for this deviceId and the row (if any) that currently holds this Expo token;
//   2. a row that holds the token but is a DIFFERENT installation (for example the app was reinstalled and got a new UUID) has
//      a stale claim: its open deliveries are cancelled and its token is released (replaced by an unusable placeholder, the
//      row is made inactive), so the token is never stored on two rows;
//   3. if the installation changes owner, the previous owner's open (pending / sending) deliveries for it are cancelled
//      BEFORE the row is re-assigned;
//   4. the row is created or updated: owner = patient, status active, lastRegisteredAt now, disabledAt cleared.
// Concurrency: the reads are plain reads; the database unique indexes (device_id, expo_push_token) settle races. A unique
// violation (P2002) or a deadlock / write conflict (P2034) rolls the whole transaction back and it is retried ONCE (the retry
// then sees what the winner committed). A second failure becomes a 409. Every other error is rethrown unchanged.
//
// Cancelling a delivery that a worker has already claimed ("sending") marks it "cancelled"; the sender must still re-check the
// device owner and status when it claims a delivery (that is the sender's job, not this module's).
//
// Responses never contain the Expo token.

const { randomUUID } = require('crypto');
const { prisma } = require('../../db/prisma');

const OWNER_TYPE = 'patient';
const PLATFORMS = Object.freeze(['android', 'ios']); // the schema CHECK allows exactly these
const ALLOWED_FIELDS = Object.freeze(['deviceId', 'expoPushToken', 'platform']);
const OPEN_DELIVERY_STATUSES = Object.freeze(['pending', 'sending']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Expo tokens: ExponentPushToken[...] (and the newer ExpoPushToken[...] spelling). 191 is the column width.
const EXPO_TOKEN_RE = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,160}\]$/;

function deviceError(statusCode, message, publicCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

// The column is case-sensitive (utf8mb4_bin), so a UUID is always stored lower-case: the same installation can never be
// registered twice under two spellings.
function normalizeDeviceId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw deviceError(400, 'deviceId must be a valid UUID.', 'invalid_device');
  return value.toLowerCase();
}

// Exactly { deviceId, expoPushToken, platform }; anything else (ownerId, ownerType, status, ...) is a 400.
function validateRegistration(body) {
  const invalid = (message) => deviceError(400, message, 'invalid_device');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send an object with deviceId, expoPushToken and platform.');
  const keys = Object.keys(body);
  if (keys.some((k) => !ALLOWED_FIELDS.includes(k))) throw invalid('Only deviceId, expoPushToken and platform can be sent.');
  if (ALLOWED_FIELDS.some((k) => body[k] === undefined)) throw invalid('deviceId, expoPushToken and platform are all required.');
  const deviceId = normalizeDeviceId(body.deviceId);
  if (typeof body.expoPushToken !== 'string' || !EXPO_TOKEN_RE.test(body.expoPushToken)) throw invalid('expoPushToken is not a valid Expo push token.');
  if (typeof body.platform !== 'string' || !PLATFORMS.includes(body.platform)) throw invalid(`platform must be one of: ${PLATFORMS.join(', ')}.`);
  return { deviceId, expoPushToken: body.expoPushToken, platform: body.platform };
}

// Cancel the open deliveries of one device row. `exceptOwnerId`: keep the deliveries that already belong to this patient.
function cancelOpenDeliveries(tx, deviceRowId, reason, now, { exceptPatientId } = {}) {
  return tx.notificationDelivery.updateMany({
    where: {
      deviceId: deviceRowId,
      status: { in: [...OPEN_DELIVERY_STATUSES] },
      ...(exceptPatientId !== undefined ? { NOT: { recipientType: OWNER_TYPE, recipientId: exceptPatientId } } : {}),
    },
    data: { status: 'cancelled', closedAt: now, lockedBy: null, lockedUntil: null, lastErrorCode: reason },
  });
}

// The legacy single push token of a patient (users.push_token, still written by POST /auth/push-token). It is cleared ONLY when it is exactly the Expo
// token that was on the device row being unregistered or handed over: the comparison is made by the database, in the WHERE of one UPDATE, so a different
// token (another phone's, or one saved after this one) is never touched, and there is no read-then-write gap. `oldToken` is always the value READ FROM THE DEVICE
// ROW inside the same transaction, never anything from the request. A placeholder written by a token release ("released:...") can never equal a real token.
function clearLegacyTokenIfEqual(tx, patientId, oldToken) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || typeof oldToken !== 'string' || oldToken === '') return Promise.resolve({ count: 0 });
  return tx.user.updateMany({ where: { id: patientId, pushToken: oldToken }, data: { pushToken: null } });
}

const isOwnedBy = (row, patientId) => row.ownerType === OWNER_TYPE && row.ownerId === patientId;

async function registerOnce(patientId, input) {
  return prisma.$transaction(async (tx) => {
    // `ownerId` has no foreign key: a deleted account must not get a device row.
    const user = await tx.user.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!user) throw deviceError(404, 'Patient not found');

    const now = new Date();
    const mine = await tx.notificationDevice.findUnique({ where: { deviceId: input.deviceId } });
    const holder = await tx.notificationDevice.findUnique({ where: { expoPushToken: input.expoPushToken } });

    // The token sits on another installation's row: that claim is stale (the token is in this installation's hands now).
    if (holder && (!mine || holder.id !== mine.id)) {
      await cancelOpenDeliveries(tx, holder.id, 'device_token_reassigned', now);
      await tx.notificationDevice.update({
        where: { id: holder.id },
        // A unique, unusable value (not a valid Expo token), so the real token is free and the row keeps its history.
        data: { expoPushToken: `released:${holder.id}:${randomUUID()}`, status: 'inactive', disabledAt: now },
      });
    }

    // Ownership transfer: the previous owner's open deliveries for this installation must never reach the new owner.
    if (mine && !isOwnedBy(mine, patientId)) {
      await cancelOpenDeliveries(tx, mine.id, 'device_owner_changed', now);
      // The previous owner's legacy token goes only if it is exactly the token this installation held BEFORE the transfer (`mine.expoPushToken`, read above
      // and not yet changed): not the incoming token, and never the new owner's legacy token. A row of another owner type is not a patient: nothing to clear.
      if (mine.ownerType === OWNER_TYPE) await clearLegacyTokenIfEqual(tx, mine.ownerId, mine.expoPushToken);
    }

    const data = {
      ownerType: OWNER_TYPE, ownerId: patientId, expoPushToken: input.expoPushToken, platform: input.platform,
      status: 'active', lastRegisteredAt: now, disabledAt: null,
    };
    const row = mine
      ? await tx.notificationDevice.update({ where: { id: mine.id }, data })
      : await tx.notificationDevice.create({ data: { deviceId: input.deviceId, ...data } });
    return row;
  });
}

const isRetryable = (err) => !!err && (err.code === 'P2002' || err.code === 'P2034');

/**
 * Register (or re-register) the authenticated patient's app installation.
 * @returns {Promise<{ deviceId: string, platform: string, status: string, lastRegisteredAt: Date }>}  no token
 */
async function registerPatientDevice(patientId, body) {
  const input = validateRegistration(body);
  let row;
  try {
    row = await registerOnce(patientId, input);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    try {
      row = await registerOnce(patientId, input); // the winner's rows are committed now; this attempt sees them
    } catch (again) {
      if (!isRetryable(again)) throw again;
      throw deviceError(409, 'The device could not be registered right now; please retry.', 'device_conflict');
    }
  }
  return { deviceId: row.deviceId, platform: row.platform, status: row.status, lastRegisteredAt: row.lastRegisteredAt };
}

/**
 * Deactivate the authenticated patient's installation. An unknown device, a device that belongs to someone else and an
 * already inactive device all resolve the same way (undefined), so the answer never reveals who owns a device id.
 * Only a malformed id is refused (400), which reveals nothing.
 */
async function unregisterPatientDevice(patientId, deviceIdParam) {
  const deviceId = normalizeDeviceId(deviceIdParam);
  await prisma.$transaction(async (tx) => {
    const row = await tx.notificationDevice.findUnique({ where: { deviceId } });
    if (!row || !isOwnedBy(row, patientId)) return;
    const now = new Date();
    // Only this patient's deliveries for this one device row; other devices are untouched.
    await tx.notificationDelivery.updateMany({
      where: { deviceId: row.id, recipientType: OWNER_TYPE, recipientId: patientId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
      data: { status: 'cancelled', closedAt: now, lockedBy: null, lockedUntil: null, lastErrorCode: 'device_unregistered' },
    });
    // Owner is part of the condition: if the installation was taken over meanwhile this matches nothing.
    await tx.notificationDevice.updateMany({
      where: { id: row.id, ownerType: OWNER_TYPE, ownerId: patientId, status: 'active' },
      data: { status: 'inactive', disabledAt: now },
    });
    // The legacy single token of THIS patient goes only if it is exactly this device's token (read from the row above). Another phone's token is kept.
    await clearLegacyTokenIfEqual(tx, patientId, row.expoPushToken);
  });
}

/**
 * A patient's session was revoked (their password was reset or set: the account's tokenVersion moved on): every push device of THIS patient stops
 * receiving pushes. Called with the SAME transaction client as the password update, so the password, the devices and the deliveries change together or not at all.
 *   * every device row owned by the patient is made "inactive" (disabledAt set) if it was active; rows are never deleted, so the history stays;
 *   * the patient's OPEN deliveries (pending, sending) for those devices are cancelled with lastErrorCode = reason. Cancelling clears the lease (locked_by,
 *     locked_until) and the status is no longer 'sending', so a worker that still holds an old claim is refused by its fenced write (0 rows) and cannot
 *     overwrite the cancellation. Accepted, delivered, failed, uncertain and cancelled deliveries and every attempt row are left exactly as they are;
 *   * notifications (the in-app history) are not touched, and nothing of any other patient is.
 * The patient registers again after logging in with the new password (the ordinary POST /notifications/devices: a device row that is inactive is simply
 * re-activated for its owner). Resolves { devices, deliveries }: the counts changed.
 */
async function revokePatientDevices(tx, patientId, { reason = 'session_revoked', now = new Date() } = {}) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new Error('revokePatientDevices needs a patient id.');
  const owned = await tx.notificationDevice.findMany({ where: { ownerType: OWNER_TYPE, ownerId: patientId }, select: { id: true } });
  if (owned.length === 0) return { devices: 0, deliveries: 0 };
  const ids = owned.map((d) => d.id);
  const cancelled = await tx.notificationDelivery.updateMany({
    where: { deviceId: { in: ids }, recipientType: OWNER_TYPE, recipientId: patientId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
    data: { status: 'cancelled', closedAt: now, lockedBy: null, lockedUntil: null, lastErrorCode: reason },
  });
  const deactivated = await tx.notificationDevice.updateMany({
    where: { id: { in: ids }, ownerType: OWNER_TYPE, ownerId: patientId, status: 'active' },
    data: { status: 'inactive', disabledAt: now },
  });
  return { devices: deactivated.count, deliveries: cancelled.count };
}

/**
 * A patient's account was retired (account deletion). Inside the caller's transaction, patient-only (a corporate user is never touched):
 *   * the patient's push devices end exactly as at a password reset (revokePatientDevices: every device row inactive, its open deliveries cancelled with `reason`);
 *   * every OTHER open delivery of the patient (pending or sending, whatever its destination) is cancelled too, with the same reason and the same fenced clearing of the lease, so no worker sends
 *     anything to a retired account;
 *   * the in-app history is HIDDEN, not destroyed: each notification not yet deleted gets `deletedAt`, exactly what the patient's own delete does. The rows, their deliveries and their
 *     idempotency keys are kept, so a late event for the same stage or quotation can never create the notification a second time (the key is still taken), and the history of what was
 *     sent stays available for audit. Rows the patient had already deleted keep their original `deletedAt`.
 * Resolves { devices, deliveries, notifications }: how many rows changed.
 */
async function retirePatientNotifications(tx, patientId, { reason = 'account_deleted', now = new Date() } = {}) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new Error('retirePatientNotifications needs a patient id.');
  const revoked = await revokePatientDevices(tx, patientId, { reason, now });
  const stray = await tx.notificationDelivery.updateMany({
    where: { recipientType: OWNER_TYPE, recipientId: patientId, status: { in: [...OPEN_DELIVERY_STATUSES] } },
    data: { status: 'cancelled', closedAt: now, lockedBy: null, lockedUntil: null, lastErrorCode: reason },
  });
  const hidden = await tx.notification.updateMany({
    where: { recipientType: OWNER_TYPE, recipientId: patientId, deletedAt: null },
    data: { deletedAt: now },
  });
  return { devices: revoked.devices, deliveries: revoked.deliveries + stray.count, notifications: hidden.count };
}

module.exports = { registerPatientDevice, unregisterPatientDevice, revokePatientDevices, retirePatientNotifications, validateRegistration, EXPO_TOKEN_RE, UUID_RE, PLATFORMS };
