import { useCallback, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { goBack } from '../lib/nav';
import { buildTrackingDetails } from '../lib/trackingDetailsView';
import { isRequestFor } from '../lib/trackingItem';
import { Body, Screen } from '../components/layout';
import { LoadError, LoadingState } from '../components/LoadingState';
import { ScreenHeader } from '../components/request/DetailsParts';
import TrackingDetails from '../components/tracking/TrackingDetails';

// Tracking Details: where the request is, drawn to the design (a route card and a progress timeline). Opened from
// "Open live tracking" on Request Details and "Track request" on Home. What it draws comes from lib/trackingDetailsView.js,
// which uses the Private Charter model for Private Charter and the generic model for everything else, and draws whatever
// steps they return.
export default function RequestTracking() {
  const { t, toast, isRTL } = useApp();
  const { id } = useLocalSearchParams();
  const [loadedRequest, setLoadedRequest] = useState(null);
  const [failed, setFailed] = useState(false);

  // Only a request that belongs to the id on the route is ever shown: if the id changes while this screen stays
  // mounted, the previous request is not displayed as the new one while the new one loads.
  const request = isRequestFor(loadedRequest, id) ? loadedRequest : null;

  const loaded = useRef(false);
  const loadedForId = useRef(null);

  // Loads on the first focus and again whenever the patient comes back to this screen. What is on screen stays
  // while it reloads (no spinner); a failed reload keeps it and only says so. The failed state is for a screen
  // that never loaded. A response that arrives after the screen lost focus or closed is ignored.
  useFocusEffect(
    useCallback(() => {
      if (!id) return undefined;
      // A different id starts over: nothing is loaded for it yet, and an old failure is not its failure.
      // The same id (coming back to the screen) keeps what is shown and refreshes in the background.
      if (loadedForId.current !== String(id)) {
        loadedForId.current = String(id);
        loaded.current = false;
        setFailed(false);
      }
      let active = true;
      apiGet(`/requests/me/${id}`)
        .then((data) => {
          if (!active) return;
          loaded.current = true;
          setFailed(false);
          setLoadedRequest(data.request);
        })
        .catch((err) => {
          if (!active) return;
          if (!loaded.current) setFailed(true);
          toast(err.message);
        });
      return () => { active = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per id and focus; toast does not change what is fetched
    }, [id]),
  );

  const details = useMemo(() => buildTrackingDetails(request, t), [request, t]);
  const page = { backgroundColor: '#F2F6FC' };
  const header = <ScreenHeader title={t('tracking_details_title')} backLabel={t('home_back')} isRTL={isRTL} onBack={goBack} />;

  if (!details) {
    return (
      <Screen style={page}>
        {header}
        {failed || !id ? <LoadError message={t('trk_load_failed')} /> : <LoadingState />}
      </Screen>
    );
  }

  return (
    <Screen style={page}>
      {header}
      <Body>
        <TrackingDetails d={details} onOpenRequest={() => router.push({ pathname: '/request-details', params: { id: request.id } })} />
      </Body>
    </Screen>
  );
}
