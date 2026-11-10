import { cn } from '@/utils/cn';

/**
 * Controlled tab strip. `tabs` is [{ value, label, count? }]. Arrow keys move between tabs.
 * The caller renders the matching panel (give it id `${idPrefix}-panel`).
 */
export function Tabs({ tabs, value, onChange, label, idPrefix = 'tabs' }) {
  function onKeyDown(e, index) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.value);
    document.getElementById(`${idPrefix}-tab-${next.value}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            id={`${idPrefix}-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200',
              selected ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', selected ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600')}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
