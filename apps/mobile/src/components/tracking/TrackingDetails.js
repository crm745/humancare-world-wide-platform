import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ArrowRight, Check } from 'lucide-react-native';
import Svg, { Line } from 'react-native-svg';
import { useApp } from '../../state/AppContext';
import { ServiceIcon } from '../home/ServiceIcon';
import { C, Card, FONT, Section, WRAP } from '../request/DetailsParts';

// The Tracking Details screen, drawn to the design from lib/trackingDetailsView.js. It decides nothing about the journey: it
// draws the steps it is given, however many there are, with the names and texts the model supplies.
const NAVY = '#0D2340';
const SOFT_TEXT = '#A9BAD3'; // the light blue-grey used on the navy card
const BLUE = '#1A73E8';
const CHIP = 32;

// The line between the two cities: a faint dashed line across, a solid white line from the start to the chip, a dot at the
// start, a ring at the end, and the chip (the request's own service icon in white) at its place along the way.
function RouteLine({ serviceKey, position }) {
  const [width, setWidth] = useState(0);
  const inner = Math.max(0, width - 8); // 4 in from each side
  const chipLeft = Math.round(4 + position * Math.max(0, inner - CHIP));
  const chipCentre = chipLeft + CHIP / 2;
  return (
    <View style={{ flex: 1, minWidth: 0, height: CHIP, justifyContent: 'center' }} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {width > 0 ? (
        <>
          <Svg width={width} height={2} style={{ position: 'absolute', left: 0, top: CHIP / 2 - 1 }}>
            <Line x1={4} y1={1} x2={width - 4} y2={1} stroke="rgba(169,186,211,0.45)" strokeWidth={2} strokeDasharray="4 4" />
          </Svg>
          <View style={{ position: 'absolute', left: 4, top: CHIP / 2 - 1, width: Math.max(0, chipCentre - 4), height: 2, backgroundColor: '#FFFFFF' }} />
          <View style={{ position: 'absolute', left: 4, top: CHIP / 2 - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' }} />
          <View style={{ position: 'absolute', left: width - 4 - 10, top: CHIP / 2 - 5, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: '#FFFFFF', backgroundColor: NAVY }} />
          <View style={{ position: 'absolute', left: chipLeft - 5, top: -5, width: CHIP + 10, height: CHIP + 10, borderRadius: (CHIP + 10) / 2, backgroundColor: 'rgba(26,115,232,0.25)', alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: CHIP, height: CHIP, borderRadius: CHIP / 2, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center' }}>
              <ServiceIcon serviceKey={serviceKey} size={16} color="#FFFFFF" fill="#FFFFFF" fillOpacity={0.2} />
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

function City({ name, label, right }) {
  return (
    <View style={{ maxWidth: 120, flexShrink: 1, alignItems: right ? 'flex-end' : 'flex-start' }}>
      <Text style={[{ fontFamily: FONT[800], fontSize: 24, lineHeight: 30, color: '#FFFFFF', textAlign: right ? 'right' : 'left' }, WRAP]}>{name}</Text>
      <Text style={{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: SOFT_TEXT, textAlign: right ? 'right' : 'left' }}>{label}</Text>
    </View>
  );
}

function RouteCard({ d, t }) {
  const both = d.from && d.to;
  return (
    <View accessible accessibilityRole="summary" accessibilityLabel={d.accessibilityLabel} style={{ backgroundColor: NAVY, borderRadius: 22, padding: 18, gap: 18 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <Text style={{ flexShrink: 1, fontFamily: FONT[600], fontSize: 13, lineHeight: 18, letterSpacing: 0.26, color: SOFT_TEXT }}>{d.reference}</Text>
          <View style={{ flexShrink: 0, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' }}>
            <Text style={{ fontFamily: FONT[800], fontSize: 11.5, lineHeight: 14, letterSpacing: 0.575, textTransform: 'uppercase', color: '#FFFFFF' }}>{d.badge.label}</Text>
          </View>
        </View>
        <Text style={[{ fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: '#FFFFFF' }, WRAP]}>{d.serviceName}</Text>
      </View>

      {d.hasRoute ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: both ? 'flex-start' : d.from ? 'flex-start' : 'flex-end' }}>
          {d.from ? <City name={d.from} label={t('td_pickup')} /> : null}
          {both ? <RouteLine serviceKey={d.serviceKey} position={d.position} /> : null}
          {d.to ? <City name={d.to} label={t('td_dropoff')} right /> : null}
        </View>
      ) : null}

      <View style={{ paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {d.segments.map((s, i) => (
            <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: s === 'on' ? '#FFFFFF' : s === 'dim' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.2)' }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <Text style={[{ flex: 1, minWidth: 0, fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: '#FFFFFF' }, WRAP]}>{d.currentTitle}</Text>
          <Text style={{ flexShrink: 0, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: SOFT_TEXT }}>{t('mr_step_of', { n: d.index + 1, total: d.total })}</Text>
        </View>
        {d.updated ? <Text style={{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: SOFT_TEXT }}>{t('rd_updated', { when: d.updated })}</Text> : null}
      </View>
    </View>
  );
}

// 24px: a check on blue (done), a blue ring around a dot (current), a plain grey ring (pending, and a cancelled stop).
function Marker({ state }) {
  const base = { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' };
  if (state === 'done') return <View style={[base, { backgroundColor: BLUE }]}><Check size={12} color="#FFFFFF" strokeWidth={3.4} /></View>;
  if (state === 'current') return <View style={[base, { backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: BLUE }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: BLUE }} /></View>;
  return <View style={[base, { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#D5DCE7' }]} />;
}

const TITLE = { done: { weight: 700, color: C.ink }, current: { weight: 800, color: C.navy }, pending: { weight: 700, color: '#66758C' } };

function StepRow({ step, last, t }) {
  const current = step.state === 'current';
  const stateText = step.stopped ? t('status_cancelled') : current ? t('tcp_state_active') : step.state === 'done' ? t('status_completed') : t('timeline_pending');
  // A step not reached reads "Pending"; a cancelled request's stop step shows the time it was cancelled.
  const timeText = step.state === 'pending' && !step.stopped ? t('timeline_pending') : step.time;
  const look = TITLE[step.state];
  return (
    <View
      accessible accessibilityLabel={[step.title, stateText, step.description, step.time].filter(Boolean).join(', ')}
      aria-current={current ? 'step' : undefined} role="listitem"
      style={{ flexDirection: 'row', gap: 14 }}
    >
      <View style={{ width: 24, alignItems: 'center' }}>
        <Marker state={step.state} />
        {!last ? <View style={{ position: 'absolute', top: 26, bottom: -2, width: 2, backgroundColor: step.state === 'done' ? BLUE : C.line }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 1, paddingBottom: 16, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <Text style={[{ flex: 1, minWidth: 0, fontFamily: FONT[look.weight], fontSize: 14.5, lineHeight: 21, color: look.color }, WRAP]}>{step.title}</Text>
          {timeText ? (
            <Text style={{ flexShrink: 0, maxWidth: '48%', textAlign: 'right', fontFamily: FONT[current ? 700 : 400], fontSize: 12.5, lineHeight: 17, marginTop: 2, color: current ? C.blueText : step.state === 'pending' ? '#66758C' : C.muted }}>{timeText}</Text>
          ) : null}
        </View>
        {step.description ? <Text style={[{ fontFamily: FONT[400], fontSize: 13, lineHeight: 19, color: step.state === 'pending' ? '#66758C' : C.muted }, WRAP]}>{step.description}</Text> : null}
      </View>
    </View>
  );
}

// The Admin's message while changes are requested (Private Charter): a soft warning card above the progress.
function Message({ text, t }) {
  return (
    <Card style={{ backgroundColor: '#FDF0DA', borderColor: '#FDF0DA' }}>
      <Text style={{ fontFamily: FONT[700], fontSize: 12.5, lineHeight: 16, color: '#8F4C08' }}>{t('tcp_changes_label')}</Text>
      <Text style={[{ marginTop: 4, fontFamily: FONT[500], fontSize: 13.5, lineHeight: 20, color: C.ink }, WRAP]}>{text}</Text>
    </Card>
  );
}

// `d` is what buildTrackingDetails returns. `onOpenRequest` is offered only while the patient has something to do.
export default function TrackingDetails({ d, onOpenRequest }) {
  const { t, isRTL } = useApp();
  return (
    <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 16, gap: 14 }}>
      <RouteCard d={d} t={t} />
      {d.message ? <Message text={d.message} t={t} /> : null}
      <Section title={t('td_progress')}>
        <Card padding={0} style={{ paddingTop: 18, paddingHorizontal: 16, paddingBottom: 4 }}>
          <View role="list" accessibilityRole="list">
            {d.steps.map((step, i) => <StepRow key={step.key} step={step} last={i === d.steps.length - 1} t={t} />)}
          </View>
        </Card>
      </Section>
      {d.openRequest && onOpenRequest ? (
        <Pressable
          accessibilityRole="button" accessibilityLabel={t('tcp_open_request')} onPress={onOpenRequest}
          style={({ pressed }) => ({ minHeight: 52, borderRadius: 16, backgroundColor: BLUE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, opacity: pressed ? 0.88 : 1 })}
        >
          <Text style={{ fontFamily: FONT[800], fontSize: 16, color: '#FFFFFF' }}>{t('tcp_open_request')}</Text>
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={18} color="#FFFFFF" strokeWidth={2.4} /></View>
        </Pressable>
      ) : null}
    </View>
  );
}
