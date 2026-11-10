// HTTP handlers for the Admin passkey-recovery endpoints. Thin by design, like
// admin-auth.controller.js: validate the body, call the existing recovery service with the
// arguments it takes, and shape the response from an allowlist. No recovery rule lives here.
//
// Identity is never taken from the request. The approving Admin and the session come from
// req.user, which requireAdminSession filled from the database-backed session; the request id
// comes from the path; bodies are validated with unknown fields refused, so an adminId or
// sessionId in a body is rejected, not trusted.
//
// Nothing here sets a cookie or creates a session or access token. The raw invitation token is
// only ever read from the redemption body and handed to the service; it is not logged, echoed or
// kept. Service errors are mapped by admin-auth.errors.js (fixed messages, coarse codes);
// anything unexpected becomes the app's generic 500.
const {
  issueRecoveryStepUp,
  approveRecoveryRequest,
  rejectRecoveryRequest,
  RecoveryDecisionError,
} = require('./admin-recovery-decision.service');
const {
  redeemRecoveryInvitation,
  generateRecoveryRegistrationOptions,
  verifyRecoveryPasskeyRegistration,
} = require('./admin-recovery-registration.service');
const { listDecidableRequests } = require('./admin-recovery-request.service');
const validate = require('./admin-auth.validation');

// The approver, from the verified session only. A request without a database-backed session cannot
// get here (requireAdminSession), but a missing one is refused rather than guessed at.
function approverFrom(req) {
  const approverId = Number(req.user && req.user.id);
  const sessionId = Number(req.user && req.user.sessionId);
  if (!Number.isInteger(approverId) || approverId <= 0 || !Number.isInteger(sessionId) || sessionId <= 0) {
    throw new RecoveryDecisionError('not_available', 'no_session');
  }
  return { approverId, sessionId };
}

const stepUp = (kind) => async (req, res) => {
  const requestId = validate.validateRecoveryRequestId(req);
  validate.validateNoBody(req);
  const { approverId, sessionId } = approverFrom(req);
  const issued = await issueRecoveryStepUp({ kind, requestId, approverId, sessionId, ipAddress: req.ip });
  res.json({ decision: issued.decision, requestId: issued.requestId, options: issued.options, expiresAt: issued.expiresAt });
};

const decision = (service) => async (req, res) => {
  const requestId = validate.validateRecoveryRequestId(req);
  const { response, reason } = validate.validateRecoveryDecision(req);
  const { approverId, sessionId } = approverFrom(req);
  const result = await service({ requestId, approverId, sessionId, response, reason, ipAddress: req.ip });
  // Allowlist: the outcome only. No invitation id, no delivery text, nothing about the target.
  res.json({ decision: result.decision, requestId: result.requestId, status: result.status, validApprovals: result.validApprovals });
};

// The open requests this superadmin can decide on. Read-only; the caller comes from the session.
async function list(req, res) {
  const { approverId } = approverFrom(req);
  const requests = await listDecidableRequests({ approverId });
  res.json({ requests });
}

async function redeem(req, res) {
  const { token, password } = validate.validateRedeem(req);
  const result = await redeemRecoveryInvitation({ token, password, ipAddress: req.ip });
  res.json({
    status: result.status,
    nextStep: result.nextStep,
    recoveryTicket: result.recoveryTicket,
    ticketExpiresInSeconds: result.ticketExpiresInSeconds,
  });
}

async function registrationOptions(req, res) {
  const { ticket } = validate.validateRegistrationOptions(req);
  res.json({ options: await generateRecoveryRegistrationOptions({ ticket, ipAddress: req.ip }) });
}

async function registrationVerify(req, res) {
  const { ticket, response, label } = validate.validateRegistrationVerify(req);
  const result = await verifyRecoveryPasskeyRegistration({ ticket, response, label, ipAddress: req.ip });
  // No session, token or cookie: the Admin signs in again with the new passkey.
  res.json({ status: result.status, nextStep: result.nextStep });
}

module.exports = {
  list,
  approvalOptions: stepUp('approve'),
  rejectionOptions: stepUp('reject'),
  approve: decision(approveRecoveryRequest),
  reject: decision(rejectRecoveryRequest),
  redeem,
  registrationOptions,
  registrationVerify,
};
