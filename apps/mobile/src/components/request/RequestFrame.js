import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { SERVICE_TILES } from '../../data/mock';
import { goBack } from '../../lib/nav';
import { Screen, TopBar } from '../layout';
import { Button, Text } from '../ui';
import { ServiceIconTile } from '../home/ServiceIcon';

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
export function RequestFrame({ step, children, firstError, onInvalid, onNext, nextKey, label, busy, showService = true, serverAnchor = null }) {
  const { t, toast, updateDraft } = useApp();
  const insets = useSafeAreaInsets();
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

  const next = () => {
    const bad = firstError?.();
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
        <TopBar title={t('req_title')} onBack={goBack} />
        <StepBar step={step} />
        <ScrollView
          ref={scrollRef} className="flex-1" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 24 }}
        >
          {showService && <View className="mb-5"><ServiceCard /></View>}
          <AnchorContext.Provider value={register}>
            <View onLayout={(e) => { listY.current = e.nativeEvent.layout.y; }} className="gap-5">{children}</View>
          </AnchorContext.Provider>
        </ScrollView>
        <View className="border-t border-line bg-white px-[18px] pt-3" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          <Button title={label ?? t(nextKey)} onPress={next} loading={busy} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
