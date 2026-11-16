import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardList, FileWarning, Hourglass } from 'lucide-react';
import { cn } from '@/utils/cn';

// One KPI. `stat` comes from dashboardStats.mjs: { key, label, value (null = unavailable), hint, to }.
// The icon and colour only help the eye find the figure; they carry no extra meaning.
const LOOK = {
  total: { icon: ClipboardList, tile: 'bg-brand-50 text-brand-700' },
  pending: { icon: Hourglass, tile: 'bg-sky-50 text-sky-700' },
  awaiting: { icon: FileWarning, tile: 'bg-amber-50 text-amber-700' },
  approved: { icon: CheckCircle2, tile: 'bg-emerald-50 text-emerald-700' },
};
const FALLBACK = LOOK.total;

export function StatCard({ stat, loading }) {
  const { icon: Icon, tile } = LOOK[stat.key] ?? FALLBACK;
  const unavailable = stat.value === null;
  const pendingLoad = loading && unavailable && !stat.unsupported;
  const body = (
    <div className="flex items-start gap-3.5">
      <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', tile)} aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{stat.label}</p>
        {pendingLoad ? (
          <div className="mt-2 h-8 w-14 animate-pulse rounded bg-slate-100" aria-hidden="true" />
        ) : unavailable ? (
          <p className="mt-1 text-lg font-semibold text-slate-400">Unavailable</p>
        ) : (
          <p className="mt-0.5 text-3xl font-bold leading-tight tracking-tight text-ink" data-testid={`stat-${stat.key}`}>{stat.value.toLocaleString()}</p>
        )}
        <p className="mt-0.5 text-xs leading-snug text-slate-500">{stat.hint}</p>
      </div>
    </div>
  );
  const cls = 'block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-card';
  return (
    <li aria-label={stat.label}>
      {stat.to ? (
        <Link to={stat.to} className={`${cls} transition-colors hover:border-brand-300 hover:shadow-elevated focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100`}>{body}</Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
