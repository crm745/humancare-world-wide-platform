// Response headers and error mapping for the Admin router.
//
// adminNoStore        Cache-Control: no-store (+ Pragma) on every Admin response, set before
//                     anything else so it also covers errors.
// adminAuthErrorHandler  maps the known service errors to their public shapes and sends everything
//                     else on, untouched, to the app's error handler, which answers a generic 500
//                     and logs only safe metadata. Unexpected database, audit, signing and
//                     configuration failures therefore never become a 4xx and never show detail.
//
// Service error semantics are not changed: each message below is the service's own fixed text.
const { InvitationError } = require('./admin-invitation.service');
const { PasskeyRegistrationError } = require('./admin-webauthn-registration.service');
const { AdminLoginError } = require('./admin-login.service');
const { AdminSessionError } = require('./admin-session.service');
const { RequestValidationError } = require('./admin-auth.validation');
const { RecoveryDecisionError } = require('./admin-recovery-decision.service');
const { RecoveryRegistrationError } = require('./admin-recovery-registration.service');
const { ProvisioningError } = require('./admin-provisioning.service');
const { clearAllSessionCookies } = require('./admin-auth.cookies');

function adminNoStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

// "used" / "revoked" / "expired" are safe to tell the holder of a link (the service says so);
// "invalid" says nothing and is left out.
const REVEALABLE_STATES = ['used', 'revoked', 'expired'];

// eslint-disable-next-line no-unused-vars
function adminAuthErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof RequestValidationError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err instanceof InvitationError) {
    const revealState = res.locals.revealInvitationState === true && REVEALABLE_STATES.includes(err.state);
    return res.status(400).json({ error: err.message, code: err.code, ...(revealState && { state: err.state }) });
  }
  if (err instanceof PasskeyRegistrationError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  // Recovery. Each service error carries a fixed, public message and a coarse code; the internal
  // `reason` is not enumerable and is never sent. None of these ends the caller's session.
  if (err instanceof RecoveryDecisionError) {
    const status = { not_available: 404, already_decided: 409, step_up_failed: 400 }[err.code] || 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  if (err instanceof RecoveryRegistrationError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err instanceof ProvisioningError && err.code === 'invalid_reason') {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err instanceof AdminLoginError) {
    return res.status(401).json({ error: err.message, code: err.code });
  }
  if (err instanceof AdminSessionError) {
    clearAllSessionCookies(res);
    return res.status(401).json({ error: err.message, code: err.code });
  }
  return next(err);
}

module.exports = { adminNoStore, adminAuthErrorHandler };
