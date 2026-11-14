import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { SERVICE_LABELS } from '../data/mock';
import { DEFAULT_FILTERS, applyFilters } from '../lib/filters';
import { apiGet } from '../lib/api';
import { goBack } from '../lib/nav';
import { toListItem } from '../lib/requestShape';
import { cardView, statusCounts } from '../lib/myRequestsView';
import { cardSpec, scaleFor } from '../lib/myRequestsLayout';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../components/layout';
import { useFabScrollPad } from '../components/sos/hooks';
import { FilterSheet } from '../components/FilterSheet';
import { LoadingState } from '../components/LoadingState';
import { RequestCard } from '../components/requests/RequestCard';
import { RequestsHeader } from '../components/requests/RequestsHeader';

const TAB_BAR = 64;
const STATUSES = ['all', 'submitted', 'progress', 'completed', 'cancelled'];
const FILTER_SERVICES = Object.entries(SERVICE_LABELS).map(([value, labelKey]) => ({ value, labelKey }));

// `status` param comes from the Profile overview: all | active | completed.
// "active" (submitted + in progress) has no chip of its own, so no chip is highlighted for it.
export default function MyRequests() {
  const { t, toast, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const L = cardSpec(scaleFor(width));
  // The scroll area ends above the tab bar; its bottom padding is its own or the room the floating SOS button needs, whichever is more.
  const { paddingBottom, scrollProps } = useFabScrollPad({ ownPad: L.listPadBottom, edge: TAB_BAR + insets.bottom });
  const params = useLocalSearchParams();
  const [status, setStatus] = useState(params.status || 'all');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sheet, setSheet] = useState(false);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  // The same request as before. The first load shows the loading state; pulling the list down loads it again with the
  // system's own spinner, and a failed refresh keeps the list that is on screen.
  const load = useCallback(() => apiGet('/requests/me')
    .then(({ requests: rows }) => setRequests(rows.map(toListItem)))
    .catch((err) => toast(err.message)), [toast]);

  useEffect(() => {
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const today = new Date().toISOString().slice(0, 10);
  const q = query.trim().toLowerCase();
  // What the service and date filters leave. The chips count within THIS set, so with the Ground Ambulance filter and no such request,
  // "All" reads 0, not the total. (Typing in the search box does not change the numbers; it only narrows the list.)
  const filtered = applyFilters(requests, filters, today);
  const items = filtered.filter((r) => {
    const statusOk = status === 'all' || (status === 'active' ? ['submitted', 'progress'].includes(r.status) : r.status === status);
    const searchOk = !q || r.id.toLowerCase().includes(q) || cardView(r, t).name.toLowerCase().includes(q) || r.serviceType.toLowerCase().includes(q);
    return statusOk && searchOk;
  });

  const counts = statusCounts(filtered);
  const chips = STATUSES.map((s) => ({ value: s, count: counts[s], label: t(s === 'all' ? 'chip_all' : s === 'progress' ? 'mr_chip_progress' : 'status_' + s) }));

  return (
    <Screen>
      <RequestsHeader
        width={width}
        title={t('my_requests_title')}
        backLabel={t('home_back')}
        searchPlaceholder={t('mr_search_ph')}
        filterLabel={t('filter_requests_title')}
        query={query}
        onQuery={setQuery}
        onBack={goBack}
        onFilters={() => setSheet(true)}
        chips={chips}
        value={status}
        onChange={setStatus}
        isRTL={isRTL}
      />
      {/* The scroll area ends above the tab bar. The margin is on this wrapper, not the ScrollView: with a refresh control the web build applies a ScrollView's own margin twice. */}
      <View style={{ flex: 1, marginBottom: TAB_BAR + insets.bottom }}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        {...scrollProps}
        contentContainerStyle={{ flexGrow: 1, paddingTop: L.listPadTop, paddingHorizontal: L.listPadSide, paddingBottom, gap: L.listGap }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {loading && <LoadingState />}
        {items.map((r) => (
          <RequestCard key={r.id} item={r} t={t} isRTL={isRTL} onPress={() => router.push({ pathname: '/request-details', params: { id: r.rawId } })} />
        ))}
        {!loading && requests.length === 0 && (
          <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingVertical: 50 }}>
            <Text style={{ marginBottom: 6, fontFamily: 'Inter_700Bold', fontSize: L.emptyTitle, color: '#5B6B84', textAlign: 'center' }}>{t('mr_empty_title')}</Text>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: L.emptySub, color: '#97A4B8', textAlign: 'center' }}>{t('mr_empty_sub')}</Text>
          </View>
        )}
        {!loading && requests.length > 0 && items.length === 0 && (
          <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingVertical: 50 }}>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: L.noMatch, color: '#5B6B84', textAlign: 'center' }}>{t('mr_no_match')}</Text>
          </View>
        )}
      </ScrollView>
      </View>
      <BottomNav />
      <FilterSheet visible={sheet} onClose={() => setSheet(false)} title={t('filter_requests_title')} services={FILTER_SERVICES} value={filters} onApply={setFilters} />
    </Screen>
  );
}
