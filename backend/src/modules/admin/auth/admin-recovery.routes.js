// The Admin passkey-recovery routes, mounted next to the authentication routes at the top of the
// Admin router (before requireAdminAuth). Every route carries its own chain, so mounting this adds
// no middleware to any other /admin path. Operator-only operations (opening, inspecting,
// cancelling, resending and break-glass) have deliberately NO route: they stay in
// scripts/admin-recovery.js, and there is no public way to create a recovery request.
//
// Per-route order:  strict origin guard -> rate limit -> [CSRF header -> session -> superadmin]
//                   -> body-size -> controller.
//
//   superadmin session (database-backed; role and status are re-read on every request):
//     GET  /recovery/requests                         open requests this superadmin can decide on (read-only)
//     POST /recovery/requests/:id/approval/options    approval step-up challenge
//     POST /recovery/requests/:id/rejection/options   rejection step-up challenge
//     POST /recovery/requests/:id/approve             approve, with the passkey assertion
//     POST /recovery/requests/:id/reject              reject, with the passkey assertion
//   public, ignoring any Bearer / cookie sent with them:
//     POST /recovery/redeem                           invitation link + current password -> recovery ticket
//     POST /recovery/passkeys/registration/options    recovery ticket -> registration options
//     POST /recovery/passkeys/registration/verify     recovery ticket + attestation -> new passkey
//
// The recovery ticket travels in the JSON body, as the enrollment ticket does; never in a URL or
// query string. A recovery ticket is refused by the enrollment and login endpoints, and theirs by
// these (the tickets have different audiences and flows).
const { Router } = require('express');
const { requireSuperAdmin } = require('../../../common/middleware/auth.middleware');
const { requireAdminSession } = require('./admin-session.middleware');
const { adminOriginGuard, requireAdminCsrfHeader } = require('./admin-origin.middleware');
const { adminAuthLimiters: limit } = require('./admin-auth.limiters');
const { maxBodyBytes } = require('./admin-auth.validation');
const controller = require('./admin-recovery.controller');

const strictOrigin = adminOriginGuard();
const webauthnBody = maxBodyBytes();
const redeemBody = maxBodyBytes(8 * 1024); // a 43-character link token and a password
const stepUpBody = maxBodyBytes(1024); // no body is expected at all

// requireAdminSession accepts only database-backed session tokens (no legacy password-only token,
// no enrollment / login / recovery ticket). requireSuperAdmin reads the role it re-read from the
// database. The recovery service still applies target exclusion and request eligibility.
// A read: no CSRF header (safe method) and the lenient origin guard, like the other GETs, so a
// browser's same-origin read works; a present Origin must still match.
const readOrigin = adminOriginGuard({ strict: false });

const superadminSession = [requireAdminCsrfHeader, requireAdminSession(['admin']), requireSuperAdmin];

const adminRecoveryRouter = Router();

adminRecoveryRouter.get('/recovery/requests', readOrigin, limit.recoveryList, requireAdminSession(['admin']), requireSuperAdmin, controller.list);

adminRecoveryRouter.post('/recovery/requests/:id/approval/options', strictOrigin, limit.recoveryStepUp, ...superadminSession, stepUpBody, controller.approvalOptions);
adminRecoveryRouter.post('/recovery/requests/:id/rejection/options', strictOrigin, limit.recoveryStepUp, ...superadminSession, stepUpBody, controller.rejectionOptions);
adminRecoveryRouter.post('/recovery/requests/:id/approve', strictOrigin, limit.recoveryDecision, ...superadminSession, webauthnBody, controller.approve);
adminRecoveryRouter.post('/recovery/requests/:id/reject', strictOrigin, limit.recoveryDecision, ...superadminSession, webauthnBody, controller.reject);

adminRecoveryRouter.post('/recovery/redeem', strictOrigin, limit.recoveryRedeem, redeemBody, controller.redeem);
adminRecoveryRouter.post('/recovery/passkeys/registration/options', strictOrigin, limit.recoveryRegistrationOptions, webauthnBody, controller.registrationOptions);
adminRecoveryRouter.post('/recovery/passkeys/registration/verify', strictOrigin, limit.recoveryRegistrationVerify, webauthnBody, controller.registrationVerify);

module.exports = { adminRecoveryRouter };
