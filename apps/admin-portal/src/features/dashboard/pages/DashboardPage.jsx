import { RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { LatestOpenRequests } from '../components/LatestOpenRequests';
import { StatCard } from '../components/StatCard';
import { useDashboardStats } from '../useDashboardStats';
import { useLatestOpenRequests } from '../useLatestOpenRequests';

// Live figures for the Private Charter request workflow. The four cards are the server's own counts of
// requests by review status (see dashboardStats.mjs); a figure that cannot be loaded says "Unavailable", never 0.
// Below them, the newest open requests. The two loads are independent: one failing never hides the other.
export default function DashboardPage() {
  const { stats, loading, failed, hasUnavailable, allFailed, reload: reloadStats } = useDashboardStats();
  const latest = useLatestOpenRequests();
  const busy = loading || latest.loading;
  const reloadLatest = latest.reload;
  const reload = () => {
    reloadStats();
    reloadLatest();
  };
  // dashboardStats.mjs also describes an Operational Cases figure that no existing API can supply; it is never shown.
  const cards = (stats ?? PLACEHOLDERS).filter((s) => !s.unsupported);

  return (
    <>
      <PageHeader
        align="left"
        title="Dashboard"
        subtitle="Overview of Private Charter requests in the document review workflow."
        actions={
          <Button variant="secondary" onClick={reload} disabled={busy}>
            <RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        }
      />
      <div className="space-y-4">
        {!loading && allFailed && (
          <Alert tone="error">
            The dashboard figures could not be loaded. <button type="button" onClick={reloadStats} className="font-semibold underline">Try again</button>
          </Alert>
        )}
        {!loading && !allFailed && hasUnavailable && (
          <Alert tone="warning">
            Some figures could not be loaded and are shown as unavailable{failed ? '' : ' (the server did not send a usable value)'}.{' '}
            <button type="button" onClick={reloadStats} className="font-semibold underline">Try again</button>
          </Alert>
        )}
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Dashboard statistics" aria-busy={loading || undefined}>
          {cards.map((s) => <StatCard key={s.key} stat={s} loading={loading} />)}
        </ul>
        {!loading && stats && cards.every((s) => s.value === 0) && (
          <p className="text-center text-sm text-slate-500">No requests have been submitted yet.</p>
        )}
        <LatestOpenRequests list={latest} />
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
];
