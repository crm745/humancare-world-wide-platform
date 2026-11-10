import { Check, Download, FileText, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/utils/cn';
import { documentActions } from '../documentActions.mjs';
import { documentView } from '../requestDetails.mjs';
import { formatDateTime } from '../format';

// Read-only. Every version is listed, including replaced ones; severity is shown by the card's
// border and background as well as by its badges, so it never depends on colour alone.
const SEVERITY = {
  infected: 'border-red-400 bg-red-50',
  scan_failed: 'border-red-300 bg-red-50/80',
  scan_error: 'border-red-200 bg-red-50/60',
  rejected: 'border-amber-300 bg-amber-50/70',
  normal: 'border-slate-200 bg-white',
};

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-slate-500 sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

// `actions` (optional): { request, downloadingId, onDownload, onApprove, onReject }. What each card
// offers comes from documentActions(); the backend enforces the same rules again.
function DocumentCard({ doc, view, actions }) {
  const allowed = actions ? documentActions(doc, actions.request) : null;
  const downloading = actions?.downloadingId === doc.id;
  return (
    <li
      data-severity={view.severity}
      data-superseded={view.superseded || undefined}
      className={cn('rounded-lg border p-4', SEVERITY[view.severity], view.superseded && 'opacity-75')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-ink">{view.name}</p>
            <p className="text-xs text-slate-500">
              Uploaded {formatDateTime(view.uploadedAt)}
              {view.size ? ` · ${view.size}` : ''}
              {view.mimeType ? ` · ${view.mimeType}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {view.superseded && <Badge tone="neutral">Replaced</Badge>}
          <Badge tone={view.scan.tone} prominent={view.scan.prominent}>{view.scan.label}</Badge>
          <Badge tone={view.review.tone}>{view.review.label}</Badge>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 text-sm text-slate-700">
        {view.severity === 'infected' && (
          <p className="flex items-start gap-2 font-medium text-red-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            This file failed the virus scan and is quarantined. Nobody can open it.
          </p>
        )}
        {view.severity === 'scan_failed' && (
          <p className="flex items-start gap-2 font-medium text-red-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            This file can never be scanned (it is missing or was altered). It cannot be opened or reviewed: ask the patient to upload a replacement.
          </p>
        )}
        {view.severity === 'scan_error' && (
          <p className="flex items-start gap-2 font-medium text-red-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            The virus scan could not be completed. It is retried automatically.
          </p>
        )}
        <dl className="space-y-1.5">
          {view.scanDetail && <Row label="Scan detail">{view.scanDetail}</Row>}
          {view.scannedAt && <Row label="Scanned">{formatDateTime(view.scannedAt)}</Row>}
          {view.reviewedAt && (
            <Row label="Reviewed">
              {formatDateTime(view.reviewedAt)}
              {view.reviewedBy ? ` by ${view.reviewedBy}` : ''}
            </Row>
          )}
          {view.rejectionReason && (
            <Row label="Rejection reason">
              <span className="font-medium text-amber-900">{view.rejectionReason}</span>
            </Row>
          )}
          {view.replaces && (
            <Row label="Replaces">{view.replaces.name ? `${view.replaces.name} (document #${view.replaces.id})` : `document #${view.replaces.id}`}</Row>
          )}
          {view.replacedBy && (
            <Row label="Replaced by">
              {view.replacedBy.name} (document #{view.replacedBy.id}){view.supersededAt ? `, ${formatDateTime(view.supersededAt)}` : ''}
            </Row>
          )}
        </dl>
        {allowed?.note && <p className="text-xs text-slate-500">{allowed.note}</p>}
      </div>

      {allowed && (allowed.download || allowed.approve || allowed.reject) && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/70 pt-3">
          {allowed.download && (
            <Button variant="secondary" size="sm" aria-label={`Download ${view.name}`} loading={downloading} disabled={actions.downloadingId != null} onClick={() => actions.onDownload(doc)}>
              {!downloading && <Download className="h-4 w-4" />}
              Download
            </Button>
          )}
          {allowed.approve && (
            <Button size="sm" aria-label={`Approve ${view.name}`} onClick={() => actions.onApprove(doc)}>
              <Check className="h-4 w-4" />
              Approve
            </Button>
          )}
          {allowed.reject && (
            <Button variant="secondary" size="sm" className="!border-red-200 !text-red-700 hover:!bg-red-50" aria-label={`Reject ${view.name}`} onClick={() => actions.onReject(doc)}>
              <X className="h-4 w-4" />
              Reject
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function DocumentHistory({ documents, actions }) {
  if (!documents?.length) {
    return <EmptyState icon={FileText} title="No documents uploaded" description="The patient has not uploaded a document for this request." />;
  }
  return (
    <ul className="space-y-3" aria-label="Document history">
      {documents.map((doc) => (
        <DocumentCard key={doc.id} doc={doc} view={documentView(doc, documents)} actions={actions} />
      ))}
    </ul>
  );
}
