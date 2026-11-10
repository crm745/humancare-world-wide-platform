// What the Cases pages show, derived from GET /admin/cases and GET /admin/cases/:id. Pure and DOM-free so
// `node --test` can run it. Nothing here invents a field. The details response carries storage paths
// (`fileUrl`); `documentView` copies only the safe fields, so a path can never reach the page.

export const CASE_STATUS_LABEL = {
  submitted: 'Submitted',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const CASE_STATUS_TONE = { submitted: 'info', scheduled: 'info', in_progress: 'warning', completed: 'success', cancelled: 'neutral' };

export const CASE_URGENCY_LABEL = { routine: 'Routine', urgent: 'Urgent', critical: 'Critical' };

export const PAGE_SIZE = 25;

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

export const caseStatusLabel = (status) => CASE_STATUS_LABEL[status] ?? (has(status) ? String(status).replace(/_/g, ' ') : 'Unknown');
export const caseStatusTone = (status) => CASE_STATUS_TONE[status] ?? 'neutral';
export const caseUrgencyLabel = (urgency) => (has(urgency) ? CASE_URGENCY_LABEL[urgency] ?? String(urgency) : null);

/** Where the Case came from: the corporate that submitted it, or a patient's approved request. */
export function caseSource(c) {
  if (c?.corporate?.companyName) return c.corporate.companyName;
  if (c?.corporateId != null) return `Corporate #${c.corporateId}`;
  return 'Patient request';
}

/** Case-insensitive search over what the list shows. An empty search keeps every Case. */
export function filterCases(cases, search) {
  const q = String(search ?? '').trim().toLowerCase();
  if (!q) return cases;
  return cases.filter((c) =>
    [c.referenceNumber, c.patientName, c.serviceType, c.origin, c.destination, c.country, caseSource(c)].some((v) => has(v) && String(v).toLowerCase().includes(q)),
  );
}

export function pageOf(items, offset, limit = PAGE_SIZE) {
  return items.slice(offset, offset + limit);
}

/** A case id in the URL: the numeric id, or the CASE-... reference the API also accepts. */
export function validCaseId(id) {
  const s = String(id ?? '');
  return /^\d+$/.test(s) || /^CASE-\d+$/i.test(s) ? s : null;
}

/** The request this Case came from, or null (corporate Cases have none). */
export function linkedRequest(c) {
  const r = c?.serviceRequest;
  return r && r.id != null ? { id: r.id, referenceNumber: r.referenceNumber ?? `Request #${r.id}` } : null;
}

/** Stage events, oldest first. The id breaks ties. */
export function sortStageEvents(events) {
  return [...(events ?? [])].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || a.id - b.id);
}

/** A Case document as shown: name, kind, size, upload time. The stored path is deliberately dropped. */
export function documentView(d) {
  return {
    id: d.id,
    name: d.name,
    type: has(d.type) ? d.type : null,
    sizeBytes: Number.isFinite(d.fileSizeBytes) ? d.fileSizeBytes : null,
    uploadedAt: d.uploadedAt ?? null,
  };
}

/**
 * The patient-request document (from GET /admin/requests/:id) that became this Case document, if any,
 * matched by `caseDocumentId`. Only that record carries the scan and review state the download rules use.
 */
export function sourceDocumentFor(caseDocument, requestDocuments) {
  return (requestDocuments ?? []).find((rd) => rd.caseDocumentId === caseDocument.id) ?? null;
}
