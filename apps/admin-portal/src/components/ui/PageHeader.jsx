import { usePageTitle } from '@/hooks/usePageTitle';

// Page titles are centered by default across the app. `align="left"` (used by the Dashboard) puts the
// title on the left and the actions on the right. Rendering the header also sets the
// browser tab title, so every page gets one without extra wiring.
export function PageHeader({ title, subtitle, actions, align = 'center' }) {
  usePageTitle(title);
  if (align === 'left') {
    return (
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
    );
  }
  return (
    <div className="mb-6 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
      {subtitle && <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
      {actions && <div className="mt-4 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}
