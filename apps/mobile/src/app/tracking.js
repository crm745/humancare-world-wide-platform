import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { downloadAndShare } from '../lib/download';
import { formatDisplayDate } from '../lib/requestShape';
import { isRequestFor, trackingItemFromCase, trackingItemFromRequest } from '../lib/trackingItem';
import { Body, Screen, TopBar } from '../components/layout';
import { Card, InfoRow, Spacer, Text } from '../components/ui';
import { LoadError, LoadingState } from '../components/LoadingState';
import { DocRow } from '../components/widgets';
import DocumentHistory from '../components/request/DocumentHistory';
import RequestStatusPill from '../components/request/RequestStatusPill';
import { PrivateCharterStatusChip, PrivateCharterTimelineSection } from '../components/tracking/PrivateCharterTracking';
import { buildPrivateCharterTracking } from '../lib/tracking/privateCharterTracking';
import { isPrivateCharterTracking } from '../lib/tracking/serviceFamily';

function stageEventsToTimeline(stageEvents, status) {
  const rows = stageEvents.map((ev, i) => ({
    title: ev.stage,
    time: formatDisplayDate(ev.occurredAt),
    detail: ev.note,
    state: i < stageEvents.length - 1 ? 'done' : status === 'completed' || status === 'cancelled' ? 'done' : 'current',
  }));
  if (status !== 'completed' && status !== 'cancelled') {
    rows.push({ title: 'timeline_completed', time: 'timeline_pending', state: 'todo' });
  }
  return rows;
}

