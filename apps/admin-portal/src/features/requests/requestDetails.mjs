// Turns the GET /admin/requests/:id response into what the details page shows. Pure and
// DOM-free so `node --test` can run it. Nothing here invents a value: a field the API did not
// send stays missing, and an Admin is only ever "Admin #<id>" because the API sends no names.

const CARE_LEVEL_LABEL = {
  care_icu: 'ICU / Critical',
  care_stable: 'Stable / Monitored',
  care_ambulatory: 'Ambulatory',
  care_na: 'Not Applicable',
};
const MOBILITY_LABEL = { bedridden: 'Bedridden', wheelchair: 'Wheelchair', walking: 'Walking' };

const has = (value) => value !== null && value !== undefined && String(value).trim() !== '';

/** "care_icu,care_stable" -> "ICU / Critical, Stable / Monitored". Anything else is shown as stored. */
export function careLevelLabel(value) {
  if (!has(value)) return null;
  return String(value)
    .split(',')
    .map((piece) => CARE_LEVEL_LABEL[piece.trim()] ?? piece.trim())
    .join(', ');
}

export const mobilityLabel = (value) => (has(value) ? MOBILITY_LABEL[value] ?? String(value) : null);

export function capitalise(value) {
  return has(value) ? String(value).charAt(0).toUpperCase() + String(value).slice(1) : null;
}

/** Equipment the patient needs: only the flags that are true (null/false are not shown as "needed"). */
export function equipmentList(request) {
  const list = [];
  if (request.equipOxygen === true) list.push('Oxygen');
  if (request.equipCardiacMonitor === true) list.push('Cardiac monitor');
  if (request.equipVentilator === true) list.push('Ventilator');
  return list;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const adminLabel = (id) => (id == null ? 'Admin' : `Admin #${id}`);

// ---- documents ---------------------------------------------------------------------------------

const SCAN_BADGE = {
  pending: { label: 'Awaiting scan', tone: 'warning' },
  clean: { label: 'Scan clean', tone: 'success' },
  infected: { label: 'Infected', tone: 'danger', prominent: true },
  error: { label: 'Scan error', tone: 'danger' },
  failed: { label: 'Scan failed', tone: 'danger' }, // can never be scanned: the file is gone or altered
};
const REVIEW_BADGE = {
  pending: { label: 'Awaiting review', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'warning' },
};

/**
 * One row of the document history. `severity` drives the card styling:
 * 'infected' > 'scan_failed' > 'scan_error' > 'rejected' > 'normal'; `superseded` documents are dimmed but keep
 * their own severity, so a rejected original stays visibly rejected.
 */
export function documentView(doc, allDocs) {
  const byId = new Map(allDocs.map((d) => [d.id, d]));
  const replaces = doc.replacesId != null ? byId.get(doc.replacesId) : null;
  const replacedBy = allDocs.find((d) => d.replacesId === doc.id) ?? null;
  const scan = SCAN_BADGE[doc.scanStatus] ?? { label: String(doc.scanStatus ?? 'Unknown'), tone: 'neutral' };
  const reviewable = doc.scanStatus === 'clean';
  const review = REVIEW_BADGE[doc.reviewStatus] ?? { label: String(doc.reviewStatus ?? 'Unknown'), tone: 'neutral' };

  let severity = 'normal';
  if (doc.scanStatus === 'infected') severity = 'infected';
  else if (doc.scanStatus === 'failed') severity = 'scan_failed';
  else if (doc.scanStatus === 'error') severity = 'scan_error';
  else if (doc.reviewStatus === 'rejected') severity = 'rejected';

  return {
    id: doc.id,
    name: doc.originalName,
    size: formatBytes(doc.sizeBytes),
    mimeType: has(doc.mimeType) ? doc.mimeType : null,
    uploadedAt: doc.uploadedAt,
    scan,
    scanDetail: has(doc.scanDetail) ? doc.scanDetail : null,
    scannedAt: doc.scannedAt ?? null,
    // Review only exists for a clean document; otherwise say so instead of showing "awaiting review".
    review: reviewable || doc.reviewStatus !== 'pending' ? review : { label: 'Not reviewable until scanned clean', tone: 'neutral' },
    reviewedAt: doc.reviewedAt ?? null,
    reviewedBy: doc.reviewedByAdminId != null ? adminLabel(doc.reviewedByAdminId) : null,
    rejectionReason: has(doc.rejectionReason) ? doc.rejectionReason : null,
    replaces: doc.replacesId != null ? { id: doc.replacesId, name: replaces?.originalName ?? null } : null,
    replacedBy: replacedBy ? { id: replacedBy.id, name: replacedBy.originalName } : null,
    superseded: Boolean(doc.supersededAt),
    supersededAt: doc.supersededAt ?? null,
    severity,
  };
}

// ---- timeline ----------------------------------------------------------------------------------

const STATUS_LABEL = {
  awaiting_documents: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};
const statusLabel = (status) => STATUS_LABEL[status] ?? status;

/** Oldest first; the id breaks ties between events written in the same instant. */
export function sortEvents(events) {
  return [...events].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || a.id - b.id);
}

