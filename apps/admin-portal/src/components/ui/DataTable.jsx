import { Inbox } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Alert } from './Alert';
import { EmptyState } from './EmptyState';
import { Spinner } from './Loading';

/**
 * Read-only table. `columns` is [{ key, header, render?(row), className? }]; a column without
 * `render` shows row[key]. It owns the three non-data states so every list behaves the same:
 * loading (first load), error, and empty. While refetching, pass `loading` with existing rows
 * and they stay visible, dimmed.
 *
 * `onRowClick` makes the row clickable; the first cell should still contain a real link so the
 * row is reachable by keyboard.
 *
 * `dense` tightens the cell padding; `embedded` drops the table's own border, radius and shadow so it
 * can sit inside a card that already has them. Both are optional and change nothing when omitted.
 */
export function DataTable({ columns, rows, rowKey, loading = false, error, empty, onRowClick, caption, dense = false, embedded = false }) {
  if (error && !rows?.length) return <Alert tone="error">{error}</Alert>;
  if (loading && !rows?.length) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center rounded-xl border border-slate-200 bg-white text-brand-600" role="status" aria-label="Loading">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!rows?.length) {
    return <EmptyState icon={empty?.icon ?? Inbox} title={empty?.title ?? 'Nothing to show'} description={empty?.description} />;
  }
  return (
    <div className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      <div className={cn('overflow-x-auto bg-white transition-opacity', !embedded && 'rounded-xl border border-slate-200 shadow-card', loading && 'opacity-60')} aria-busy={loading || undefined}>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('whitespace-nowrap px-4 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', dense ? 'py-2.5' : 'py-3', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && 'cursor-pointer hover:bg-slate-50')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 align-middle text-slate-700', dense ? 'py-2.5' : 'py-3', c.className)}>
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
