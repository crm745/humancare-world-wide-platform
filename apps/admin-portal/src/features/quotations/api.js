import { http } from '@/services/http';

/** GET /admin/cases/:id/quotations (numeric id or CASE-... reference). Resolves { caseId, caseReference, quotations (newest first), livePublishedId }. 404 when the Case has no quotations feature (not a Private Charter Case). */
export async function listCaseQuotations(caseId, { signal } = {}) {
  const { data } = await http.get(`/admin/cases/${encodeURIComponent(caseId)}/quotations`, { signal });
  return { caseId: data.caseId, caseReference: data.caseReference, quotations: Array.isArray(data.quotations) ? data.quotations : [], livePublishedId: data.livePublishedId ?? null };
}

// Every state-changing call names the REVISION the Admin looked at: the server refuses (409 quotation_changed) when the version changed since
// (for example Bitrix24 sent a new PDF). Each resolves { quotation, already... }.
export async function confirmQuotation(id, revision) {
  const { data } = await http.post(`/admin/quotations/${encodeURIComponent(id)}/confirm`, { revision });
  return data;
}

export async function publishQuotation(id, revision) {
  const { data } = await http.post(`/admin/quotations/${encodeURIComponent(id)}/publish`, { revision });
  return data;
}

/** `reason` (3 to 1000 characters) is mandatory; it is kept on the version and never shown to the patient. */
export async function withdrawQuotation(id, revision, reason) {
  const { data } = await http.post(`/admin/quotations/${encodeURIComponent(id)}/withdraw`, { revision, reason });
  return data;
}

export async function createNewVersion(id, revision) {
  const { data } = await http.post(`/admin/quotations/${encodeURIComponent(id)}/new-version`, { revision });
  return data;
}

/** GET .../file as a Blob. Only the backend decides whether it may be opened (clean scan, intact checksum); a refusal arrives as an ApiError. */
export async function fetchQuotationFile(id, { inline = false } = {}) {
  const res = await http.get(`/admin/quotations/${encodeURIComponent(id)}/file`, { params: inline ? { disposition: 'inline' } : undefined, responseType: 'blob', timeout: 120000 });
  return res.data;
}
