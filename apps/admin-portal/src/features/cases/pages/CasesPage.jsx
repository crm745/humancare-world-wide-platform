import { useState } from 'react';
import { Briefcase } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { RequestListToolbar } from '../../requests/components/RequestListToolbar';
import { CASE_COLUMNS } from '../columns';
import { CASE_STATUS_LABEL } from '../caseView.mjs';
import { useCaseList } from '../useCaseList';

const TABS = [{ value: 'all', label: 'All' }, ...Object.entries(CASE_STATUS_LABEL).map(([value, label]) => ({ value, label }))];

// Every operational Case: those opened when an Admin approves a patient request, and corporate Cases.
export default function CasesPage() {
  const [status, setStatus] = useState('all');
  const list = useCaseList(status);
  const searching = list.searchText.trim() !== '';

  return (
    <>
      <PageHeader title="Cases" subtitle="Operational Cases opened after an Admin approves a request, and Cases submitted by corporates." />
      <div className="space-y-4">
        <RequestListToolbar
          searchText={list.searchText}
          onSearchText={list.setSearchText}
          onRefresh={list.reload}
          loading={list.loading}
          placeholder="Search by reference (CASE-1042), patient, service or route"
          label="Search cases"
        />
        <Tabs tabs={TABS} value={status} onChange={setStatus} label="Filter by stage" idPrefix="cases" />
        <div id="cases-panel" role="tabpanel" aria-labelledby={`cases-tab-${status}`} className="space-y-1">
          <DataTable
            caption="Operational cases"
            columns={CASE_COLUMNS}
            rows={list.rows}
            rowKey={(c) => c.id}
            loading={list.loading}
            error={list.error}
            empty={{
              icon: Briefcase,
              title: searching ? 'Nothing matches your search' : status === 'all' ? 'Nothing opened yet' : 'Nothing at this stage',
              description: searching
                ? 'Try a different reference, patient, service or place.'
                : 'A Case appears here when an Admin approves a request, or when a corporate submits one.',
            }}
          />
          {list.error && !list.rows.length && !list.loading && (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" onClick={list.reload}>Try again</Button>
            </div>
          )}
          <Pagination total={list.total} limit={list.pageSize} offset={list.offset} count={list.rows.length} onChange={list.setOffset} disabled={list.loading} />
        </div>
      </div>
    </>
  );
}
