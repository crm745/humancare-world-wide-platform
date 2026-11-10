// HTTP handlers for the Admin authentication endpoints. Thin by design: validate the body, call the
// existing service with the arguments it actually takes, and shape the response. Nothing here
// reads an incoming Authorization header or session cookie except refresh (its own cookie) and
// logout (behind requireAdminSession), so the public endpoints cannot be influenced by credentials
// a caller happens to send.
//
// Handlers are async and rely on Express 5 forwarding a rejected promise to the error middleware
// (admin-auth.errors.js), which maps the known service errors and passes everything else on to the
// generic 500. Raw access and refresh tokens are only ever written to cookies, never to a body.
const {
  inspectActivationInvitation,
  acceptActivationInvitation,
  redeemAdminPasskeyEnrollmentInvitation,
} = require('./admin-invitation.service');
const { generateAdminPasskeyRegistrationOptions, verifyAdminPasskeyRegistration } = require('./admin-webauthn-registration.service');
const { beginAdminPasskeyLogin, completeAdminPasskeyLogin } = require('./admin-login.service');
const { rotateAdminRefreshToken, revokeAdminSession, AdminSessionError } = require('./admin-session.service');
const { ADMIN_LOGIN_TICKET_TTL_SECONDS } = require('./admin-login-ticket.service');
const { setSessionCookies, clearCurrentSessionCookies, clearLegacyAccessCookie, readCookie, REFRESH_COOKIE } = require('./admin-auth.cookies');
const validate = require('./admin-auth.validation');

const userAgentOf = (req) => req.get('user-agent') || null;

async function inspectInvitation(req, res) {
  const { token } = validate.validateInspect(req);
  res.json(await inspectActivationInvitation(token));
}

async function acceptInvitation(req, res) {
  const { token, password } = validate.validateAccept(req);
  // Lets the error mapper tell the holder of this link why it failed (used / revoked / expired).
  res.locals.revealInvitationState = true;
  res.json(await acceptActivationInvitation({ token, password, context: { ipAddress: req.ip, userAgent: userAgentOf(req) } }));
}

async function redeemEnrollment(req, res) {
  const { token, password } = validate.validateRedeem(req);
  res.json(await redeemAdminPasskeyEnrollmentInvitation({ token, password, ipAddress: req.ip }));
}

async function registrationOptions(req, res) {
  const { ticket } = validate.validateRegistrationOptions(req);
  res.json({ options: await generateAdminPasskeyRegistrationOptions({ ticket, ipAddress: req.ip }) });
}

async function registrationVerify(req, res) {
  const { ticket, response, label } = validate.validateRegistrationVerify(req);
  res.json(await verifyAdminPasskeyRegistration({ ticket, response, label, ipAddress: req.ip }));
}

async function loginPassword(req, res) {
  const { email, password } = validate.validateLoginPassword(req);
  const { loginTicket, options } = await beginAdminPasskeyLogin({ email, password, ipAddress: req.ip });
  res.json({ loginTicket, options, loginTicketExpiresInSeconds: ADMIN_LOGIN_TICKET_TTL_SECONDS });
}

async function loginPasskey(req, res) {
  const { loginTicket, response } = validate.validateLoginPasskey(req);
  const result = await completeAdminPasskeyLogin({ loginTicket, response, ipAddress: req.ip, userAgent: userAgentOf(req) });
  // The cookies are the only place the tokens go. Writing the new access cookie does not replace a
  // legacy hc_admin_token (different Path), so that variant is cleared as well.
  clearLegacyAccessCookie(res);
  setSessionCookies(res, result);
  res.json({
    admin: result.admin,
    accessTokenExpiresInSeconds: result.accessTokenExpiresInSeconds,
    refreshExpiresAt: result.refreshExpiresAt,
  });
}

// Uses the refresh cookie and nothing else: not Bearer, not the access cookie.
async function refresh(req, res) {
  const outcome = await rotateAdminRefreshToken({ refreshToken: readCookie(req, REFRESH_COOKIE), ipAddress: req.ip });
  if (outcome.status === 'retry') {
    // A benign race (e.g. two tabs): another response already carries the new cookies. Touch
    // nothing - clearing here would erase the winner's cookie - and let the client retry once.
    res.set('Retry-After', '1');
    return res.status(409).json({ status: 'retry', code: 'refresh_retry' });
  }
  setSessionCookies(res, outcome);
  return res.json({ accessTokenExpiresInSeconds: outcome.accessTokenExpiresInSeconds, refreshExpiresAt: outcome.refreshExpiresAt });
}

// Behind requireAdminSession: ends the caller's own session only.
async function logout(req, res) {
  if (!req.user || !req.user.sessionId) throw new AdminSessionError();
  await revokeAdminSession({ sessionId: req.user.sessionId, adminId: Number(req.user.id), ipAddress: req.ip });
  // The legacy variant was already cleared by the route, before authentication ran.
  clearCurrentSessionCookies(res);
  res.json({ message: 'Logged out.' });
}

module.exports = {
  inspectInvitation,
  acceptInvitation,
  redeemEnrollment,
  registrationOptions,
  registrationVerify,
  loginPassword,
  loginPasskey,
  refresh,
  logout,
};
