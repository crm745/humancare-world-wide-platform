import { cn } from '@/utils/cn';
import { eventView, sortEvents } from '../requestDetails.mjs';
import { formatDateTime } from '../format';

const DOT = {
  neutral: 'bg-slate-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-600',
};

// The request's audit history, oldest first. Admins appear by id only: the API sends no names.
export function RequestTimeline({ events, documents, user }) {
  if (!events?.length) return <p className="text-sm text-slate-500">No events recorded.</p>;
  const views = sortEvents(events).map((event) => eventView(event, { documents, user }));
  return (
    <ol className="relative space-y-5 border-l border-slate-200 pl-6" aria-label="Request timeline">
      {views.map((v) => (
        <li key={v.id} className="relative">
          <span className={cn('absolute -left-[1.9rem] top-1.5 h-3 w-3 rounded-full ring-4 ring-white', DOT[v.tone])} aria-hidden="true" />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <p className="text-sm font-semibold text-ink">{v.title}</p>
            <time dateTime={v.at} className="text-xs text-slate-500">{formatDateTime(v.at)}</time>
          </div>
          {v.lines.map((line, i) => (
            <p key={i} className="break-words text-sm text-slate-600">{line}</p>
          ))}
          {v.actor && <p className="mt-0.5 text-xs text-slate-400">{v.actor}</p>}
        </li>
      ))}
    </ol>
  );
}
