import { FilePlus2, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { canOpenDocumentRequest, documentRequestRows } from '../shares.mjs';
import { documentView } from '../requestDetails.mjs';
import { formatDateTime } from '../format';

// Post-Case document requests: what the Admin asked the patient for after the approval, and the documents sent for each.
// The documents themselves are reviewed, downloaded and shared from the Document history above; this lists them in context.
export function DocumentRequests({ request, busy, onOpen }) {
  const rows = documentRequestRows(request);
  const offer = canOpenDocumentRequest(request);
  const all = request.requestDocuments ?? [];
  return (
    <div className="space-y-3">
      {offer.allowed && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onOpen} disabled={busy}>
            <FilePlus2 className="h-4 w-4" />
            Request documents
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No documents have been requested since the Case was opened.</p>
      ) : (
        <ul className="space-y-3" aria-label="Document requests">
          {rows.map((row) => (
            <li key={row.id} data-status={row.status} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-semibold text-ink">{row.description}</p>
                <Badge tone={row.tone}>{row.label}</Badge>
              </div>
              {row.reason && <p className="mt-1 text-sm text-slate-600">{row.reason}</p>}
              <p className="mt-1 text-xs text-slate-500">
                Requested {formatDateTime(row.createdAt)}
                {row.resolvedAt ? ` · closed ${formatDateTime(row.resolvedAt)}` : ''}
              </p>
              {row.documents.length > 0 ? (
                <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3" aria-label={`Documents sent for request ${row.id}`}>
                  {row.documents.map((doc) => {
                    const view = documentView(doc, all);
                    return (
                      <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                          <span className="min-w-0 break-words">{view.name}</span>
                        </span>
                        <span className="flex flex-wrap gap-1.5">
                          {view.superseded && <Badge tone="neutral">Replaced</Badge>}
                          <Badge tone={view.scan.tone} prominent={view.scan.prominent}>{view.scan.label}</Badge>
                          <Badge tone={view.review.tone}>{view.review.label}</Badge>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-slate-500">Nothing uploaded for this request yet.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
