import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, CheckCircle2, FilePlus2, FileQuestion, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoader } from '@/components/ui/Loading';
import { usePageTitle } from '@/hooks/usePageTitle';
import { DetailSection, Field, FieldList } from '../components/DetailSection';
import { DocumentHistory } from '../components/DocumentHistory';
import { DocumentReviewDialogs } from '../components/DocumentReviewDialogs';
import { RequestDocumentsDialog } from '../components/RequestDocumentsDialog';
import { RequestTimeline } from '../components/RequestTimeline';
import { approvalEligibility, caseDetailsPath } from '../approval.mjs';
import { canRequestDocuments } from '../documentActions.mjs';
import { formatCalendarDay, formatDateTime } from '../format';
import { backLabel, backTarget, capitalise, careLevelLabel, equipmentList, mobilityLabel } from '../requestDetails.mjs';
import { REVIEW_STATUS_LABEL, URGENCY_LABEL, documentBadges, statusTone } from '../requestStatus.mjs';
import { useDocumentActions } from '../useDocumentActions';
import { useRequestDetails } from '../useRequestDetails';

// Read-only view of one request in the review workflow (GET /admin/requests/:id).
export default function SubmissionDetailsPage() {
  const { id } = useParams();
  const location = useLocation();
  // Anything but digits cannot be a request id: say "not found" without calling the API.
  const validId = /^\d+$/.test(id ?? '') ? id : null;
  const { request, loading, error, notFound, reload } = useRequestDetails(validId);
  usePageTitle(request ? request.referenceNumber : 'Request');
  // Hooks stay above the early returns. After a decision (or a 404/409) the request is fetched again.
  const docs = useDocumentActions(validId, { onChanged: reload });

  const back = backTarget(request, location.state?.from);
  const backLink = (
    <Link to={back} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to {backLabel(back)}
    </Link>
  );

  if (!validId || notFound) {
    return (
      <div className="space-y-6">
        {backLink}
        <EmptyState icon={FileQuestion} title="Request not found" description="This request does not exist, or it is not part of the document review workflow." />
      </div>
    );
  }
  if (!request) {
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

  const isDraft = request.reviewStatus === 'awaiting_documents';
  const user = request.user ?? null;
  const documents = request.requestDocuments ?? [];
  const badges = isDraft ? [] : documentBadges({ reviewStatus: request.reviewStatus, documentsRequestReason: request.documentsRequestReason, documents: request.documentSummary });
  const equipment = equipmentList(request);
  // Offered only while the request is in review (the backend refuses drafts, requests already waiting for the patient, and approved ones).
  const documentRequest = canRequestDocuments(request);
  // Approval (the backend creates the Case). Drafts are not in the workflow, so nothing is offered for them.
  const approval = approvalEligibility(request);
  const showApprove = !isDraft && !approval.approved;
  const linkedCase = request.case ?? null;
  const caseLink = caseDetailsPath(linkedCase);

  return (
    <div className="space-y-6">
      {backLink}

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-ink">{request.referenceNumber}</h1>
              <Badge tone={statusTone(request.reviewStatus)}>{REVIEW_STATUS_LABEL[request.reviewStatus] ?? request.reviewStatus}</Badge>
            </div>
            <p className="mt-1 text-base font-medium text-slate-800">{request.patientName}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              {request.submittedAt ? `Submitted ${formatDateTime(request.submittedAt)}` : `Not submitted · started ${formatDateTime(request.createdAt)}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {showApprove && (
              <Button onClick={docs.openApproveDialog} disabled={!approval.allowed || docs.busy} title={approval.allowed ? undefined : 'Approval is blocked. See the reasons below.'}>
                <CheckCircle2 className="h-4 w-4" />
                Approve request
              </Button>
            )}
            {documentRequest.allowed && (
              <Button variant="secondary" onClick={docs.openRequestDialog} disabled={docs.busy}>
                <FilePlus2 className="h-4 w-4" />
                Request additional documents
              </Button>
            )}
            <Button variant="secondary" onClick={reload} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </Button>
          </div>
        </div>
        {badges.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Document status">
            {badges.map((b) => (
              <span key={b.key} title={b.title}>
                <Badge tone={b.tone} prominent={b.prominent}>{b.label}</Badge>
              </span>
            ))}
          </div>
        )}
        {request.reviewStatus === 'changes_requested' && request.documentsRequestReason && (
          <Alert tone="warning" className="mt-4">
            <span className="font-semibold">Documents requested from the patient:</span> {request.documentsRequestReason}
            <span className="mt-1 block text-xs">Waiting for the patient to upload. The request cannot be approved until they have, and every new document has been scanned and reviewed.</span>
          </Alert>
        )}
        {error && <Alert tone="error" className="mt-4">{error}</Alert>}
        {showApprove && !approval.allowed && (
          <Alert tone="warning" className="mt-4">
            <span className="font-semibold">This request cannot be approved yet:</span>
            <ul className="mt-1 list-disc space-y-0.5 pl-5" aria-label="Approval blockers">
              {approval.blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </Alert>
        )}
        {approval.approved && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3" aria-label="Approved request">
            <div className="flex items-center gap-3">
              <Briefcase className="h-6 w-6 text-emerald-700" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Approved. Operational Case</p>
                {linkedCase ? (
                  <p className="text-2xl font-bold tracking-tight text-emerald-900">{linkedCase.referenceNumber}</p>
                ) : (
                  <p className="text-sm text-emerald-900">The Case reference could not be loaded. Refresh the page.</p>
                )}
              </div>
            </div>
            {linkedCase && (caseLink ? (
              <Link to={caseLink} className="inline-flex items-center rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-emerald-800">Open Case</Link>
            ) : (
              <span className="text-xs text-emerald-800">Case details will be available in a later release.</span>
            ))}
          </div>
        )}
      </header>

      {/* The outcome of the last action (decision, download, document request), whichever part of the page started it. */}
      {docs.notice && (
        <Alert tone={docs.notice.tone}>
          {docs.notice.text}
          {docs.notice.items?.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {docs.notice.items.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailSection title="Request information">
            <FieldList>
              <Field label="Service type" value={request.serviceType} />
              <Field label="Urgency" value={URGENCY_LABEL[request.urgency] ?? request.urgency} />
              <Field label="Origin" value={request.origin} />
              <Field label="Destination" value={request.destination} />
              <Field label="Country" value={request.country} />
              <Field label="Preferred date" value={request.preferredDate ? formatCalendarDay(request.preferredDate) : null} />
              <Field label="Care level" value={careLevelLabel(request.careLevel)} />
              <Field label="Mobility" value={mobilityLabel(request.mobility)} optional />
              <Field label="Equipment" value={equipment.join(', ')} optional />
              <Field label="Relationship to deceased" value={request.deceasedRelation} optional />
              <Field label="Place of death" value={request.placeOfDeath} optional />
              <Field label="Date of death" value={request.dateOfDeath ? formatCalendarDay(request.dateOfDeath) : null} optional />
              <Field label="Description" value={request.description} wide />
            </FieldList>
          </DetailSection>

          <DetailSection title={`Document history (${documents.length})`}>
            <DocumentHistory
              documents={documents}
              actions={{ request, downloadingId: docs.downloadingId, onDownload: docs.download, onApprove: (d) => docs.openDialog('approve', d), onReject: (d) => docs.openDialog('reject', d) }}
            />
          </DetailSection>

          <DetailSection title="Request timeline">
            <RequestTimeline events={request.requestEvents} documents={documents} user={user} />
          </DetailSection>
        </div>

        <div className="space-y-6">
          <DetailSection title="Patient information">
            <FieldList>
              <Field label="Patient name" value={request.patientName} wide />
              <Field label="Age" value={request.patientAge} />
              <Field label="Gender" value={capitalise(request.patientGender)} />
              <Field label="Patient contact" value={request.patientContact} wide />
              <Field label="Current location" value={request.patientLocation} wide optional />
            </FieldList>
          </DetailSection>

          <DetailSection title="Requested by (account)">
            <FieldList>
              <Field label="Name" value={user?.name} wide />
              <Field label="Email" value={user?.email} wide />
              <Field label="Mobile number" value={user?.mobile} wide />
            </FieldList>
          </DetailSection>

          <DetailSection title="Linked Case">
            {request.case ? (
              <div className="flex flex-wrap items-center gap-3">
                <Briefcase className="h-5 w-5 text-slate-400" aria-hidden="true" />
                <span className="font-semibold text-ink">{request.case.referenceNumber}</span>
                <Badge tone="info">{String(request.case.status).replace(/_/g, ' ')}</Badge>
                {caseLink && <Link to={caseLink} className="text-sm font-semibold text-brand-700 hover:underline">Open Case</Link>}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No Case yet. It is created when an Admin approves the request.</p>
            )}
          </DetailSection>
        </div>
      </div>
      <ConfirmDialog
        open={docs.approveDialog}
        title="Approve this request?"
        description={request.referenceNumber}
        confirmLabel="Approve and create Case"
        busy={docs.busy}
        error={docs.error}
        onConfirm={docs.submitApproval}
        onCancel={docs.closeApproveDialog}
      >
        <p className="text-sm text-slate-600">
          Approving creates an operational Case from this request and copies its documents to it. The request will be locked: documents can no longer be reviewed
          and no further documents can be requested. This cannot be undone from this page.
        </p>
      </ConfirmDialog>
      <DocumentReviewDialogs dialog={docs.dialog} busy={docs.busy} error={docs.error} onConfirm={docs.submitReview} onCancel={docs.closeDialog} />
      {docs.requestDialog && (
        <RequestDocumentsDialog
          referenceNumber={request.referenceNumber}
          busy={docs.busy}
          error={docs.error}
          onConfirm={docs.submitRequestDocuments}
          onCancel={docs.closeRequestDialog}
        />
      )}
    </div>
  );
}
