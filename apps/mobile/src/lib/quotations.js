// The patient's quotation calls (backend modules/quotations/patient-quotations.*). The patient token and the session renewal are the existing ones
// (lib/api.js); nothing here builds a URL to a file: the PDF goes through the authenticated download, never a link.
import { apiGet, apiPost } from './api';
import { downloadDocument, downloadErrorInfo } from './download';
import { decisionErrorInfo, quotationFilename, validateRejectionReason } from './quotationView';

const id = (value) => encodeURIComponent(String(value));

/** GET /requests/me/:id/quotation -> { quotation, lastDecision }. A 404 (not a Private Charter request, or not yours) rejects with status 404. */
export const fetchQuotation = (requestId) => apiGet(`/requests/me/${id(requestId)}/quotation`);

/** POST /quotations/:id/accept for the EXACT version shown. Resolves { alreadyAccepted, quotation }. */
export const acceptQuotation = (quotationId) => apiPost(`/quotations/${id(quotationId)}/accept`, {});

/** POST /quotations/:id/reject. The reason is checked here first, so an unusable one never reaches the server. Resolves { alreadyRejected, quotation }. */
export function rejectQuotation(quotationId, reason) {
  const check = validateRejectionReason(reason);
  if (!check.ok) return Promise.reject(Object.assign(new Error('The rejection reason is not valid.'), { code: 'reason_invalid' }));
  return apiPost(`/quotations/${id(quotationId)}/reject`, { reason: check.value });
}

/** The PDF, through the authenticated download (renews an expired session once, reports progress, never leaves a copy on the phone). */
export const downloadQuotation = (quotation, referenceNumber, options) => downloadDocument(`/quotations/${id(quotation.id)}/file`, quotationFilename(quotation, referenceNumber), options);

/**
 * One decision, start to finish, for the EXACT version given. Never throws:
 *   { ok: true, kind, already }        the server recorded it (already: it had been recorded before)
 *   { ok: false, key, stale }          our message (i18n key) and whether the quotation is no longer what the screen showed (the screen reloads)
 */
export async function performDecision(kind, quotation, reason) {
  try {
    const result = kind === 'accept' ? await acceptQuotation(quotation.id) : await rejectQuotation(quotation.id, reason);
    return { ok: true, kind, already: Boolean(result.alreadyAccepted || result.alreadyRejected) };
  } catch (err) {
    const info = decisionErrorInfo(err);
    return { ok: false, key: info.key, stale: info.stale };
  }
}

/** The PDF download as { ok: true } or { ok: false, key, stale } (stale: a 404/409, so the screen reloads). */
export async function performDownload(quotation, referenceNumber) {
  try {
    await downloadQuotation(quotation, referenceNumber);
    return { ok: true };
  } catch (err) {
    return { ok: false, key: downloadErrorInfo(err).key, stale: Boolean(err && (err.status === 404 || err.status === 409)) };
  }
}