function actorLabel(event, user) {
  if (event.actorType === 'admin') return adminLabel(event.actorId);
  if (event.actorType === 'system') return 'System';
  if (event.actorType === 'patient') {
    // The patient's own account name is in the response; use it only when the ids agree.
    return user && event.actorId === user.id && has(user.name) ? `Patient (${user.name})` : 'Patient';
  }
  return has(event.actorType) ? capitalise(event.actorType) : null;
}

/**
 * One timeline entry: { id, at, title, tone, lines[], actor }. `lines` are plain facts taken from
 * the event's `detail`; nothing is added that the event did not record.
 */
export function eventView(event, { documents = [], user = null } = {}) {
  const d = event.detail && typeof event.detail === 'object' ? event.detail : {};
  const doc = event.documentId != null ? documents.find((x) => x.id === event.documentId) : null;
  const docName = d.name ?? doc?.originalName ?? (event.documentId != null ? `document #${event.documentId}` : null);
  const lines = [];
  let title;
  let tone = 'neutral';

  switch (event.action) {
    case 'request_created':
      title = 'Request created';
      if (d.referenceNumber) lines.push(d.referenceNumber);
      break;
    case 'document_uploaded':
      title = 'Document uploaded';
      if (docName) lines.push(docName);
      if (formatBytes(d.sizeBytes)) lines.push(formatBytes(d.sizeBytes));
      break;
    case 'document_replaced': {
      title = 'Replacement uploaded';
      if (docName) lines.push(docName);
      if (d.replacesId != null) {
        const old = documents.find((x) => x.id === d.replacesId);
        lines.push(`Replaces ${old ? `"${old.originalName}"` : `document #${d.replacesId}`}`);
      }
      break;
    }
    case 'scan_clean':
      title = 'Virus scan clean';
      tone = 'success';
      if (docName) lines.push(docName);
      break;
    case 'scan_infected':
      title = 'Virus scan: infected';
      tone = 'danger';
      if (docName) lines.push(docName);
      if (d.detail) lines.push(String(d.detail));
      break;
    case 'scan_failed':
      title = 'Virus scan failed for good';
      tone = 'danger';
      if (docName) lines.push(docName);
      if (d.detail) lines.push(String(d.detail));
      break;
    case 'scan_error':
      title = 'Virus scan error';
      tone = 'danger';
      if (docName) lines.push(docName);
      if (d.detail) lines.push(String(d.detail));
      break;
    case 'document_downloaded':
      title = 'Document opened by an Admin';
      if (docName) lines.push(docName);
      break;
    case 'document_approved':
      title = 'Document approved';
      tone = 'success';
      if (docName) lines.push(docName);
      break;
    case 'document_rejected':
      title = 'Document rejected';
      tone = 'warning';
      if (docName) lines.push(docName);
      if (d.reason) lines.push(`Reason: ${d.reason}`);
      break;
    case 'documents_requested':
      title = 'Additional documents requested';
      tone = 'warning';
      if (d.reason) lines.push(`Reason: ${d.reason}`);
      break;
    case 'status_changed':
      title = 'Status changed';
      if (event.fromStatus || event.toStatus) {
        lines.push(`${event.fromStatus ? statusLabel(event.fromStatus) : '—'} → ${event.toStatus ? statusLabel(event.toStatus) : '—'}`);
      }
      break;
    case 'request_approved':
      title = 'Request approved';
      tone = 'success';
      if (Number.isInteger(d.documents)) lines.push(`${d.documents} document${d.documents === 1 ? '' : 's'} attached to the Case`);
      break;
    case 'case_created':
      title = 'Case created';
      tone = 'success';
      if (d.caseReference) lines.push(d.caseReference);
      break;
    default:
      title = String(event.action ?? 'Event').replace(/_/g, ' ');
      title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  return { id: event.id, at: event.occurredAt, title, tone, lines, actor: actorLabel(event, user) };
}

/** Where "back" goes when the page was not opened from a list: drafts have their own list. */
export function backTarget(request, from) {
  if (from === '/requests' || from === '/requests/drafts') return from;
  return request?.reviewStatus === 'awaiting_documents' ? '/requests/drafts' : '/requests';
}

export const backLabel = (path) => (path === '/requests/drafts' ? 'Drafts' : 'Incomplete Submissions');
