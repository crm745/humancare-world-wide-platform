import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Tabs } from '@/components/ui/Tabs';
import { RequestListToolbar } from '../components/RequestListToolbar';
import { SUBMISSION_COLUMNS } from '../columns';
import { OPEN_STATUSES } from '../requestStatus.mjs';
import { PAGE_SIZE, useRequestList } from '../useRequestList';

// Every submitted request that has not been approved yet (so no operational Case exists).
// Drafts (no document uploaded) and approved requests are not part of this list.
const TABS = [
  { value: OPEN_STATUSES, label: 'All open' },
  { value: 'in_review', label: 'In review' },
  { value: 'changes_requested', label: 'Changes requested' },
];

export default function IncompleteSubmissionsPage() {
  const [status, setStatus] = useState(OPEN_STATUSES);
  const list = useRequestList(status);

  const searching = list.search !== '';
  return (
    <>
      <PageHeader
        title="Incomplete Submissions"
        subtitle="Submitted requests that are still waiting on a scan, a document review, or the patient, and have not been approved yet."
      />
      <div className="space-y-4">
        <RequestListToolbar
          searchText={list.searchText}
          onSearchText={list.setSearchText}
          onRefresh={list.reload}
          loading={list.loading}
          placeholder="Search by reference (REQ-1042) or patient name"
        />
        <Tabs tabs={TABS} value={status} onChange={setStatus} label="Filter by status" idPrefix="submissions" />
        <div id="submissions-panel" role="tabpanel" aria-labelledby={`submissions-tab-${status}`} className="space-y-1">
          <DataTable
            caption="Incomplete submissions"
            columns={SUBMISSION_COLUMNS}
            rows={list.requests}
            rowKey={(r) => r.id}
            loading={list.loading}
            error={list.error}
            empty={{
              icon: FileSearch,
              title: searching ? 'No submissions match your search' : 'No incomplete submissions',
              description: searching ? 'Try a different reference or patient name.' : 'Every submitted request has been approved, or none has been submitted yet.',
            }}
          />
          <Pagination total={list.total} limit={PAGE_SIZE} offset={list.offset} count={list.requests.length} onChange={list.setOffset} disabled={list.loading} />
        </div>
      </div>
    </>
  );
}
