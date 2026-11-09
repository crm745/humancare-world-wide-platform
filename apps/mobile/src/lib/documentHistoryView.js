// Pure view rules for the documents of a request on the request-details screen (no React, no native
// modules), so they can be unit-tested. Built only on documentHistory(), which already limits what a
// document shows to safe display fields: nothing here can reach a storage name, checksum or file URL.
import { documentHistory, reviewState } from './requestDocuments';
import { formatDisplayDate } from './requestShape';

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const STATUS_CLASS = {
  approved: 'text-success',
  rejected: 'text-danger',
  unsafe: 'text-danger',
  scan_failed: 'text-danger',
  awaiting_review: 'text-primary',
  checking: 'text-faint',
};

// One row per version, oldest upload first, every version kept:
//   name, meta ("2 KB · 01 Nov 2026"), statusLabel / statusClass, reason (rejected only), guidance (what to do, for a
//   current file that could not be accepted or checked),
//   notes ("Replaces x.pdf", "Replaced by y.pdf"), superseded (an earlier version, shown dimmed)
// A rejected version that has been replaced no longer asks for a replacement, so it just reads "Rejected".
export function historyRows(requestDocuments) {
  const items = documentHistory(requestDocuments);
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    const notes = [];
    if (item.replacesId !== null) notes.push(`Replaces ${byId.get(item.replacesId).name}`);
    if (item.replacedById !== null) notes.push(`Replaced by ${byId.get(item.replacedById).name}`);
    return {
      id: item.id,
      name: item.name,
      meta: [formatSize(item.sizeBytes), item.uploadedAt ? formatDisplayDate(item.uploadedAt) : ''].filter(Boolean).join(' · '),
      status: item.status,
      statusLabel: !item.isCurrent && item.status === 'rejected' ? 'Rejected' : item.statusLabel,
      statusClass: STATUS_CLASS[item.status] || 'text-faint',
      reason: item.rejectionReason,
      guidance: item.guidance,
      notes,
      superseded: !item.isCurrent,
    };
  });
}

// The "Documents" line of the request details.
//   workflow request  the current documents of requestDocuments (a replaced version is not counted)
//   anything else     the Case documents, exactly as the screen always showed them
export function documentsSummary(request) {
  if (reviewState(request) !== null) {
    const current = documentHistory(request.requestDocuments).filter((d) => d.isCurrent);
    return current.length ? `${current[0].name}${current.length > 1 ? ` +${current.length - 1}` : ''} >` : 'No documents yet';
  }
  const docs = request?.case?.documents || [];
  return docs.length ? `${docs[0].name}${docs.length > 1 ? ` +${docs.length - 1}` : ''} >` : 'No documents yet';
}
