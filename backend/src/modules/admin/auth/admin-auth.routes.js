// The Admin authentication routes that need no dashboard session, plus logout. Mounted at the very
// top of the Admin router (before requireAdminAuth). Every route here carries its own middleware
// chain, so mounting this router adds no middleware to any other /admin path.
//
// Per-route order:  origin guard -> rate limit -> [CSRF header] -> [body-size] -> controller.
// The origin guard comes first so a foreign page is refused before it can consume rate-limit budget.
//
//   public, ignoring any Bearer / cookie sent with them:
//     POST /invitations/inspect          POST /invitations/accept       POST /enrollment/redeem
//     POST /passkeys/registration/options  POST /passkeys/registration/verify
//     POST /login/password               POST /login/passkey
//   refresh cookie only:
//     POST /refresh
//   database-backed session:
//     POST /logout
//
// Legacy POST /login is not here and is unchanged.
const { Router } = require('express');
const { requireAdminSession } = require('./admin-session.middleware');
const { adminOriginGuard, requireAdminCsrfHeader } = require('./admin-origin.middleware');
const { adminAuthLimiters: limit } = require('./admin-auth.limiters');
const { maxBodyBytes } = require('./admin-auth.validation');
const { clearLegacyAccessCookie } = require('./admin-auth.cookies');
const controller = require('./admin-auth.controller');

const strictOrigin = adminOriginGuard();
const webauthnBody = maxBodyBytes();

const adminAuthRouter = Router();

adminAuthRouter.post('/invitations/inspect', strictOrigin, limit.inspect, controller.inspectInvitation);
adminAuthRouter.post('/invitations/accept', strictOrigin, limit.accept, controller.acceptInvitation);
adminAuthRouter.post('/enrollment/redeem', strictOrigin, limit.redeem, controller.redeemEnrollment);

adminAuthRouter.post('/passkeys/registration/options', strictOrigin, limit.registrationOptions, webauthnBody, controller.registrationOptions);
adminAuthRouter.post('/passkeys/registration/verify', strictOrigin, limit.registrationVerify, webauthnBody, controller.registrationVerify);

adminAuthRouter.post('/login/password', strictOrigin, limit.loginPassword, controller.loginPassword);
adminAuthRouter.post('/login/passkey', strictOrigin, limit.loginPasskey, webauthnBody, controller.loginPasskey);

adminAuthRouter.post('/refresh', strictOrigin, limit.refresh, requireAdminCsrfHeader, controller.refresh);

// A legacy (password-only) session has no database session to revoke, so requireAdminSession
// refuses it with a 401; its cookie is still removed first, as the old logout did. The current
// cookies are deliberately NOT cleared on that 401: a client whose access token merely expired
// must be able to refresh and then log out properly.
adminAuthRouter.post(
  '/logout',
  strictOrigin,
  limit.logout,
  requireAdminCsrfHeader,
  (_req, res, next) => { clearLegacyAccessCookie(res); next(); },
  requireAdminSession(['admin']),
  controller.logout,
);

module.exports = { adminAuthRouter };
