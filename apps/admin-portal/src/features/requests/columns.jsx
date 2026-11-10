import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { formatCalendarDay, formatDateTime } from './format';
import { REVIEW_STATUS_LABEL, URGENCY_LABEL, documentBadges, statusTone } from './requestStatus.mjs';

const reference = (from) => ({
  key: 'referenceNumber',
  header: 'Reference',
  render: (r) => (
    <Link to={`/requests/${r.id}`} state={{ from }} className="font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
      {r.referenceNumber}
    </Link>
  ),
});
const patient = { key: 'patientName', header: 'Patient', render: (r) => <span className="font-medium text-slate-900">{r.patientName}</span> };
const service = { key: 'serviceType', header: 'Service' };
const urgency = {
  key: 'urgency',
  header: 'Urgency',
  render: (r) => URGENCY_LABEL[r.urgency] ?? '—',
};
const route = {
  key: 'route',
  header: 'Route',
  className: 'min-w-[14rem]',
  render: (r) => (
    <span>
      {r.origin} <span aria-label="to" className="text-slate-400">→</span> {r.destination}
    </span>
  ),
};
// preferredDate is a calendar day stored at 00:00 UTC: show that day, not a timezone-shifted one.
const travelDate = {
  key: 'preferredDate',
  header: 'Travel date',
  render: (r) => formatCalendarDay(r.preferredDate),
};

export const SUBMISSION_COLUMNS = [
  reference('/requests'),
  patient,
  service,
  urgency,
  route,
  travelDate,
  {
    key: 'reviewStatus',
    header: 'Status',
    render: (r) => <Badge tone={statusTone(r.reviewStatus)}>{REVIEW_STATUS_LABEL[r.reviewStatus] ?? r.reviewStatus}</Badge>,
  },
  {
    key: 'documents',
    header: 'Documents',
    className: 'min-w-[14rem]',
    render: (r) => (
      <div className="flex flex-wrap gap-1.5">
        {documentBadges(r).map((b) => (
          <span key={b.key} title={b.title}>
            <Badge tone={b.tone} prominent={b.prominent}>{b.label}</Badge>
          </span>
        ))}
      </div>
    ),
  },
  { key: 'submittedAt', header: 'Submitted', render: (r) => formatDateTime(r.submittedAt ?? r.createdAt) },
];

export const DRAFT_COLUMNS = [
  reference('/requests/drafts'),
  patient,
  service,
  urgency,
  route,
  travelDate,
  { key: 'createdAt', header: 'Started', render: (r) => formatDateTime(r.createdAt) },
  { key: 'state', header: 'State', render: () => <Badge tone="neutral">No documents uploaded</Badge> },
];
