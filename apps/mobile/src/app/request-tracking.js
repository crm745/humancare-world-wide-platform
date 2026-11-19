import { useCallback, useMemo, useRef } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { goBack } from '../lib/nav';
import { buildTrackingDetails } from '../lib/trackingDetailsView';
import { useResource } from '../lib/useResource';
import { Body, Screen } from '../components/layout';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { LoadFailure } from '../components/LoadFailure';
import { Reveal } from '../components/skeleton/Reveal';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { TrackingSkeleton } from '../components/skeleton/screens';
import { ScreenHeader } from '../components/request/DetailsParts';
import TrackingDetails from '../components/tracking/TrackingDetails';

// Tracking Details: where the request is, drawn to the design (a route card and a progress timeline). Opened from
// "Open live tracking" on Request Details and "Track request" on Home. What it draws comes from lib/trackingDetailsView.js,
// which uses the Private Charter model for Private Charter and the generic model for everything else, and draws whatever
// steps they return.
//
// Loaded the way every data screen loads (lib/useResource.js): a shimmer skeleton on the first load only, what an earlier visit loaded
// shows at once and refreshes quietly, "Try again" if the first load fails, and pull-to-refresh that keeps the screen on screen (case
// status and stage events are one request). A stage event that is new after a pull highlights its step for a moment.
// The key includes the request id, so a request is never shown as another one.
export default function RequestTracking() {
  const { t, toast, isRTL } = useApp();
  const { id } = useLocalSearchParams();

  const { data, loading, error, reload, onRefresh, refreshing, highlight } = useResource({
    key: `tracking:${id}`,
    enabled: Boolean(id),
    fetcher: () => apiGet(`/requests/me/${id}`).then((data) => data.request),
    idsOf: (r) => (r && r.case && r.case.stageEvents ? r.case.stageEvents.map((e) => e.id) : []),
    onRefreshError: () => toast(t('sk_refresh_failed')),
  });
  const request = data ?? null;
  const gate = useSkeletonGate(loading && Boolean(id));

  // Coming back to this screen refreshes it quietly (what is on screen stays; no spinner). The first focus is the first load above.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current && id) reload();
      focused.current = true;
    }, [id, reload]),
  );

  const details = useMemo(() => buildTrackingDetails(request, t), [request, t]);
  const events = request && request.case && request.case.stageEvents ? request.case.stageEvents : [];
  const highlightKeys = events.filter((e) => highlight.includes(e.id)).map((e) => e.stage);
  const page = { backgroundColor: '#F2F6FC' };
  const header = <ScreenHeader title={t('tracking_details_title')} backLabel={t('home_back')} isRTL={isRTL} onBack={goBack} />;

  if (!details) {
    return (
      <Screen style={page}>
        {header}
        {!id || (error && !request) ? <LoadFailure message={t('trk_load_failed')} onRetry={id ? reload : undefined} /> : null}
        {loading && id && gate.visible ? <TrackingSkeleton label={t('sk_loading_tracking')} /> : null}
      </Screen>
    );
  }

  return (
    <Screen style={page}>
      {header}
      <Body refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <Reveal animate={gate.wasShown}>
          <TrackingDetails d={details} highlightKeys={highlightKeys} onOpenRequest={() => router.push({ pathname: '/request-details', params: { id: request.id } })} />
        </Reveal>
      </Body>
    </Screen>
  );
}
