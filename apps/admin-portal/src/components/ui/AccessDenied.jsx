import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';

/** In-page "you can't do this" state. Also reusable when an API call comes back 403. */
export function AccessDenied({ title = "You don't have access to this page", description, showHomeLink = true }) {
  usePageTitle('Access denied');
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-amber-200 bg-amber-50 px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <ShieldAlert className="h-5 w-5" />
      </div>
      <h1 className="text-base font-semibold text-amber-950">{title}</h1>
      {description && <p className="mt-1 text-sm text-amber-900">{description}</p>}
      {showHomeLink && (
        <Link to="/dashboard" className="mt-5 text-sm font-semibold text-brand-700 hover:underline">
          Back to dashboard
        </Link>
      )}
    </div>
  );
}