function Timeline({ rows }) {
  const { t } = useApp();
  return (
    <View>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        return (
          <View key={`${row.title}-${i}`} className={`flex-row gap-3.5 ${last ? '' : 'pb-8'} ${row.state === 'todo' ? 'opacity-50' : ''}`}>
            {!last && <View className="absolute bottom-1 left-[12px] top-[26px] w-0.5 bg-line" />}
            <View className={`h-[26px] w-[26px] items-center justify-center rounded-full ${row.state === 'done' ? 'bg-success' : row.state === 'current' ? 'bg-primary' : 'bg-line'}`}>
              {row.state === 'done' && <Check size={13} color="#fff" strokeWidth={3} />}
              {row.state === 'current' && <Text className="font-inter-black text-[11.5px] text-white">●</Text>}
            </View>
            <View className="flex-1">
              <Text className={`font-inter-bold text-[14.5px] ${row.state === 'current' ? 'text-primary' : ''}`}>{row.state === 'todo' ? t(row.title) : row.title}</Text>
              <Text className="mt-[3px] text-[12.5px] text-faint">{row.state === 'todo' ? t(row.time) : row.time}</Text>
              {row.detail && <Text className="mt-1.5 text-[12.5px] leading-[19px] text-muted">{row.detail}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const TABS = [['overview', 'tab_overview'], ['timeline', 'tab_timeline'], ['docs', 'tab_documents']];

// A patient's ServiceRequest (with its linked Case nested inside) and a corporate's Case
// are different shapes from the backend — lib/trackingItem flattens either one into what the UI
// below actually needs, so the rest of the screen doesn't care which it's looking at.
export default function Tracking() {
  const { t, toast } = useApp();
  const params = useLocalSearchParams();
  const isCase = params.kind === 'case';
  const [tab, setTab] = useState(params.tab || 'overview');
  const [loadedItem, setLoadedItem] = useState(null);
  const [failed, setFailed] = useState(false);

  // A patient item is shown only while it belongs to the id on the route: if the id changes while this screen
  // stays mounted, the previous request is not displayed as the new one. A corporate Case is as before.
  const item = isCase || !loadedItem || isRequestFor(loadedItem.rawRequest, params.id) ? loadedItem : null;

  // A corporate Case: fetched once, exactly as before.
  useEffect(() => {
    if (!params.id || !isCase) return;
    const path = isCase ? `/corporate/cases/${params.id}` : `/requests/me/${params.id}`;
    apiGet(path)
      .then((data) => setLoadedItem(isCase ? trackingItemFromCase(data.case) : trackingItemFromRequest(data.request)))
      .catch((err) => { setFailed(true); toast(err.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per id/kind
  }, [params.id, isCase]);

  // A patient's request: loaded on the first focus and again whenever the patient comes back to this screen.
  // What is on screen stays while it reloads (no spinner); a failed reload keeps it and only says so. The
  // failed state is for a screen that never loaded. A response that arrives after blur or unmount is ignored.
  const loaded = useRef(false);
  const loadedForId = useRef(null);
  useFocusEffect(
    useCallback(() => {
      if (!params.id || isCase) return undefined;
      // A different id starts over: nothing is loaded for it yet, and an old failure is not its failure.
      // The same id (coming back to the screen) keeps what is shown and refreshes in the background.
      if (loadedForId.current !== String(params.id)) {
        loadedForId.current = String(params.id);
        loaded.current = false;
        setFailed(false);
      }
      let active = true;
      apiGet(`/requests/me/${params.id}`)
        .then((data) => {
          if (!active) return;
          loaded.current = true;
          setFailed(false);
          setLoadedItem(trackingItemFromRequest(data.request));
        })
        .catch((err) => {
          if (!active) return;
          if (!loaded.current) setFailed(true);
          toast(err.message);
        });
      return () => { active = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per id and focus; toast does not change what is fetched
    }, [params.id, isCase]),
  );

  // The Private Charter model is built from a patient's raw request only; a corporate Case never reaches it.
  const privateCharter = useMemo(
    () => (!isCase && item?.rawRequest && isPrivateCharterTracking(item.rawRequest) ? buildPrivateCharterTracking(item.rawRequest) : null),
    [isCase, item],
  );

  if (!item) {
    return (
      <Screen>
        <TopBar title={t('tracking_details_title')} />
        {failed || !params.id ? <LoadError message="Couldn't load tracking details. Please go back and try again." /> : <LoadingState />}
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title={t('tracking_details_title')} />
      <View className="flex-row items-center justify-between bg-white px-[18px] py-3.5">
        <Text className="font-inter-black text-[14.5px] text-navy">{item.referenceNumber} · {item.serviceType}</Text>
        {privateCharter ? <PrivateCharterStatusChip model={privateCharter} compact /> : <RequestStatusPill pill={item.reviewPill} status={item.status} />}
      </View>
      <View className="flex-row border-b border-line bg-white">
        {TABS.map(([id, key]) => (
          <Pressable key={id} onPress={() => setTab(id)} className={`flex-1 items-center border-b-2 py-3 ${tab === id ? 'border-primary' : 'border-transparent'}`}>
            <Text className={`font-inter-bold text-[13px] ${tab === id ? 'text-primary' : 'text-faint'}`}>{t(key)}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'overview' && (
        <Body contentClassName="p-[22px]">
          <Card className="p-[18px]">
            <InfoRow className="py-[13px]" label={t('lbl_status')} valueNode={privateCharter ? <PrivateCharterStatusChip model={privateCharter} compact /> : <RequestStatusPill pill={item.reviewPill} status={item.status} />} />
            <InfoRow className="py-[13px]" label={t('lbl_service')} value={item.serviceType} />
            <InfoRow className="py-[13px]" label={t('lbl_from')} value={item.origin} />
            <InfoRow className="py-[13px]" label={t('lbl_to')} value={item.destination} />
            <InfoRow className="py-[13px]" label={t(item.mortal ? 'lbl_deceased' : 'lbl_patient')} value={item.patientLabel} />
            <InfoRow className="py-[13px]" last label={t('lbl_reference_number')} value={item.referenceNumber} />
          </Card>
        </Body>
      )}
      {tab === 'timeline' && (
        <Body contentClassName="px-5 py-6">
          {privateCharter ? <PrivateCharterTimelineSection model={privateCharter} /> : <Timeline rows={stageEventsToTimeline(item.stageEvents, item.status)} />}
        </Body>
      )}
      {tab === 'docs' && (
        <Body contentClassName="p-[18px]">
          {item.workflow ? (
            // A request in the review workflow lists its own documents (every version, with how each stands).
            // Display only: these are not opened or downloaded from here.
            <DocumentHistory request={item.request} className="" />
          ) : (
            <>
              {item.documents.length === 0 && <Text className="py-6 text-center text-[13px] text-faint">No documents uploaded yet.</Text>}
              {item.documents.map((d) => (
                <DocRow key={d.id} label={d.name} meta={d.fileSizeBytes ? `${Math.round(d.fileSizeBytes / 1024)} KB` : ''} onPress={() => downloadAndShare(`/documents/${d.id}/file`, d.name).catch((err) => toast(err.message))} />
              ))}
            </>
          )}
          <Spacer min={14} />
        </Body>
      )}
    </Screen>
  );
}
