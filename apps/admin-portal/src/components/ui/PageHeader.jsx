import { usePageTitle } from '@/hooks/usePageTitle';

// Page titles are centered by default across the app. Rendering the header also sets the
// browser tab title, so every page gets one without extra wiring.
export function PageHeader({ title, subtitle, actions }) {
  usePageTitle(title);
  return (
    <div className="mb-6 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
      {subtitle && <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
      {actions && <div className="mt-4 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}
