import { RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

// Search box + refresh, shared by the Incomplete Submissions and Drafts pages.
export function RequestListToolbar({ searchText, onSearchText, onRefresh, loading, placeholder, label = 'Search requests' }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3.5 z-10 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <Input
          type="search"
          aria-label={label}
          placeholder={placeholder}
          value={searchText}
          onChange={(e) => onSearchText(e.target.value)}
          maxLength={100}
          className="[&_input]:pl-10"
          rightSlot={
            searchText ? (
              <button type="button" onClick={() => onSearchText('')} aria-label="Clear search" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200">
                <X className="h-4 w-4" />
              </button>
            ) : null
          }
        />
      </div>
      <Button variant="secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        Refresh
      </Button>
    </div>
  );
}
