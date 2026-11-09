import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { useDashboardStats } from '../useDashboardStats';

function StatCard({ stat, loading }) {
  const unavailable = stat.value === null;
  const pendingLoad = loading && unavailable && !stat.unsupported;
  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{stat.label}</p>
      {pendingLoad ? (
        <div className="mt-3 h-9 w-16 animate-pulse rounded bg-slate-100" aria-hidden="true" />
      ) : unavailable ? (
        <p className="mt-2 text-lg font-semibold text-slate-400">Unavailable</p>
      ) : (
        <p className="mt-2 text-3xl font-bold tracking-tight text-ink" data-testid={`stat-${stat.key}`}>{stat.value.toLocaleString()}</p>
      )}
      <p className="mt-1 text-xs text-slate-500">{stat.hint}</p>
    </>
  );
  const cls = 'block rounded-xl border border-slate-200 bg-white p-5 shadow-card';
  return (
    <li aria-label={stat.label}>
      {stat.to ? (
        <Link to={stat.to} className={`${cls} transition-colors hover:border-brand-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100`}>{body}</Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

// Live figures for the Private Charter request workflow and its operational Cases.
export default function DashboardPage() {
  const { stats, loading, failed, hasUnavailable, allFailed, reload } = useDashboardStats();

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Quick overview of Private Charter requests and operational Cases."
        actions={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />
      <div className="space-y-4">
        {!loading && allFailed && (
          <Alert tone="error">
            The dashboard figures could not be loaded. <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
          </Alert>
        )}
        {!loading && !allFailed && hasUnavailable && (
          <Alert tone="warning">
            Some figures could not be loaded and are shown as unavailable{failed ? '' : ' (the server did not send a usable value)'}.{' '}
            <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
          </Alert>
        )}
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Dashboard statistics" aria-busy={loading || undefined}>
          {(stats ?? PLACEHOLDERS).map((s) => <StatCard key={s.key} stat={s} loading={loading} />)}
        </ul>
        {!loading && stats && stats.filter((s) => !s.unsupported).every((s) => s.value === 0) && (
          <p className="text-center text-sm text-slate-500">No requests have been submitted yet.</p>
        )}
      </div>
    </>
  );
}

// Shown (as skeletons) on the very first load, before any figure exists.
const PLACEHOLDERS = [
  { key: 'total', label: 'Total Requests', value: null, hint: 'Submitted Private Charter requests (drafts not included)', to: null },
  { key: 'pending', label: 'Pending Submissions', value: null, hint: 'Waiting for an Admin to review', to: null },
  { key: 'awaiting', label: 'Awaiting Patient Documents', value: null, hint: 'The patient must upload or replace a document', to: null },
  { key: 'approved', label: 'Approved Requests', value: null, hint: 'Approved by an Admin', to: null },
  { key: 'cases', label: 'Operational Cases', value: null, hint: 'Not available: no existing API separates Cases created by approval from legacy Cases', to: null, unsupported: true },
];
