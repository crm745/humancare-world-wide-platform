import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { useLocalSearchParams } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { apiGet } from '../lib/api';
import { cityName, routeProgress, trackingView } from '../lib/requestTracking';
import { TRACKING_PALETTE as P, toneFor } from '../lib/tracking/palette';
import { Body, Screen, TopBar } from '../components/layout';
import { Card, Text } from '../components/ui';
import { LoadError, LoadingState } from '../components/LoadingState';

// The patient's tracking page, opened from "Track request" on Home: where the request is, nothing else. It is
// built from the same pieces as Request Details (TopBar, Body, Card, the same type sizes), with the official logo
// blue for the active step and the progress.

// The route: an arc from origin to destination over a faint grid, the aircraft on it, and the two cities under their
// markers. The solid part of the arc is how far the request has got (its stage), not a position: where the aircraft
// physically is, is not known and is not shown, so the aircraft always sits in the middle of the route.
const ARC_H = 132;
const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
const quad = (p0, c, p2, t) => lerp(lerp(p0, c, t), lerp(c, p2, t), t);
const PLANE_PATH = 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z';
const BADGE = 36;

function RouteArc({ width, progress, tone, origin, destination }) {
  const p0 = { x: 20, y: ARC_H - 34 };
  const p2 = { x: width - 20, y: ARC_H - 52 };
  const c = { x: width / 2, y: 4 };
  const here = quad(p0, c, p2, progress);
  const q1 = lerp(p0, c, progress);
  const mid = quad(p0, c, p2, 0.5);
  const a = quad(p0, c, p2, 0.51);
  const z = quad(p0, c, p2, 0.49);
  const angle = (Math.atan2(a.y - z.y, a.x - z.x) * 180) / Math.PI;
  return (
    <View style={{ width, height: ARC_H }}>
      <Svg width={width} height={ARC_H}>
        {[0.25, 0.5, 0.75].map((f) => <Line key={f} x1={Math.round(width * f)} y1={0} x2={Math.round(width * f)} y2={ARC_H} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />)}
        {[0.3, 0.65].map((f) => <Line key={f} x1={0} y1={Math.round(ARC_H * f)} x2={width} y2={Math.round(ARC_H * f)} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />)}
        <Path d={`M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`} stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} strokeDasharray="2 5" strokeLinecap="round" fill="none" />
        {progress > 0 && <Path d={`M ${p0.x} ${p0.y} Q ${q1.x} ${q1.y} ${here.x} ${here.y}`} stroke={tone.onDark} strokeWidth={3} strokeLinecap="round" fill="none" />}
        <Circle cx={p0.x} cy={p0.y} r={7} fill={P.brand} stroke={tone.onDark} strokeWidth={3} />
        <Circle cx={p2.x} cy={p2.y} r={7} fill={P.brand} stroke="#FFFFFF" strokeWidth={3} />
      </Svg>
      <Text numberOfLines={1} className="absolute text-center font-inter-bold text-[12.5px] text-white" style={{ left: p0.x - 40, width: 80, top: p0.y + 14 }}>{cityName(origin)}</Text>
      <Text numberOfLines={1} className="absolute text-center font-inter-bold text-[12.5px] text-white" style={{ left: p2.x - 40, width: 80, top: p2.y + 14 }}>{cityName(destination)}</Text>
      <View pointerEvents="none" accessible={false} style={{ position: 'absolute', left: mid.x - BADGE / 2, top: mid.y - BADGE / 2, width: BADGE, height: BADGE, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: BADGE, height: BADGE, borderRadius: BADGE / 2, backgroundColor: 'rgba(255,255,255,0.18)' }} />
        {/* an airliner seen from above; its nose points up, so it is turned by the direction of travel + 90 degrees */}
        <Svg width={22} height={22} viewBox="0 0 24 24" style={{ transform: [{ rotate: `${angle + 90}deg` }] }}>
          <Path d={PLANE_PATH} fill="#FFFFFF" />
        </Svg>
      </View>
    </View>
  );
}

