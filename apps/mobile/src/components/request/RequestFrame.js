import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { useNetwork } from '../../state/NetworkContext';
import { SERVICE_TILES } from '../../data/mock';
import { goBack } from '../../lib/nav';
import { Screen, TopBar } from '../layout';
import { Button, Text } from '../ui';
import { ServiceIconTile } from '../home/ServiceIcon';
import { KeyboardBar, KeyboardScroll } from '../keyboard';
import { AppRefreshControl } from '../AppRefreshControl';
import { useNetworkRefresh } from '../../lib/useNetworkRefresh';
import { ConnectionBanner } from '../network/ConnectionBanner';
import { ProgressButton } from '../network/ProgressButton';
import { Collapse } from '../network/Collapse';
import { NETWORK_ICONS } from '../network/icons';

// The New Request form: 1 Patient -> 2 Medical -> 3 Review. Every step shares this frame:
// header with Save draft, the step bar, the chosen service, the scrolling fields and the
// button pinned under them.
export const STEP_PATHS = { 1: '/request/step1', 2: '/request/step2', 3: '/request/review' };
const STEP_LABELS = { 1: 'req_step_patient', 2: 'req_step_medical', 3: 'req_step_review' };

// Going back to a step already done (step bar, Edit links): pop to it, so the data typed
// since stays and the stack does not grow.
export const goToStep = (step) => router.dismissTo(STEP_PATHS[step]);

// Fields register their position so a failed Continue can scroll to the first wrong one.
const AnchorContext = createContext(null);

// Wrap a field (or a section) in this to make it a scroll target. Must sit directly inside
// the frame's field list.
export function Anchor({ id, children }) {
  const register = useContext(AnchorContext);
  return <View onLayout={(e) => register(id, e.nativeEvent.layout.y)}>{children}</View>;
}

function StepBar({ step }) {
  const { t } = useApp();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={`${t('req_step_of').replace('{n}', step)}`} className="flex-row gap-1.5 border-b border-line bg-white px-[18px] pb-2.5 pt-3.5">
      {[1, 2, 3].map((i) => {
        const done = i < step;
        const body = (
          <>
            <View className={`h-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-line'}`} />
            <Text className={`mt-2 text-[10px] uppercase tracking-[1.5px] ${i === step ? 'font-inter-bold text-navy' : 'text-faint'}`} numberOfLines={1}>
              {i}. {t(STEP_LABELS[i])}
            </Text>
          </>
        );
        // A finished step can be tapped to go back to it; the rest are not links.
        return done ? (
          <Pressable key={i} onPress={() => goToStep(i)} accessibilityRole="button" accessibilityLabel={`${i}. ${t(STEP_LABELS[i])}`} hitSlop={{ top: 8, bottom: 14 }} className="min-h-[28px] flex-1 active:opacity-70">{body}</Pressable>
        ) : (
          <View key={i} className="flex-1">{body}</View>
        );
      })}
    </View>
  );
}

// The service this request is for, with a link back to the service list.
function ServiceCard() {
  const { t, draft, updateDraft } = useApp();
  const key = draft.service === 'air' ? 'privatecharter' : draft.service;
  const tile = SERVICE_TILES.find((s) => s.key === key) || SERVICE_TILES[0];
  const change = () => {
    // The service list picks a new service and comes back here with the patient kept.
    updateDraft({ changingService: true });
    router.push('/all-services');
  };
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-line bg-white px-3 py-2">
      <ServiceIconTile serviceKey={key} />
      <Text className="min-w-0 flex-1 font-inter-bold text-[14px] text-navy" numberOfLines={2}>{t(tile.title)}</Text>
      <Pressable
        onPress={change} accessibilityRole="button" accessibilityLabel={t('req_change_service')}
        className="min-h-[44px] min-w-[44px] items-center justify-center px-2 active:opacity-70"
      >
        <Text className="font-inter-bold text-[13px] text-primary">{t('req_change')}</Text>
      </Pressable>
    </View>
  );
}

