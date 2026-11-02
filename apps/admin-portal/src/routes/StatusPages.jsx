import { Link, useLocation } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePageTitle } from '@/hooks/usePageTitle';

const REASONS = {
  superadmin: 'This page is only available to superadmins.',
  corporateReview: 'This page needs corporate review access. Ask a superadmin to grant it to your account.',
};

export function ForbiddenPage() {
  const { state } = useLocation();
  return <AccessDenied description={REASONS[state?.access] ?? 'Ask a superadmin if you need access.'} />;
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="space-y-4 text-center">
      <EmptyState icon={SearchX} title="Page not found" description="The page you are looking for doesn't exist." />
      <Link to="/dashboard" className="text-sm font-semibold text-brand-600 hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
