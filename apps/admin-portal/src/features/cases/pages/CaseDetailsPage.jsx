import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileQuestion, FileText, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Loading';
import { usePageTitle } from '@/hooks/usePageTitle';
import { DetailSection, Field, FieldList } from '../../requests/components/DetailSection';
import { documentActions } from '../../requests/documentActions.mjs';
import { formatDateTime } from '../../requests/format';
import { capitalise, careLevelLabel, formatBytes } from '../../requests/requestDetails.mjs';
import { useDocumentActions } from '../../requests/useDocumentActions';
import { useRequestDetails } from '../../requests/useRequestDetails';
import { caseSource, caseStatusLabel, caseStatusTone, caseUrgencyLabel, documentView, linkedRequest, sortStageEvents, sourceDocumentFor, validCaseId } from '../caseView.mjs';
import { useCaseDetails } from '../useCaseDetails';

// One operational Case (GET /admin/cases/:id), read-only. Case documents can be downloaded only through the
// request they came from, with the same rules as on the request page (clean and current); the Case API has
// no download of its own.
export default function CaseDetailsPage() {
  const { id } = useParams();
  const validId = validCaseId(id);
  const { caseRecord, loading, error, notFound, reload } = useCaseDetails(validId);
  usePageTitle(caseRecord ? caseRecord.referenceNumber : 'Case');

  const request = linkedRequest(caseRecord);
  // The source request carries the scan and review state of each document; without it nothing is offered.
  const source = useRequestDetails(request ? String(request.id) : null);
  const docs = useDocumentActions(request?.id ?? null, { onChanged: source.reload });

  const backLink = (
    <Link to="/cases" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to Cases
    </Link>
  );

  if (!validId || notFound) {
    return (
      <div className="space-y-6">
        {backLink}
        <EmptyState icon={FileQuestion} title="Case not found" description="This Case does not exist." />
      </div>
    );
  }
  if (!caseRecord) {
    if (error) {
      return (
        <div className="space-y-6">
          {backLink}
          <Alert tone="error">{error}</Alert>
          <Button variant="secondary" onClick={reload} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      );
    }
    return <PageLoader />;
  }

  const c = caseRecord;
  const events = sortStageEvents(c.stageEvents);
  const documents = (c.documents ?? []).map(documentView);
  const requestDocuments = source.request?.requestDocuments ?? [];

  return (
    <div className="space-y-6">
      {backLink}

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-ink">{c.referenceNumber}</h1>
              <Badge tone={caseStatusTone(c.status)}>{caseStatusLabel(c.status)}</Badge>
            </div>
            <p className="mt-1 text-base font-medium text-slate-800">{c.patientName}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              Opened {formatDateTime(c.createdAt)} · {caseSource(c)}
            </p>
            {request && (
              <p className="mt-2 text-sm text-slate-600">
                From request{' '}
                <Link to={`/requests/${request.id}`} className="font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
                  {request.referenceNumber}
                </Link>
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        </div>
        {error && <Alert tone="error" className="mt-4">{error}</Alert>}
      </header>

      {docs.notice && <Alert tone={docs.notice.tone}>{docs.notice.text}</Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailSection title="Service">
            <FieldList>
              <Field label="Service type" value={c.serviceType} />
              <Field label="Urgency" value={caseUrgencyLabel(c.urgency)} optional />
              <Field label="Origin" value={c.origin} />
              <Field label="Destination" value={c.destination} />
              <Field label="Country" value={c.country} optional />
              <Field label="Care level" value={careLevelLabel(c.careLevel)} optional />
              <Field label="Policy reference" value={c.policyReference} optional />
              <Field label="Description" value={c.description} wide optional />
              <Field label="Additional information" value={c.additionalInfo} wide optional />
              <Field label="Special requirements" value={c.specialRequirements} wide optional />
            </FieldList>
          </DetailSection>

          <DetailSection title={`Documents (${documents.length})`}>
            {documents.length === 0 ? (
              <p className="text-sm text-slate-500">No documents are attached to this Case.</p>
            ) : (
              <ul className="space-y-3" aria-label="Case documents">
                {documents.map((d) => {
                  const original = sourceDocumentFor(d, requestDocuments);
                  const canDownload = original ? documentActions(original, source.request).download : false;
                  const downloading = docs.downloadingId === original?.id;
                  return (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="break-words text-sm font-semibold text-ink">{d.name}</p>
                          <p className="text-xs text-slate-500">
                            {[d.type, formatBytes(d.sizeBytes), d.uploadedAt ? `Added ${formatDateTime(d.uploadedAt)}` : null].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                      </div>
                      {canDownload && (
                        <Button variant="secondary" size="sm" aria-label={`Download ${d.name}`} loading={downloading} disabled={docs.downloadingId != null} onClick={() => docs.download(original)}>
                          {!downloading && <Download className="h-4 w-4" />}
                          Download
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {documents.length > 0 && !request && <p className="mt-3 text-xs text-slate-500">Documents of Cases submitted by a corporate cannot be downloaded from the Admin Portal.</p>}
            {request && source.error && !source.request && <p className="mt-3 text-xs text-slate-500">Download is unavailable because the source request could not be loaded.</p>}
          </DetailSection>

          <DetailSection title="Stage timeline">
            {events.length === 0 ? (
              <p className="text-sm text-slate-500">No stage changes recorded.</p>
            ) : (
              <ol className="relative space-y-5 border-l border-slate-200 pl-6" aria-label="Stage timeline">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[1.9rem] top-1.5 h-3 w-3 rounded-full bg-brand-600 ring-4 ring-white" aria-hidden="true" />
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <p className="text-sm font-semibold text-ink">{caseStatusLabel(e.stage)}</p>
                      <time dateTime={e.occurredAt} className="text-xs text-slate-500">{formatDateTime(e.occurredAt)}</time>
                    </div>
                    {e.note && <p className="break-words text-sm text-slate-600">{e.note}</p>}
                  </li>
                ))}
              </ol>
            )}
          </DetailSection>
        </div>

        <div className="space-y-6">
          <DetailSection title="Current stage">
            <Badge tone={caseStatusTone(c.status)}>{caseStatusLabel(c.status)}</Badge>
            {c.updatedAt && <p className="mt-2 text-xs text-slate-500">Last updated {formatDateTime(c.updatedAt)}</p>}
          </DetailSection>

          <DetailSection title="Patient information">
            <FieldList>
              <Field label="Patient name" value={c.patientName} wide />
              <Field label="Age" value={c.patientAge} />
              <Field label="Gender" value={capitalise(c.patientGender)} />
              <Field label="Patient contact" value={c.patientContact} wide optional />
            </FieldList>
          </DetailSection>

          <DetailSection title="Linked request">
            {request ? (
              <Link to={`/requests/${request.id}`} className="font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
                {request.referenceNumber}
              </Link>
            ) : (
              <p className="text-sm text-slate-500">This Case was not opened from a patient request.</p>
            )}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
