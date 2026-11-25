const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { deviceRegistrationLimiter } = require('../../common/middleware/rate-limit.middleware');
const {
  listMine, markOneRead, markAllMineRead, deleteMine, getMyPreferences, updateMyPreferences, registerMyDevice, unregisterMyDevice,
} = require('./notifications.controller');

const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth(), listMine);
notificationsRouter.post('/:id/read', requireAuth(), markOneRead);
notificationsRouter.post('/read-all', requireAuth(), markAllMineRead);
// Patients only: in-app / push preferences.
notificationsRouter.get('/preferences', requireAuth(['patient']), getMyPreferences);
notificationsRouter.patch('/preferences', requireAuth(['patient']), updateMyPreferences);
// Patients only: push-device registry. Auth first (so the limiter can key on the patient), then the limiter on the write that can move ownership.
notificationsRouter.post('/devices', requireAuth(['patient']), deviceRegistrationLimiter, registerMyDevice);
notificationsRouter.delete('/devices/:deviceId', requireAuth(['patient']), unregisterMyDevice);
// Patients only: corporate users delete through /corporate/notifications/:id, which is unchanged.
notificationsRouter.delete('/:id', requireAuth(['patient']), deleteMine);

module.exports = { notificationsRouter };
