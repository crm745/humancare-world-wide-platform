import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { pageState } from './pageState.mjs';

/**
 * Previous / Next for an offset-paged list. `count` is how many rows the current page holds.
 * `total` is optional: with it the footer reads "51–100 of 120"; without it, next is enabled
 * while pages come back full.
 */
export function Pagination({ total, limit, offset, count, onChange, disabled = false }) {
  const s = pageState({ total, limit, offset, count });
  if (!s.hasPrev && !s.hasNext && count === 0) return null;
  return (
    <nav className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-slate-600" aria-label="Pagination">
      <p>
        {s.hasTotal ? `${s.from}–${s.to} of ${total}` : `${s.from}–${s.to}`}
        {s.pages ? <span className="text-slate-400"> · page {s.page} of {s.pages}</span> : null}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={disabled || !s.hasPrev} onClick={() => onChange(s.prevOffset)}>
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={disabled || !s.hasNext} onClick={() => onChange(s.nextOffset)}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
