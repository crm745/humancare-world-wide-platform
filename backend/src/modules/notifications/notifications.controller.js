const {
  listNotificationsFor, markRead, markAllRead,
  listPatientNotifications, markPatientNotificationRead, markAllPatientNotificationsRead, deletePatientNotification,
} = require('./notifications.service');
const { getPatientPreferences, updatePatientPreferences } = require('./notification-preferences.service');
const { registerPatientDevice, unregisterPatientDevice } = require('./notification-devices.service');

function recipientFor(req) {
  return req.user.role === 'corporate'
    ? { recipientType: 'corporate_user', recipientId: req.user.id }
    : { recipientType: 'patient', recipientId: req.user.id };
}

// Patients use the soft-delete-aware patient functions. A corporate user still takes the original path, unchanged.
async function listMine(req, res, next) {
  try {
    const { recipientType, recipientId } = recipientFor(req);
    const notifications = recipientType === 'patient'
      ? await listPatientNotifications(recipientId, { unreadOnly: req.query.unreadOnly })
      : await listNotificationsFor(recipientType, recipientId, { unreadOnly: req.query.unreadOnly });
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
}

async function markOneRead(req, res, next) {
  try {
    const { recipientType, recipientId } = recipientFor(req);
    const notification = recipientType === 'patient'
      ? await markPatientNotificationRead(recipientId, req.params.id)
      : await markRead(recipientType, recipientId, req.params.id);
    res.json({ notification });
  } catch (err) {
    next(err);
  }
}

async function markAllMineRead(req, res, next) {
  try {
    const { recipientType, recipientId } = recipientFor(req);
    if (recipientType === 'patient') await markAllPatientNotificationsRead(recipientId);
    else await markAllRead(recipientType, recipientId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Patient-only (the route is restricted to the patient role). Soft delete; 204 like the corporate delete route.
async function deleteMine(req, res, next) {
  try {
    await deletePatientNotification(req.user.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// Patient preferences. The owner is always the authenticated patient (req.user.id); the body only carries the two switches.
async function getMyPreferences(req, res, next) {
  try {
    res.json({ preferences: await getPatientPreferences(req.user.id) });
  } catch (err) {
    next(err);
  }
}

async function updateMyPreferences(req, res, next) {
  try {
    res.json({ preferences: await updatePatientPreferences(req.user.id, req.body) });
  } catch (err) {
    next(err);
  }
}

// Patient push devices (route restricted to the patient role). The owner is always req.user.id; the body carries only the
// installation's deviceId, Expo token and platform. The Expo token is never sent back.
async function registerMyDevice(req, res, next) {
  try {
    res.json({ device: await registerPatientDevice(req.user.id, req.body) });
  } catch (err) {
    next(err);
  }
}

// 204 whether the device was theirs, someone else's or unknown: the answer reveals nothing about who owns a device id.
async function unregisterMyDevice(req, res, next) {
  try {
    await unregisterPatientDevice(req.user.id, req.params.deviceId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { listMine, markOneRead, markAllMineRead, deleteMine, getMyPreferences, updateMyPreferences, registerMyDevice, unregisterMyDevice };
