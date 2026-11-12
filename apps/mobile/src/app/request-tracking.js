import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { cityName, routeProgress, trackingView } from '../lib/requestTracking';
import { LoadError, LoadingState } from '../components/LoadingState';
import { Body, Screen, TopBar } from '../components/layout';
import { Text } from '../components/ui';
import PrivateCharterTracking from '../components/tracking/PrivateCharterTracking';
import { buildPrivateCharterTracking } from '../lib/tracking/privateCharterTracking';
import { isPrivateCharterTracking } from '../lib/tracking/serviceFamily';
import { isRequestFor } from '../lib/trackingItem';

// The patient's tracking page, opened from "Track request" on Home: where the request is, nothing else.
// The blue is the logo's own blue.
const BLUE = '#2F3A8E';
const BLUE_DARK = '#2F2A62';
const ON_DARK = '#A9B3F0';
const GREEN = '#1E8E4A';
const RED = '#C23B3B';
const GREY = '#E4E9F2';
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });

// ---- the route picture: a grid, an arc from origin to destination, the aircraft on it -------------------
const ARC_H = 150;
const PLANE = 22; // half the size of the aircraft badge
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const quad = (p0, c, p2, t) => lerp(lerp(p0, c, t), lerp(c, p2, t), t);

function RouteArc({ width, progress, cancelled, origin, destination }) {
  const p0 = { x: 44, y: ARC_H - 44 };
  const p2 = { x: width - 44, y: ARC_H - 76 };
  const c = { x: width / 2, y: 6 };
  const pos = quad(p0, c, p2, progress);
  // The aircraft always sits in the middle of the route (never on a city marker) and turns to follow the curve;
  // how far the request has got is shown by the solid part of the line.
  const tp = 0.5;
  const planeAt = quad(p0, c, p2, tp);
  const ahead = quad(p0, c, p2, Math.min(tp + 0.01, 1));
  const behind = quad(p0, c, p2, Math.max(tp - 0.01, 0));
  const angle = (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
  // the part already flown: the same curve cut at `progress`
  const q1 = lerp(p0, c, progress);
  const full = `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`;
  const flown = `M ${p0.x} ${p0.y} Q ${q1.x} ${q1.y} ${pos.x} ${pos.y}`;
  const colour = cancelled ? '#E07C7C' : ON_DARK;
  const verticals = [0.2, 0.5, 0.8].map((f) => Math.round(width * f));
  return (
    <View style={{ width, height: ARC_H, marginTop: 6 }}>
      <Svg width={width} height={ARC_H}>
        {verticals.map((x) => <Line key={x} x1={x} y1={0} x2={x} y2={ARC_H} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />)}
        {[0.3, 0.55, 0.8].map((f) => <Line key={f} x1={0} y1={Math.round(ARC_H * f)} x2={width} y2={Math.round(ARC_H * f)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />)}
        <Path d={full} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" fill="none" />
        {progress > 0 && <Path d={flown} stroke={colour} strokeWidth={3} strokeLinecap="round" fill="none" />}
        <Circle cx={p0.x} cy={p0.y} r={8} fill={BLUE_DARK} stroke={ON_DARK} strokeWidth={3} />
        <Circle cx={p2.x} cy={p2.y} r={8} fill={BLUE_DARK} stroke={ON_DARK} strokeWidth={3} />
      </Svg>
      <Text numberOfLines={1} style={{ position: 'absolute', left: p0.x - 34, width: 68, textAlign: 'center', top: p0.y + 14, fontFamily: MONO, fontSize: 11, letterSpacing: 1, color: 'rgba(255,255,255,0.6)' }}>{cityName(origin).toUpperCase()}</Text>
      <Text numberOfLines={1} style={{ position: 'absolute', left: p2.x - 34, width: 68, textAlign: 'center', top: p2.y + 14, fontFamily: MONO, fontSize: 11, letterSpacing: 1, color: 'rgba(255,255,255,0.6)' }}>{cityName(destination).toUpperCase()}</Text>
      <View pointerEvents="none" accessible={false} style={{ position: 'absolute', left: planeAt.x - PLANE, top: planeAt.y - PLANE, width: PLANE * 2, height: PLANE * 2, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={PLANE * 2} height={PLANE * 2} viewBox="0 0 24 24" style={{ position: 'absolute' }}>
          <Circle cx={12} cy={12} r={11.5} fill={cancelled ? 'rgba(224,124,124,0.28)' : 'rgba(255,255,255,0.2)'} />
        </Svg>
        {/* an airliner seen from above; its nose points up, so it is turned by the direction of travel + 90 degrees */}
        <Svg width={PLANE * 1.45} height={PLANE * 1.45} viewBox="0 0 24 24" style={{ transform: [{ rotate: `${angle + 90}deg` }] }}>
          <Path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill={cancelled ? '#F4A3A3' : '#FFFFFF'} />
        </Svg>
      </View>
    </View>
  );
}

// ---- the timeline ----------------------------------------------------------------------------------------
function Step({ step, last, t }) {
  const todo = step.state === 'todo';
  const now = step.state === 'now' || step.state === 'bad';
  const accent = step.state === 'bad' ? RED : BLUE;
  const colour = now ? accent : todo ? '#97A4B8' : '#17233D';
  return (
    <View style={{ flexDirection: 'row', gap: 14, paddingBottom: last ? 0 : 26 }}>
      {!last && <View style={{ position: 'absolute', left: 12, top: 30, bottom: -2, width: 2, backgroundColor: step.state === 'done' ? GREEN : GREY }} />}
      <View style={{ width: 26, height: 26, marginTop: 1 }}>
        {now && <View style={{ position: 'absolute', left: -7, top: -7, width: 40, height: 40, borderRadius: 20, backgroundColor: accent, opacity: 0.16 }} />}
        <View
          style={{
            width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
            backgroundColor: step.state === 'done' ? GREEN : now ? accent : '#FFFFFF',
            borderWidth: todo ? 2 : 0, borderColor: GREY,
          }}
        >
          {step.state === 'done' && <Check size={14} color="#fff" strokeWidth={3} />}
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <Text className="font-inter-bold" style={{ fontSize: 17, lineHeight: 22, color: colour }}>{step.state === 'bad' ? t('trk_chip_cancelled') : t(step.title)}</Text>
        <Text style={{ marginTop: 3, fontSize: 14, lineHeight: 19, color: todo ? '#97A4B8' : '#5B6B84' }}>{step.state === 'bad' ? t('trk_cancelled_sub') : t(step.sub)}</Text>
      </View>
      <Text style={{ marginTop: 4, fontFamily: MONO, fontSize: 12, color: '#5B6B84' }}>{todo ? t('timeline_pending') : step.time}</Text>
    </View>
  );
}

export default function RequestTracking() {
  const { t, toast } = useApp();
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
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

  // Private Charter only (by service key); every other service keeps the generic tracking below.
  const model = useMemo(() => (request && isPrivateCharterTracking(request) ? buildPrivateCharterTracking(request) : null), [request]);

  if (model) {
    return (
      <Screen bg="bg-white">
        <TopBar title={t('tracking_details_title')} />
        <Body contentClassName="px-[18px] py-4">
          <PrivateCharterTracking model={model} onOpenRequest={() => router.push({ pathname: '/request-details', params: { id: request.id } })} />
        </Body>
      </Screen>
    );
  }

  const view = request ? trackingView(request) : null;
  const arcW = Math.min(screenW, 560) - 36;

  return (
    <Screen>
      <TopBar title={t('trk_title')} />
      <LinearGradient colors={[BLUE_DARK, BLUE]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingHorizontal: 18, paddingBottom: request ? 34 : 0 }}>
        {request && (
          <>
            <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 14, paddingVertical: 7 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: view.cancelled ? '#E07C7C' : ON_DARK }} />
                <Text className="font-inter-black" style={{ fontSize: 12.5, letterSpacing: 0.6, color: '#fff' }}>{t(view.chip).toUpperCase()}</Text>
              </View>
              <Text style={{ fontFamily: MONO, fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{request.referenceNumber}</Text>
            </View>

            <View style={{ marginTop: 14, flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', columnGap: 12 }}>
              <Text className="font-inter-black" style={{ fontSize: 28, lineHeight: 34, letterSpacing: -0.4, color: '#fff' }}>
                {cityName(request.origin)} → {cityName(request.destination)}
              </Text>
            </View>
            <Text style={{ marginTop: 2, fontFamily: MONO, fontSize: 12, letterSpacing: 0.8, color: 'rgba(255,255,255,0.65)' }}>{String(request.serviceType || '').toUpperCase()}</Text>

            <RouteArc width={arcW} progress={routeProgress(view)} cancelled={view.cancelled} origin={request.origin} destination={request.destination} />
          </>
        )}
      </LinearGradient>

      {!request ? (
        failed || !id ? <LoadError message={t('trk_load_failed')} /> : <LoadingState />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          bounces={false}
          style={{ marginTop: -22, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: '#F2F6FC' }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 30, paddingBottom: insets.bottom + 24 }}
        >
          {view.steps.map((step, i) => (
            <Step key={step.key} step={step} last={i === view.steps.length - 1} t={t} />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
