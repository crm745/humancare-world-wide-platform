// Notification System, Step 3: the centralized PATIENT notification creation core.
//
// One entry point, createPatientNotification, which validates against the approved catalogue (notification-catalogue.js),
// verifies in the database that every referenced record exists and belongs to the patient, and creates the in-app
// notification row exactly once per (kind, patient, event). It is deliberately only that:
//   * no push is sent (no Expo call) and no NotificationDelivery / NotificationDeliveryAttempt row is created;
//   * no preferences, devices or workers;
//   * corporate recipients are not supported (recipientType is always "patient" and cannot be passed in).
// Existing creation call sites are not migrated yet; nothing calls this module so far.
//
// Idempotency. The key is `{kind}:patient:{recipientId}:{eventRef}` (buildIdempotencyKey) and the column is UNIQUE and
// is kept after a soft delete, so a deleted notification still blocks a re-creation of the same event.
//   1. A replay is detected by reading the key first (a replay returns the stored row with created: false).
//   2. Concurrent first attempts are settled by the database unique constraint, never by the pre-read alone: the loser's
//      INSERT fails with Prisma P2002 on the idempotency key, and that one error (and only that one) is turned into
//      "read the winner's row".
//   3. MySQL/InnoDB rolls back only the failed statement, so a transaction normally stays usable after a duplicate-key
//      error. This code still does not rely on being able to carry on inside a caller's transaction: at REPEATABLE READ the
//      re-read can fail to SEE a row another transaction committed after this one took its snapshot. In that case it throws
//      a 409 NotificationCoreError (`idempotency_conflict_unresolved`) instead of guessing, which rolls the caller's business
//      transaction back so it can be retried (the retry's first read sees the committed row). Outside a transaction (no
//      options.tx) every statement reads fresh data, so the re-read always finds the winner.
//   Every other Prisma error, and a P2002 on any other constraint, is rethrown unchanged.

const { prisma } = require('../../db/prisma');
const catalogue = require('./notification-catalogue');

// The only caller-supplied fields. recipientType, isMandatory, idempotencyKey, deletedAt and anything else are never read.
const INPUT_KEYS = Object.freeze(['recipientId', 'kind', 'body', 'caseId', 'serviceRequestId', 'quotationId', 'data', 'eventRef']);

class NotificationCoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message || code);
    this.name = 'NotificationCoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// One message for "not found" and "not yours", so a caller cannot probe which ids exist.
const invalidReference = () => new NotificationCoreError('invalid_reference', 'A referenced record is missing or does not belong to this patient.', 422);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isIdempotencyConflict(err) {
  if (!err || err.code !== 'P2002') return false;
  const target = err.meta && err.meta.target;
  const text = Array.isArray(target) ? target.join(',') : String(target || '');
  return /idempotency_key/i.test(text);
}

function pickInput(input) {
  const picked = {};
  for (const key of INPUT_KEYS) if (input[key] !== undefined) picked[key] = input[key];
  return picked;
}

// ---- database verification ---------------------------------------------------------------------------------------
async function verifyRecipient(client, patientId) {
  const user = await client.user.findUnique({ where: { id: patientId }, select: { id: true } });
  if (!user) throw new NotificationCoreError('recipient_not_found', 'The patient does not exist.', 422);
}

async function verifyReferences(client, patientId, value) {
  // Ownership comes ONLY from ServiceRequest.userId. A Case is never trusted to name its patient on its own.
  const serviceRequest = await client.serviceRequest.findUnique({ where: { id: value.serviceRequestId }, select: { id: true, userId: true } });
  if (!serviceRequest || serviceRequest.userId !== patientId) throw invalidReference();

  const caseById = async (id) => {
    const found = await client.case.findUnique({ where: { id }, select: { id: true, serviceRequestId: true } });
    // A patient notification needs a Case that belongs to THIS service request (corporate cases have none and are refused).
    if (!found || found.serviceRequestId === null || found.serviceRequestId !== serviceRequest.id) throw invalidReference();
    return found;
  };

  let caseId = null;
  if (value.caseId !== null) caseId = (await caseById(value.caseId)).id;

  let quotation = null;
  if (value.quotationId !== null) {
    quotation = await client.caseQuotation.findUnique({ where: { id: value.quotationId }, select: { id: true, caseId: true } });
    if (!quotation) throw invalidReference();
    if (caseId !== null && quotation.caseId !== caseId) throw invalidReference(); // the supplied Case must be the quotation's own
    await caseById(quotation.caseId); // the quotation's Case must belong to the verified service request
  }

  // A payment screen's entityId is a Payment id: it must exist and sit on the quotation's Case.
  if (value.data && value.data.screen === 'payment' && value.data.entityId !== undefined) {
    const payment = await client.payment.findUnique({ where: { id: value.data.entityId }, select: { id: true, caseId: true } });
    if (!payment || !quotation || payment.caseId !== quotation.caseId) throw invalidReference();
  }
}