function RouteCard({ request, view }) {
  const [width, setWidth] = useState(0);
  const tone = toneFor(view);
  return (
    <Card className="mb-5 p-[18px]" style={{ backgroundColor: P.brand, borderColor: P.brand }}>
      <View onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
        {width > 0 && <RouteArc width={width} progress={routeProgress(view)} tone={tone} origin={request.origin} destination={request.destination} />}
      </View>
    </Card>
  );
}

// One milestone: a 26 px indicator (the same size as Request Details' tracker), the title and a line of
// description, and the time on the right.
function Step({ step, last, t }) {
  const todo = step.state === 'todo';
  const current = step.state === 'now';
  const cancelled = step.state === 'bad';
  const ring = cancelled ? P.cancelled : P.brand;
  const titleColour = cancelled ? P.cancelled : current ? P.brand : todo ? P.faint : P.ink;
  return (
    <View className={`flex-row gap-3.5 ${last ? '' : 'pb-[22px]'}`}>
      {!last && <View style={{ position: 'absolute', left: 12, top: 28, bottom: -2, width: 2, backgroundColor: step.state === 'done' ? P.done : P.line }} />}
      <View
        className="h-[26px] w-[26px] items-center justify-center rounded-full"
        style={todo ? { borderWidth: 2, borderColor: P.line, backgroundColor: '#FFFFFF' } : { backgroundColor: step.state === 'done' ? P.done : ring }}
      >
        {step.state === 'done' && <Check size={13} color="#fff" strokeWidth={3} />}
        {(current || cancelled) && <View className="h-2 w-2 rounded-full bg-white" />}
      </View>
      <View className="flex-1">
        <Text className="font-inter-bold text-[14.5px]" style={{ color: titleColour }}>{cancelled ? t('trk_chip_cancelled') : t(step.title)}</Text>
        <Text className="mt-[3px] text-[12.5px] leading-[18px]" style={{ color: todo ? P.faint : P.muted }}>{cancelled ? t('trk_cancelled_sub') : t(step.sub)}</Text>
      </View>
      <Text className="mt-0.5 text-[12.5px] text-faint">{todo ? t('timeline_pending') : step.time}</Text>
    </View>
  );
}

export default function RequestTracking() {
  const { t, toast } = useApp();
  const { id } = useLocalSearchParams();
  const [request, setRequest] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) return;
    apiGet(`/requests/me/${id}`)
      .then((data) => setRequest(data.request))
      .catch((err) => { setFailed(true); toast(err.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per id
  }, [id]);

  if (!request) {
    return (
      <Screen>
        <TopBar title={t('trk_title')} />
        {failed || !id ? <LoadError message={t('trk_load_failed')} /> : <LoadingState />}
      </Screen>
    );
  }

  const view = trackingView(request);
  const tone = toneFor(view);

  return (
    <Screen>
      <TopBar title={t('trk_title')} />
      <Body contentClassName="px-[18px] py-6">
        <Text className="mb-[5px] text-[12.5px] text-faint">{request.referenceNumber}</Text>
        <View className="mb-6 flex-row items-center justify-between gap-3">
          <Text className="flex-1 font-inter-black text-[20px] text-navy">{request.serviceType}</Text>
          <View className="rounded-full px-2.5 py-1" style={{ backgroundColor: tone.soft }}>
            <Text className="font-inter-black text-[11.5px] uppercase tracking-wide" style={{ color: tone.text }}>{t(view.chip)}</Text>
          </View>
        </View>

        <RouteCard request={request} view={view} />

        <Card className="p-[18px]">
          <Text className="mb-[18px] font-inter-black text-[14.5px] text-navy">{t('lbl_tracking_status')}</Text>
          {view.steps.map((step, i) => (
            <Step key={step.key} step={step} last={i === view.steps.length - 1} t={t} />
          ))}
        </Card>
      </Body>
    </Screen>
  );
}
