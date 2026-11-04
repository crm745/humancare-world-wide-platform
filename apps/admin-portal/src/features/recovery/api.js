import { http, publicHttp } from '@/services/http';

// ---- the target Admin's side: public endpoints, never sent with the Admin's cookies -------------

// The invitation link and the CURRENT password. Resolves with the recovery ticket (kept by the
// caller in memory only); no session is created.
export async function redeemRecovery(token, password) {
  const { data } = await publicHttp.post('/admin/recovery/redeem', { token, password });
  return { ticket: data.recoveryTicket, ticketExpiresInSeconds: data.ticketExpiresInSeconds };
}

export async function recoveryRegistrationOptions(ticket) {
  const { data } = await publicHttp.post('/admin/recovery/passkeys/registration/options', { ticket });
  return data.options;
}

export async function recoveryRegistrationVerify(ticket, response, label) {
  const { data } = await publicHttp.post('/admin/recovery/passkeys/registration/verify', { ticket, response, ...(label ? { label } : {}) });
  return data; // { status: 'recovered', nextStep: 'sign_in' } - no session
}

// ---- a superadmin's decision: the signed-in session (cookies + CSRF header) ---------------------
// The caller's identity and session come from the server's own session check; the body carries
// only the passkey assertion and an optional reason.

// The open requests this superadmin can still decide on (read-only). Resolves with an array of
// { id, status, reason, createdAt, expiresAt, approvalsReceived, approvalsRequired, target: { id, name, email } }.
export async function listRecoveryRequests() {
  const { data } = await http.get('/admin/recovery/requests');
  return data.requests;
}

const stepUpPath = (kind, id) => `/admin/recovery/requests/${id}/${kind === 'approve' ? 'approval' : 'rejection'}/options`;

export async function recoveryStepUp(kind, requestId) {
  const { data } = await http.post(stepUpPath(kind, requestId));
  return data.options;
}

export async function recoveryDecision(kind, requestId, response, reason) {
  const { data } = await http.post(`/admin/recovery/requests/${requestId}/${kind}`, { response, ...(reason ? { reason } : {}) });
  return data; // { decision, requestId, status, validApprovals }
}
