// Pure rules for the patient's quotation card: which state the quotation is in, how its money and dates read, whether a rejection reason is good
// enough, and which of OUR messages explains a failed call. No network and no React, so Jest covers it (quotationView.test.js).
//
// The BACKEND decides everything (GET /requests/me/:id/quotation gives `expired` and `canDecide`); nothing here recomputes a rule, it only presents it.
import { formatMoney } from './money';

export const REASON_MIN = 3;
export const REASON_MAX = 1000;

/**
 * The payload of GET /requests/me/:id/quotation -> { kind, quotation, lastDecision }.
 *   none         nothing has been published to the patient yet
 *   available    published, not expired: Accept and Reject are offered
 *   expired      published but past its validity date: shown, but no decision can be made
 *   accepted     the patient accepted it: the confirmed decision is shown, nothing can change
 *   rejected     nothing is live and the newest version is the one the patient rejected
 *   unavailable  published but the server says a decision cannot be made now (for example the request is closed)
 */
export function quotationState(payload) {
  const quotation = payload && payload.quotation ? payload.quotation : null;
  const lastDecision = payload && payload.lastDecision ? payload.lastDecision : null;
  if (!quotation) return { kind: lastDecision && lastDecision.status === 'rejected' ? 'rejected' : 'none', quotation: null, lastDecision };
  if (quotation.status === 'accepted') return { kind: 'accepted', quotation, lastDecision: null };
  if (quotation.expired) return { kind: 'expired', quotation, lastDecision: null };
  if (quotation.status === 'published' && quotation.canDecide) return { kind: 'available', quotation, lastDecision: null };
  return { kind: 'unavailable', quotation, lastDecision: null };
}

/** "₹1,000.00" for "1000.000" INR: display only, nothing is calculated. An unusable amount reads as an empty string, never as zero. */
export const quotationAmount = (quotation) => (quotation ? formatMoney(quotation.amount, quotation.currency) : '');

/** The name a downloaded quotation PDF is saved under. */
export const quotationFilename = (quotation, referenceNumber) => `${referenceNumber || 'quotation'}-quotation-v${quotation.versionNumber}.pdf`;

/** A rejection reason: trimmed, 3 to 1000 characters (the server checks it again). { ok: true, value } or { ok: false, key } with an i18n key. */
export function validateRejectionReason(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length < REASON_MIN) return { ok: false, key: 'quotation_reason_short' };
  if (value.length > REASON_MAX) return { ok: false, key: 'quotation_reason_long' };
  return { ok: true, value };
}

// The server's codes for a decision (backend patient-quotations.service.js). Each has a message of ours in every language; the server's own English
// sentence is never shown.
const KEY_BY_CODE = {
  quotation_expired: 'quotation_err_expired',
  quotation_superseded: 'quotation_err_superseded',
  quotation_already_decided: 'quotation_err_decided',
  quotation_changed: 'quotation_err_changed',
  quotation_unavailable: 'quotation_err_unavailable',
  quotation_not_available: 'quotation_err_unavailable',
  case_closed: 'quotation_err_closed',
  quotation_not_found: 'quotation_err_notfound',
  reason_invalid: 'quotation_reason_short',
};

/** { key, stale }: the i18n key of our message and whether the quotation is no longer what the screen showed (the screen then reloads). */
export function decisionErrorInfo(err) {
  const code = err && err.code;
  const status = err && err.status;
  if (code === 'network' || (err && err.name === 'TypeError')) return { key: 'quotation_err_network', stale: false };
  if (code === 'session_expired' || code === 'not_signed_in' || code === 'session_unverified' || status === 401) return { key: 'quotation_err_session', stale: false };
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(KEY_BY_CODE, code)) return { key: KEY_BY_CODE[code], stale: code !== 'reason_invalid' };
  if (status === 404 || status === 409) return { key: 'quotation_err_changed', stale: true };
  if (status === 429) return { key: 'quotation_err_busy', stale: false };
  return { key: 'quotation_err_generic', stale: false };
}
