import { useCallback, useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import SERVICES from '../../data/services.json';
import { IMAGES } from '../../data/images';
import { errorText } from '../../lib/errorText';
import { apiGet } from '../../lib/api';
import { detailContent, isMissingLiveService, liveSlugFor } from '../../lib/serviceLookup';
import { localizedServiceContent } from '../../lib/serviceText';
import { Body, Screen, TopBar } from '../../components/layout';
import { DraftSheet } from '../../components/home/DraftSheet';
import { Button, Card, Heading, SectionLabel, Text } from '../../components/ui';
import { useRetryOnRestore } from '../../lib/useRetryOnRestore';
import { useNetworkRefresh } from '../../lib/useNetworkRefresh';
import { AppRefreshControl } from '../../components/AppRefreshControl';

export default function ServiceDetail() {
  const insets = useSafeAreaInsets();
  const [barHeight, setBarHeight] = useState(0); // the fixed bottom bar: the content and the SOS button keep clear of it
  const { t, lang, toast, resetDraft, isCorporate, draft, savedDraft, resumeDraft, discardDraft } = useApp();
  const { key } = useLocalSearchParams();
  const local = SERVICES[key] || SERVICES.air;
  // stats + img aren't in the backend yet, so those stay bundled locally; everything
  // admin can actually edit (name/description/provides) comes live, merged on top.
  const [live, setLive] = useState(null);
  const [asking, setAsking] = useState(false); // the "Saved draft found" sheet is open

  const [liveFailed, setLiveFailed] = useState(false);
  const loadLive = useCallback(() => apiGet(`/services/${liveSlugFor(key)}`)
      .then(({ service }) => { setLive(service); setLiveFailed(false); })
      // A 404 only means "no editable text for this service" (see lib/serviceLookup.js): the bundled
      // content is used silently. Any other failure is still shown.
      .catch((err) => { if (!isMissingLiveService(err)) { setLiveFailed(true); toast(errorText(err, t)); } }), [key, toast, t]);
  useEffect(() => { loadLive(); }, [loadLive]);
  // The bundled text is shown meanwhile; when the connection comes back after a failed read, the live text is read once more.
  useRetryOnRestore({ failed: liveFailed, retry: loadLive });
  // Pull-to-refresh: the live text is read again (its own failure already says why; the bundled text stays on screen). Nothing here touches the draft or the sheet below.
  const { refreshing, onRefresh } = useNetworkRefresh({ reload: loadLive });

  // English: the bundled text with the editable (live) text over it, as before. Any other language: the translated bundled text (the live text is English only).
  const content = localizedServiceContent(local, SERVICES[key] ? key : 'air', t);
  const { title, desc, features } = lang === 'EN' ? detailContent(local, live, key) : detailContent(content, null, key);

  // Corporates submit through their own Case form (/corporate/cases), never the
  // patient-only /requests flow — that endpoint rejects non-patient tokens outright.
  const start = () => {
    if (isCorporate) { router.push('/corporate-new-case'); return; }
    // Picking another service from inside the request form: keep the patient, and come back
    // to the form already open instead of stacking a second copy of it.
    const swapping = draft.changingService;
    // A saved draft exists (lib/draftStore.js): the person chooses to Resume it or to start new, which DISCARDS it. Nothing is replaced silently.
    if (!swapping && savedDraft) { setAsking(true); return; } // the bottom sheet below (components/home/DraftSheet.js): Resume, Start new or Cancel
    resetDraft(key);
    if (swapping) router.dismissTo('/request/step1');
    else router.push('/request/step1');
  };
  const openSaved = async () => {
    const opened = await resumeDraft();
    if (!opened) { toast(t('draft_unusable')); return; }
    router.push('/request/step1');
    if (opened.step >= 2) router.push('/request/step2');
    if (opened.step >= 3) router.push('/request/review');
  };

  return (
    <Screen>
      <TopBar title={t('service_detail_title')} />
      <Body contentClassName="p-[22px]" bottomEdge={barHeight} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View className="mb-5 min-h-[180px] flex-1 overflow-hidden rounded-2xl bg-primary">
          <Image source={IMAGES[local.img]} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
        </View>
        <Heading className="text-[20.5px]">{title}</Heading>
        <Text className="mt-2.5 text-[14px] leading-[22px] text-muted">{desc}</Text>
        <View className="mt-[18px] flex-row gap-2">
          {content.stats.map((st) => (
            <Card key={st.label} className="flex-1 items-center justify-center px-1.5 py-3">
              <Text className="font-inter-black text-[15px] text-primary">{st.value}</Text>
              <Text className="mt-0.5 text-center text-[10px] text-faint">{st.label}</Text>
            </Card>
          ))}
        </View>
        <Card className="mt-[18px]">
          <SectionLabel className="mb-3">{t('we_provide_label')}</SectionLabel>
          <View className="gap-[9px]">
            {features.map((f) => (
              <View key={f} className="flex-row items-start gap-2">
                <View className="mt-px"><Check size={15} color="#2FA84F" strokeWidth={2.4} /></View>
                <Text className="flex-1 text-[13.5px]">{f}</Text>
              </View>
            ))}
          </View>
        </Card>
      </Body>
      {/* "Request this service" stays fixed at the bottom of the screen while the page scrolls. */}
      <View onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} style={{ backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E4E9F2', paddingTop: 12, paddingHorizontal: 16, paddingBottom: 16 + insets.bottom }}>
        <Button large title={t('request_this_service_btn')} onPress={start} />
      </View>
      <DraftSheet
        visible={asking}
        onResume={() => { setAsking(false); openSaved(); }}
        onStartNew={async () => { setAsking(false); await discardDraft(); resetDraft(key); router.push('/request/step1'); }}
        onCancel={() => setAsking(false)}
      />
    </Screen>
  );
}
