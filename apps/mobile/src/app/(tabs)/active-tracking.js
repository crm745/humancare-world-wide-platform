import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { activeRequestsOf, matchesTrackingQuery } from '../../lib/activeRequests';
import { MY_REQUESTS_FRESH_MS, MY_REQUESTS_KEY, fetchMyRequests, idsOfRequests } from '../../lib/myRequestsResource';
import { cardSpec, scaleFor } from '../../lib/myRequestsLayout';
import { startMinuteTicker } from '../../lib/trackingBanner';
import { useResource } from '../../lib/useResource';
import { useRefreshOnFocus } from '../../lib/useTabRefresh';
import { useFitScroll } from '../../lib/useFitScroll';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../../components/layout';
import { AppRefreshControl } from '../../components/AppRefreshControl';
import { LoadFailure } from '../../components/LoadFailure';
import { CachedNote } from '../../components/network/CachedNote';
import { Reveal } from '../../components/skeleton/Reveal';
import { useSkeletonGate } from '../../components/skeleton/hooks';
import { RequestsSkeleton } from '../../components/skeleton/screens';
import { useFabScrollPad } from '../../components/sos/hooks';
import { TrackingSearch } from '../../components/tracking/TrackingSearch';
import { TrackingRequestCard } from '../../components/tracking/TrackingRequestCard';

const TAB_BAR = 64;
const CARD_GAP = 10;

// Tracking: every ACTIVE request of the signed-in patient (submitted or in progress: lib/myRequestsView.js isActiveRequest, the same rule as Home and the Active filter of My Requests), each on the
// shorter Tracking card (components/tracking/TrackingRequestCard.js: no status pill, the current stage, a small "Track" button; the card and the button both open Tracking Details (/request-tracking) of THAT request). A request that needs something from the person comes first, then the newest
// (lib/activeRequests.js activeRequestsOf). It loads the way My Requests does, from the same cache key (lib/myRequestsResource.js): a skeleton on the first load, an earlier visit's list at once and refreshed
// quietly, "Try again" if the first load fails, pull-to-refresh with the list staying on screen; and the tab is brought up to date when it comes back into front, so a status that changed shows.
export default function ActiveTracking() {
  const { t, toast } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const L = cardSpec(scaleFor(width));
  // Room under the last card so the floating SOS button never covers it (the scroll area itself ends above the tab bar).
  const { paddingBottom, scrollProps } = useFabScrollPad({ ownPad: L.listPadBottom, edge: TAB_BAR + insets.bottom });
  const [now, setNow] = useState(() => Date.now()); // "Updated 2 min ago" keeps up while the tab is open
  useEffect(() => startMinuteTicker(() => setNow(Date.now())), []);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  const { data: rows, loading, error, reload, onRefresh, refreshing, highlight } = useResource({
    key: MY_REQUESTS_KEY,
    fetcher: fetchMyRequests,
    freshMs: MY_REQUESTS_FRESH_MS,
    idsOf: idsOfRequests,
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  useRefreshOnFocus(reload);
  const fit = useFitScroll(!!error && !rows);
  const gate = useSkeletonGate(loading);
  const [query, setQuery] = useState('');
  const active = activeRequestsOf(rows || []);
  const shown = active.filter((r) => matchesTrackingQuery(r, query, t)); // the same order, narrowed by the search (local)

  return (
    <Screen>
      <TrackingSearch width={width} title={t('nav_tracking')} showSearch={!loading && !!rows && active.length > 0} value={query} onChange={setQuery} />
      <View style={{ flex: 1, marginBottom: TAB_BAR + insets.bottom }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          {...scrollProps}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingTop: L.listPadTop, paddingHorizontal: L.listPadSide, paddingBottom, gap: CARD_GAP }}
          showsVerticalScrollIndicator={false}
          refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          scrollEnabled={fit.scrollEnabled} onLayout={fit.onLayout} onContentSizeChange={fit.onContentSizeChange}
        >
          {loading && gate.visible && <RequestsSkeleton label={t('sk_loading_requests')} />}
          {error && !rows && <LoadFailure titleKey="lf_title_requests" error={error} onRetry={reload} />}
          {!loading && rows && (
            <Reveal animate={gate.wasShown} style={{ gap: CARD_GAP }}>
              {shown.map((r) => (
                <TrackingRequestCard
                  key={r.id}
                  item={r}
                  now={now}
                  isNew={highlight.includes(r.rawId)}
                  onTrack={() => router.push({ pathname: '/request-tracking', params: { id: r.rawId } })}
                />
              ))}
              {active.length === 0 && (
                <View testID="tracking-empty" style={{ alignItems: 'center', paddingHorizontal: 20, paddingVertical: 50 }}>
                  <Text style={{ marginBottom: 6, fontFamily: 'Inter_700Bold', fontSize: L.emptyTitle, color: '#5B6B84', textAlign: 'center' }}>{t('tr_empty_title')}</Text>
                  <Text style={{ fontFamily: 'Inter_400Regular', fontSize: L.emptySub, color: '#97A4B8', textAlign: 'center' }}>{t('tr_empty_sub')}</Text>
                </View>
              )}
              {active.length > 0 && shown.length === 0 && (
                <View testID="tracking-no-match" style={{ alignItems: 'center', paddingHorizontal: 20, paddingVertical: 50 }}>
                  <Text style={{ marginBottom: 6, fontFamily: 'Inter_700Bold', fontSize: L.emptyTitle, color: '#5B6B84', textAlign: 'center' }}>{t('tr_no_match_title')}</Text>
                  <Text style={{ fontFamily: 'Inter_400Regular', fontSize: L.emptySub, color: '#97A4B8', textAlign: 'center' }}>{t('tr_no_match_sub')}</Text>
                </View>
              )}
              {rows.length > 0 ? <CachedNote /> : null}
            </Reveal>
          )}
        </ScrollView>
      </View>
      <BottomNav />
    </Screen>
  );
}
