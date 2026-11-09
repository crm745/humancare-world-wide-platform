import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '../requests/format';
import { caseSource, caseStatusLabel, caseStatusTone, caseUrgencyLabel } from './caseView.mjs';

export const CASE_COLUMNS = [
  {
    key: 'referenceNumber',
    header: 'Case',
    render: (c) => (
      <Link to={`/cases/${c.id}`} className="font-semibold text-brand-700 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100">
        {c.referenceNumber}
      </Link>
    ),
  },
  {
    key: 'patientName',
    header: 'Patient',
    render: (c) => (
      <div>
        <span className="font-medium text-slate-900">{c.patientName}</span>
        {(c.patientAge != null || c.patientGender) && (
          <span className="block text-xs text-slate-500">{[c.patientAge != null ? `${c.patientAge} yrs` : null, c.patientGender].filter(Boolean).join(' · ')}</span>
        )}
      </div>
    ),
  },
  {
    key: 'serviceType',
    header: 'Service',
    render: (c) => (
      <div>
        {c.serviceType}
        {caseUrgencyLabel(c.urgency) && <span className="block text-xs text-slate-500">{caseUrgencyLabel(c.urgency)}</span>}
      </div>
    ),
  },
  {
    key: 'route',
    header: 'Route',
    className: 'min-w-[14rem]',
    render: (c) => (
      <span>
        {c.origin} <span aria-label="to" className="text-slate-400">→</span> {c.destination}
      </span>
    ),
  },
  { key: 'source', header: 'Source', render: (c) => caseSource(c) },
  { key: 'status', header: 'Stage', render: (c) => <Badge tone={caseStatusTone(c.status)}>{caseStatusLabel(c.status)}</Badge> },
  { key: 'createdAt', header: 'Created', render: (c) => formatDateTime(c.createdAt) },
];
