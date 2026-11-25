const { prisma } = require('../../db/prisma');
const { getPatientPreferences } = require('./notification-preferences.service');

async function listNotificationsFor(recipientType, recipientId, { unreadOnly } = {}) {
  const where = { recipientType, recipientId };
  if (unreadOnly === 'true' || unreadOnly === true) where.readAt = null;
  return prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' } });
}

async function markRead(recipientType, recipientId, id) {
  const notification = await prisma.notification.findFirst({ where: { id: Number(id), recipientType, recipientId } });
  if (!notification) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  return prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
}

async function markAllRead(recipientType, recipientId) {
  await prisma.notification.updateMany({
    where: { recipientType, recipientId, readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

// Like markRead, but can also un-mark (the corporate-portal web app lets a corporate
// toggle a notification back to unread, not just forward to read).
async function setReadStatus(recipientType, recipientId, id, read) {
  const notification = await prisma.notification.findFirst({ where: { id: Number(id), recipientType, recipientId } });
  if (!notification) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  return prisma.notification.update({ where: { id: notification.id }, data: { readAt: read ? new Date() : null } });
}

async function deleteNotification(recipientType, recipientId, id) {
  const notification = await prisma.notification.findFirst({ where: { id: Number(id), recipientType, recipientId } });
  if (!notification) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  await prisma.notification.delete({ where: { id: notification.id } });
}

// ---- PATIENT notifications ---------------------------------------------------------------------------------------
// Patient-only read / list / soft-delete operations. The functions above are shared with the corporate portal and are
// deliberately left exactly as they are (corporate is a later step); these take only a patient id, so they cannot be
// pointed at another recipient type. Every query excludes soft-deleted rows (`deletedAt: null`) and is scoped to the
// authenticated patient. A soft delete keeps the row, its deliveries and its idempotencyKey.
const PATIENT = 'patient';

// What a patient is ever sent. An explicit allow-list: internal columns (idempotencyKey, deletedAt, updatedAt,
// recipientType, recipientId) are never returned, so a new column added to the table is not exposed by accident.
// `data` and `isMandatory` are additive fields; the mobile app reads id, kind, title, body, readAt and createdAt.
const PATIENT_NOTIFICATION_SELECT = Object.freeze({
  id: true, kind: true, title: true, body: true, readAt: true, createdAt: true,
  isMandatory: true, data: true, caseId: true, serviceRequestId: true, quotationId: true,
});

function notificationNotFound() {
  const err = new Error('Notification not found');
  err.statusCode = 404;
  return err;
}

// An id that is not a positive integer can never match a row: answer "not found" rather than hand Prisma a NaN.
function patientNotificationId(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw notificationNotFound();
  return n;
}

async function findOwnActivePatientNotification(patientId, id) {
  const notification = await prisma.notification.findFirst({
    where: { id: patientNotificationId(id), recipientType: PATIENT, recipientId: patientId, deletedAt: null },
  });
  if (!notification) throw notificationNotFound();
  return notification;
}

async function listPatientNotifications(patientId, { unreadOnly } = {}) {
  const where = { recipientType: PATIENT, recipientId: patientId, deletedAt: null };
  if (unreadOnly === 'true' || unreadOnly === true) where.readAt = null;
  // In-app OFF hides the non-mandatory notifications from the list; nothing is deleted or skipped at creation, so the
  // records and their idempotency keys stay. Mandatory (security, payment) notifications stay visible. No preference row
  // means the default (ON): the query is then exactly what it was before preferences existed.
  const { inAppEnabled } = await getPatientPreferences(patientId);
  if (!inAppEnabled) where.isMandatory = true;
  return prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, select: PATIENT_NOTIFICATION_SELECT });
}

async function markPatientNotificationRead(patientId, id) {
  const notification = await findOwnActivePatientNotification(patientId, id);
  return prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() }, select: PATIENT_NOTIFICATION_SELECT });
}

async function markAllPatientNotificationsRead(patientId) {
  await prisma.notification.updateMany({
    where: { recipientType: PATIENT, recipientId: patientId, readAt: null, deletedAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

// Read or un-read (same contract as setReadStatus above).
async function setPatientReadStatus(patientId, id, read) {
  const notification = await findOwnActivePatientNotification(patientId, id);
  return prisma.notification.update({ where: { id: notification.id }, data: { readAt: read ? new Date() : null }, select: PATIENT_NOTIFICATION_SELECT });
}

// Soft delete: one conditional update, so a repeated or concurrent delete matches nothing the second time and answers
// the same 404 as an unknown id. Resolves to undefined, like the hard delete it replaces.
async function deletePatientNotification(patientId, id) {
  const { count } = await prisma.notification.updateMany({
    where: { id: patientNotificationId(id), recipientType: PATIENT, recipientId: patientId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (count !== 1) throw notificationNotFound();
}

module.exports = {
  PATIENT_NOTIFICATION_SELECT,
  listNotificationsFor, markRead, markAllRead, setReadStatus, deleteNotification,
  listPatientNotifications, markPatientNotificationRead, markAllPatientNotificationsRead, setPatientReadStatus, deletePatientNotification,
};