// `firstError()` returns the id of the first wrong field on this step (or null); a Continue
// with an error scrolls to that field and runs `onInvalid` so the step starts showing errors.
// `serverAnchor` is the id of the first field the server refused on this step (or null): when it
// appears, the page scrolls to that field so the message is not left off screen.
// `needsNetwork`: only the step that SENDS (the review's Submit) needs the internet. The earlier steps only collect information (and save the encrypted draft), so Continue works offline; the form never
// asks the server to move on. `notice` (optional): a card shown above the button (components/network/StatusNotice.js), for what happened to the last send. `progress` (0..1, optional): while files upload the button itself is the
// progress bar (components/network/ProgressButton.js). While offline, a line above the button says why it is pale.
// `prepare()` (optional, async) runs first when Continue is tapped and may return a patch of draft values it has just settled (the step uses it to
// match a city typed by hand to the verified list); `firstError(patch)` then judges the draft with that patch applied.
export function RequestFrame({ step, children, firstError, onInvalid, onNext, prepare, nextKey, label, busy, buttonClassName, showService = true, serverAnchor = null, needsNetwork = false, notice = null, progress = null, refreshIcon = false }) {
  const { t, toast, updateDraft, setFormStep } = useApp();
  const { isOffline } = useNetwork();
  const OfflineIcon = NETWORK_ICONS.wifiOff;
  // Pull-to-refresh on the form: ONLY a re-check of the connection (so Submit and the other network buttons wake up at once when the backend answers). It reads nothing and changes nothing: the fields,
  // the documents and the saved draft are untouched, and nothing is sent (lib/networkRefresh.js).
  const { refreshing, onRefresh } = useNetworkRefresh();
  const insets = useSafeAreaInsets();
  useEffect(() => { setFormStep(step); }, [step, setFormStep]); // the draft (lib/draftStore.js) remembers which step the person was on
  // The Continue bar rides on top of the keyboard; the scroll area keeps a focused field above it.
  const [barHeight, setBarHeight] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const scrollRef = useRef(null);
  const anchors = useRef({});
  const listY = useRef(0);
  const register = useCallback((id, y) => { anchors.current[id] = y; }, []);

  useEffect(() => {
    if (!serverAnchor) return undefined;
    const timer = setTimeout(() => {
      const y = anchors.current[serverAnchor];
      if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + y - 16), animated: true });
    }, 200); // after the step has laid its fields out
    return () => clearTimeout(timer);
  }, [serverAnchor]);

  // Coming back from the service list (with or without picking one) ends the swap.
  useFocusEffect(useCallback(() => {
    updateDraft({ changingService: false });
  }, [updateDraft]));

  const next = async () => {
    if (preparing) return;
    let patch = null;
    if (prepare) {
      setPreparing(true);
      try { patch = await prepare(); } catch { patch = null; } finally { setPreparing(false); }
    }
    const bad = firstError?.(patch);
    if (bad) {
      toast(t('req_fix_fields'));
      onInvalid?.();
      const y = anchors.current[bad];
      scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + (y || 0) - 16), animated: true });
      return;
    }
    onNext();
  };

  return (
    <Screen bg="bg-canvas">
      {/* On a wide screen (tablet, browser) the form stays one centred column, like Home. */}
      <View style={{ flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
        <TopBar title={t('req_title')} onBack={goBack} banner={false} />
        <StepBar step={step} />
        <ConnectionBanner />
        <KeyboardScroll
          ref={scrollRef} className="flex-1" footerHeight={barHeight} showsVerticalScrollIndicator={false}
          refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 24 }}
        >
          {showService && <View className="mb-5"><ServiceCard /></View>}
          <AnchorContext.Provider value={register}>
            <View onLayout={(e) => { listY.current = e.nativeEvent.layout.y; }} className="gap-5">{children}</View>
          </AnchorContext.Provider>
        </KeyboardScroll>
        <KeyboardBar onLayout={(e) => setBarHeight(Math.round(e.nativeEvent.layout.height))}>
          <View className="border-t border-line bg-white px-[18px] pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {notice ? <View style={{ marginBottom: 12 }}>{notice}</View> : null}
            {/* The line expands and fades in (180 ms) when the phone goes offline, and the reverse when the connection returns. */}
            <Collapse show={!!(needsNetwork && isOffline)}>
              <View style={{ paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <OfflineIcon size={16} color="#5B6B84" strokeWidth={2.2} />
                <Text style={{ fontSize: 13, lineHeight: 18, color: '#5B6B84' }}>{t('net_submit_offline')}</Text>
              </View>
            </Collapse>
            {progress !== null ? (
              <ProgressButton title={label ?? t(nextKey)} progress={progress} />
            ) : (
              <Button title={label ?? t(nextKey)} onPress={next} loading={busy || preparing} needsNetwork={needsNetwork} className={buttonClassName} icon={refreshIcon ? <RefreshCw size={19} color="#FFFFFF" strokeWidth={2.4} /> : undefined} />
            )}
          </View>
        </KeyboardBar>
      </View>
    </Screen>
  );
}
