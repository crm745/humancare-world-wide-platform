import { http } from '@/services/http';
import { fileNameFromDisposition, safeFileName } from './documentActions.mjs';

/**
 * GET /admin/requests. Resolves with { requests, total }.
 *  - status: one review status, or a comma-separated list (see OPEN_STATUSES)
 *  - search: request reference or patient name
 * `signal` lets the caller cancel a request that a newer one has replaced.
 */
export async function listRequests({ status, search, limit, offset, signal } = {}) {
  const params = { limit, offset };
  if (status) params.status = status;
  if (search) params.search = search;
  const { data } = await http.get('/admin/requests', { params, signal });
  return { requests: data.requests ?? [], total: Number.isInteger(data.total) ? data.total : undefined };
}

/** GET /admin/requests/:id. Resolves with the request (user, documents, events, case, summary). */
export async function getRequest(id, { signal } = {}) {
  const { data } = await http.get(`/admin/requests/${encodeURIComponent(id)}`, { signal });
  return data.request;
}

/**
 * GET .../documents/:docId/file as a Blob. Only the backend decides whether a file may be opened
 * (clean scan, intact checksum); a refusal arrives as an ApiError with the server's message (the
 * client turns a Blob error body back into JSON). The name comes from Content-Disposition when the
 * browser may read it (cross-origin it usually may not), otherwise from the document itself.
 */
export async function downloadDocument(requestId, doc) {
  const res = await http.get(`/admin/requests/${encodeURIComponent(requestId)}/documents/${encodeURIComponent(doc.id)}/file`, {
    responseType: 'blob',
    timeout: 120000,
  });
  const filename = fileNameFromDisposition(res.headers?.['content-disposition']) ?? safeFileName(doc.originalName);
  return { blob: res.data, filename };
}

/** POST .../documents/:docId/review. `reason` is sent only with a rejection. Resolves with the document. */
export async function reviewDocument(requestId, docId, { decision, reason }) {
  const body = decision === 'rejected' ? { decision, reason } : { decision };
  const { data } = await http.post(`/admin/requests/${encodeURIComponent(requestId)}/documents/${encodeURIComponent(docId)}/review`, body);
  return data.document;
}

/**
 * POST .../request-documents: asks the patient for more documents. `reason` (3 to 1000 characters, shown to the
 * patient) is trimmed by the server. Resolves with the updated request; the caller refetches the details.
 * Refused with 409 `request_approved` once the request is approved, and 404 when it does not exist.
 */
export async function requestDocuments(id, reason) {
  const { data } = await http.post(`/admin/requests/${encodeURIComponent(id)}/request-documents`, { reason });
  return data.request;
}

/**
 * POST /admin/requests/:id/approve. The backend approves the request and creates its Case in one transaction
 * (201 with the new Case; 200 if it was already approved). Resolves with { request, case, alreadyApproved }.
 * Refused with 409 `approval_blocked` (the body lists `blockers`), 404 when it does not exist, 400 for a bad id.
 * The frontend never creates a Case itself.
 */
export async function approveRequest(id) {
  const { data } = await http.post(`/admin/requests/${encodeURIComponent(id)}/approve`);
  return { request: data.request, case: data.case ?? null, alreadyApproved: Boolean(data.alreadyApproved) };
}
