import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { DEFAULT_FILTERS, applyFilters } from '../lib/filters';
import { apiGet } from '../lib/api';
import { toUiStatus, serviceKeyFromTitle } from '../lib/requestShape';
import { Body, BottomNav, Screen, TopBar } from '../components/layout';
import { Button, Card, Pill, Spacer, Text } from '../components/ui';
import { FilterSheet } from '../components/FilterSheet';
import { SearchHeader } from '../components/SearchHeader';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { LoadFailure } from '../components/LoadFailure';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { RowsSkeleton } from '../components/skeleton/screens';
import { useResource } from '../lib/useResource';

const STAGES = ['all', 'submitted', 'progress', 'scheduled'];
const FILTER_SERVICES = [
  { value: 'air', labelKey: 'svc_air' },
  { value: 'ground', labelKey: 'svc_ground' },
  { value: 'hospital', labelKey: 'filter_svc_hospital' },
  { value: 'homecare', labelKey: 'filter_svc_homecare' },
];

function Stat({ value, label, tone }) {
  const blue = tone === 'active';
  return (
    <Card className={`flex-1 items-center ${blue ? 'border-primary-muted bg-primary-soft' : ''}`}>
      <Text className={`font-inter-black text-[17.5px] ${blue ? 'text-primary-dark' : tone === 'done' ? 'text-success' : 'text-ink'}`}>{value}</Text>
      <Text className={`mt-0.5 text-[10.5px] ${blue ? 'text-primary-dark' : 'text-faint'}`}>{label}</Text>
    </Card>
  );
}

function toListItem(c) {
  return {
    id: c.referenceNumber,
    rawId: c.id,
    patient: c.patientName,
    route: `${c.origin} → ${c.destination}`,
    stage: toUiStatus(c.status),
    service: serviceKeyFromTitle(c.serviceType),
    date: (c.createdAt || '').slice(0, 10),
  };
}

export default function CorporateDashboard() {
  const { t, toast } = useApp();
  const [stage, setStage] = useState('all');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sheet, setSheet] = useState(false);
  // Loaded the way every data screen loads (lib/useResource.js): a shimmer skeleton on the first load only, quiet refresh of what an
  // earlier visit loaded, "Try again" if the first load fails, and pull-to-refresh with the list staying on screen.
  const { data, loading, error, reload, onRefresh, refreshing } = useResource({
    key: 'corporate-cases',
    fetcher: () => apiGet('/corporate/cases').then(({ cases: rows }) => rows.map(toListItem)),
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const rawCases = data || [];
  const gate = useSkeletonGate(loading);

  const today = new Date().toISOString().slice(0, 10);
  const count = (s) => rawCases.filter((c) => s === 'all' || c.stage === s).length;
  const q = query.trim().toLowerCase();
  const cases = applyFilters(rawCases, filters, today).filter(
    (c) => (stage === 'all' || c.stage === stage) && (!q || `${c.id} ${c.patient} ${c.route}`.toLowerCase().includes(q))
  );

  return (
    <Screen>
      <TopBar title={t('lbl_all_cases')} />
      <SearchHeader
        placeholder="Search by Case ID or Patient Name"
        query={query}
        onQuery={setQuery}
        onOpenFilters={() => setSheet(true)}
        chips={STAGES.map((s) => ({ value: s, label: `${t(s === 'all' ? 'chip_all' : 'status_' + s)} (${count(s)})` }))}
        value={stage}
        onChange={setStage}
      />
      <Body withNav contentClassName="px-[18px] pt-4" refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {loading && gate.visible ? <RowsSkeleton label={t('sk_loading_cases')} count={5} lines={2} trailing /> : null}
        {error && !data ? <LoadFailure onRetry={reload} /> : null}
        {data ? (
        <Reveal animate={gate.wasShown}>
        <View className="mb-3.5 flex-row gap-2">
          <Stat value={String(rawCases.length)} label={t('lbl_total')} />
          <Stat value={String(rawCases.filter((c) => c.stage === 'submitted' || c.stage === 'progress' || c.stage === 'scheduled').length)} label={t('lbl_active')} tone="active" />
          <Stat value={String(rawCases.filter((c) => c.stage === 'completed').length)} label={t('lbl_done')} tone="done" />
        </View>
        <View className="gap-2.5">
          {cases.map((c) => (
            <Card key={c.id} onPress={() => router.push({ pathname: '/tracking', params: { id: c.rawId, kind: 'case' } })}>
              <View className="mb-1.5 flex-row items-center justify-between">
                <Text className="font-inter-black text-[12.5px] text-primary">{c.id}</Text>
                <Pill status={c.stage} />
              </View>
              <Text className="font-inter-bold text-[14.5px]">{c.patient}</Text>
              <Text className="text-[12.5px] text-faint">{c.route}</Text>
            </Card>
          ))}
        </View>
        {cases.length === 0 && <Text className="py-[30px] text-center text-[13.5px] text-faint">{t('empty_no_cases')}</Text>}
        </Reveal>
        ) : null}
        <Spacer min={16} />
        <Button icon={<Plus size={16} color="#fff" strokeWidth={2.4} />} title={t('btn_initiate_new_case')} onPress={() => router.push('/corporate-new-case')} className="mt-3.5" />
      </Body>
      <BottomNav />
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} title={t('filter_cases_title')} services={FILTER_SERVICES} value={filters} onApply={setFilters} />
    </Screen>
  );
}