// ---- the entry point ---------------------------------------------------------------------------------------------
/**
 * Create one in-app notification for a patient, once per event.
 *
 * @param {object} input  recipientId, kind, body?, caseId?, serviceRequestId?, quotationId?, data?, eventRef.
 *                        The title always comes from the catalogue. Any other field (title, recipientType, isMandatory,
 *                        idempotencyKey ...) is ignored and never stored.
 * @param {{ tx?: object }} options  `tx`: the caller's Prisma transaction client; the notification then commits or rolls
 *                        back with it. Without it the shared Prisma client is used (no transaction is opened here).
 * @returns {Promise<{ notification: object, created: boolean }>}  created is false for a replay of the same event.
 * @throws {NotificationCoreError}  400 invalid input, 422 patient or reference problem, 409 unresolved concurrent conflict.
 */
async function createPatientNotification(input, options = {}) {
  if (!isPlainObject(input)) throw new NotificationCoreError('input_invalid', 'Input must be an object.');
  const opts = isPlainObject(options) ? options : {};
  if (opts.tx !== undefined && !(isPlainObject(opts.tx) && opts.tx.notification && typeof opts.tx.notification.create === 'function')) {
    throw new NotificationCoreError('tx_invalid', 'options.tx must be a Prisma transaction client.');
  }
  const client = opts.tx || prisma;
  const picked = pickInput(input);

  // Case-stage updates always carry the fixed safe text; staff free text is never copied into a notification.
  const body = picked.kind === 'stage_update' ? catalogue.SAFE_BODIES.caseStatusUpdated : picked.body;

  const checked = catalogue.validateNotificationInput({
    recipientType: catalogue.RECIPIENT_TYPES.PATIENT,
    recipientId: picked.recipientId,
    kind: picked.kind,
    title: catalogue.getKindTitle(picked.kind), // the catalogue's fixed title; a caller-supplied title is not even read
    body,
    caseId: picked.caseId,
    serviceRequestId: picked.serviceRequestId,
    quotationId: picked.quotationId,
    data: picked.data,
  });
  if (!checked.ok) throw new NotificationCoreError(checked.code, checked.message);
  const value = checked.value; // sanitised; isMandatory comes from the catalogue only

  let idempotencyKey;
  try {
    idempotencyKey = catalogue.buildIdempotencyKey({ recipientType: value.recipientType, recipientId: value.recipientId, kind: value.kind, eventRef: picked.eventRef });
  } catch (err) {
    if (err instanceof catalogue.NotificationValidationError) throw new NotificationCoreError(err.code, err.message);
    throw err;
  }

  // Relationship rules that need no database. Ownership is proven through the ServiceRequest, never through a Case alone.
  if ((value.caseId !== null || value.quotationId !== null) && value.serviceRequestId === null) {
    throw new NotificationCoreError('service_request_required', 'A case or quotation reference needs the patient\'s serviceRequestId.');
  }

  // Replay: the same event was already recorded (even if the patient has since deleted it).
  const replay = await readByKey(client, idempotencyKey, value);
  if (replay) return { notification: replay, created: false };

  await verifyRecipient(client, value.recipientId);
  if (value.serviceRequestId !== null) await verifyReferences(client, value.recipientId, value);

  try {
    const notification = await client.notification.create({
      data: {
        recipientType: value.recipientType,
        recipientId: value.recipientId,
        kind: value.kind,
        title: value.title,
        body: value.body,
        caseId: value.caseId,
        serviceRequestId: value.serviceRequestId,
        quotationId: value.quotationId,
        isMandatory: value.isMandatory,
        idempotencyKey,
        ...(value.data !== null ? { data: value.data } : {}), // a plain null is not a valid value for a nullable Json column
      },
    });
    return { notification, created: true };
  } catch (err) {
    if (!isIdempotencyConflict(err)) throw err;
    const winner = await readByKey(client, idempotencyKey, value);
    if (winner) return { notification: winner, created: false };
    throw new NotificationCoreError('idempotency_conflict_unresolved', 'The notification for this event could not be confirmed; retry the operation.', 409);
  }
}

// The immutable event references of a notification. An omitted reference and a stored NULL are the same thing.
const REF_FIELDS = Object.freeze(['caseId', 'serviceRequestId', 'quotationId']);

async function readByKey(client, idempotencyKey, value) {
  const existing = await client.notification.findUnique({ where: { idempotencyKey } });
  if (!existing) return null;
  // The key embeds the recipient, so a row under it for someone else would be corrupt data: refuse, never return it.
  if (existing.recipientType !== value.recipientType || existing.recipientId !== value.recipientId) {
    throw new NotificationCoreError('idempotency_key_mismatch', 'The idempotency key belongs to a different recipient.', 409);
  }
  // Same event, different references: the caller is reusing an eventRef for a different subject. Never return the stored
  // row as if it were this one. Compared in memory only; no reference lookup is repeated on a valid replay.
  for (const field of REF_FIELDS) {
    if ((existing[field] ?? null) !== (value[field] ?? null)) {
      throw new NotificationCoreError('idempotency_replay_mismatch', 'This event was already recorded with different references.', 409);
    }
  }
  return existing;
}

module.exports = { createPatientNotification, NotificationCoreError, isIdempotencyConflict, INPUT_KEYS };
