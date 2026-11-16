import { Link } from 'react-router-dom';
import { ArrowRight, FileSearch } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Loading';
import { formatDateTime } from '../../requests/format';
import { REVIEW_STATUS_LABEL, URGENCY_LABEL, documentBadges, statusTone } from '../../requests/requestStatus.mjs';

const MAX_DOCUMENT_BADGES = 2;

// Compact columns for the dashboard. Same data and wording as the Incomplete Submissions list.
const COLUMNS = [
  {
    key: 'referenceNumber',
    header: 'Reference',
    render: (r) => (
      <Link to={`/requests/${r.id}`} className="font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
        {r.referenceNumber}
      </Link>
    ),
  },
  {
    key: 'patientName',
    header: 'Patient',
    className: 'min-w-[12rem]',
    render: (r) => (
      <div>
        <span className="font-medium text-slate-900">{r.patientName}</span>
        {(r.origin || r.destination) && (
          <span className="block text-xs text-slate-500">
            {r.origin} <span aria-label="to" className="text-slate-400">→</span> {r.destination}
          </span>
        )}
      </div>
    ),
  },
  { key: 'urgency', header: 'Urgency', className: 'whitespace-nowrap', render: (r) => URGENCY_LABEL[r.urgency] ?? '—' },
  {
    key: 'reviewStatus',
    header: 'Status',
    render: (r) => <Badge tone={statusTone(r.reviewStatus)}>{REVIEW_STATUS_LABEL[r.reviewStatus] ?? r.reviewStatus}</Badge>,
  },
  {
    key: 'documents',
    header: 'Documents',
    className: 'min-w-[12rem]',
    render: (r) => {
      const badges = documentBadges(r);
      const shown = badges.slice(0, MAX_DOCUMENT_BADGES);
      const more = badges.length - shown.length;
      return (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((b) => (
            <span key={b.key} title={b.title}>
              <Badge tone={b.tone} prominent={b.prominent}>{b.label}</Badge>
            </span>
          ))}
          {more > 0 && <Badge tone="neutral">+{more} more</Badge>}
        </div>
      );
    },
  },
  { key: 'submittedAt', header: 'Submitted', className: 'whitespace-nowrap', render: (r) => formatDateTime(r.submittedAt ?? r.createdAt) },
];

// "Latest open requests": the newest submitted-but-not-approved requests, straight from the API.
// Owns its own loading, error and empty states so a failure here never touches the KPI cards.
export function LatestOpenRequests({ list }) {
  const { requests, total, loading, error, reload } = list;
  const hasRows = requests.length > 0;
  const hiddenCount = Number.isInteger(total) ? total - requests.length : 0;

  return (
    <section aria-labelledby="latest-open-requests-title" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 id="latest-open-requests-title" className="text-base font-semibold text-ink">Latest open requests</h2>
          <p className="mt-0.5 text-xs text-slate-500">Newest submissions still in review or waiting on the patient.</p>
        </div>
        <Link
          to="/requests"
          className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100"
        >
          View all
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div aria-busy={loading || undefined}>
        {error && !hasRows ? (
          <div className="space-y-3 p-4 sm:p-5">
            <Alert tone="error">{error}</Alert>
            <Button variant="secondary" size="sm" onClick={reload}>Try again</Button>
          </div>
        ) : loading && !hasRows ? (
          <div className="flex min-h-[10rem] items-center justify-center text-brand-600" role="status" aria-label="Loading latest requests">
            <Spinner className="h-6 w-6" />
          </div>
        ) : !hasRows ? (
          <div className="p-4 sm:p-5">
            <EmptyState icon={FileSearch} title="No open requests" description="Every submitted request has been approved, or none has been submitted yet." />
          </div>
        ) : (
          <>
            {error && (
              <div className="p-4 pb-0 sm:px-5">
                <Alert tone="error">{error}</Alert>
              </div>
            )}
            <DataTable caption="Latest open requests" columns={COLUMNS} rows={requests} rowKey={(r) => r.id} loading={loading} dense embedded />
            {hiddenCount > 0 && (
              <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 sm:px-5">
                Showing the latest {requests.length} of {total} open requests.{' '}
                <Link to="/requests" className="font-semibold text-brand-700 hover:underline">See all {total}</Link>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
