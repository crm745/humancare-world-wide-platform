import { Construction } from 'lucide-react';
import { PageHeader } from './PageHeader';
import { EmptyState } from './EmptyState';

// Temporary body for modules that are not built yet (foundation step only).
export function FeaturePlaceholder({ title, subtitle }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState icon={Construction} title="Coming soon" description="This module is part of the rebuild and will be implemented in a later step." />
    </>
  );
}
