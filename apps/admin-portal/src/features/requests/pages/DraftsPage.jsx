import { FilePen } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RequestListToolbar } from '../components/RequestListToolbar';
import { DRAFT_COLUMNS } from '../columns';
import { PAGE_SIZE, useRequestList } from '../useRequestList';

// Requests the patient has started but not submitted: no document uploaded, so no submission
// time. They are not submissions and cannot be reviewed or approved.
const DRAFT_STATUS = 'awaiting_documents';

export default function DraftsPage() {
  const list = useRequestList(DRAFT_STATUS);
  const searching = list.search !== '';
  return (
    <>
      <PageHeader title="Drafts" subtitle="Requests started by a patient that have no document yet. They are not submitted and cannot be reviewed." />
      <div className="space-y-4">
        <RequestListToolbar
          searchText={list.searchText}
          onSearchText={list.setSearchText}
          onRefresh={list.reload}
          loading={list.loading}
          placeholder="Search by reference (REQ-1042) or patient name"
        />
        <div className="space-y-1">
          <DataTable
            caption="Drafts"
            columns={DRAFT_COLUMNS}
            rows={list.requests}
            rowKey={(r) => r.id}
            loading={list.loading}
            error={list.error}
            empty={{
              icon: FilePen,
              title: searching ? 'No drafts match your search' : 'No drafts',
              description: searching ? 'Try a different reference or patient name.' : 'Every request that has been started already has a document.',
            }}
          />
          <Pagination total={list.total} limit={PAGE_SIZE} offset={list.offset} count={list.requests.length} onChange={list.setOffset} disabled={list.loading} />
        </div>
      </div>
    </>
  );
}
