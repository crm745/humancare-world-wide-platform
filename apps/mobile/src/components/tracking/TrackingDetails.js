import { Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import TrackingBanner from './TrackingBanner';
import { C, Card, FONT, Section, WRAP } from '../request/DetailsParts';
import { COLORS } from '../../theme/colors';
import { HighlightFill } from '../skeleton/HighlightFill';

// The Tracking Details screen, drawn to the design from lib/trackingDetailsView.js. It decides nothing about the journey: it
// draws the steps it is given, however many there are, with the names and texts the model supplies.
// The summary card on top is components/tracking/TrackingBanner.js; the timeline uses the brand blue for progress.
const BLUE = COLORS.primary;
const MARKER = 26; // the same size as the other tracking indicators

// 24px: a check on blue (done), a blue ring around a dot (current), a plain grey ring (pending, and a cancelled stop).
function Marker({ state }) {
  const base = { width: MARKER, height: MARKER, borderRadius: MARKER / 2, alignItems: 'center', justifyContent: 'center' };
  if (state === 'done') return <View style={[base, { backgroundColor: BLUE }]}><Check size={13} color="#FFFFFF" strokeWidth={3.2} /></View>;
  if (state === 'current') return <View style={[base, { backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: BLUE }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: BLUE }} /></View>;
  return <View style={[base, { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#D5DCE7' }]} />;
}

const TITLE = { done: { weight: 700, color: C.ink }, current: { weight: 700, color: C.navy }, pending: { weight: 600, color: C.muted } };

function StepRow({ step, last, t, isNew }) {
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
      {isNew ? <HighlightFill radius={10} /> : null}
      <View style={{ width: MARKER, alignItems: 'center' }}>
        <Marker state={step.state} />
        {!last ? <View style={{ position: 'absolute', top: MARKER + 2, bottom: -2, width: 2, backgroundColor: step.state === 'done' ? BLUE : C.line }} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 1, paddingBottom: 16, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <Text style={[{ flex: 1, minWidth: 0, fontFamily: FONT[look.weight], fontSize: 14.5, lineHeight: 20, color: look.color }, WRAP]}>{step.title}</Text>
          {timeText ? (
            <Text style={{ flexShrink: 0, maxWidth: '48%', textAlign: 'right', fontFamily: FONT[current ? 700 : 400], fontSize: 12.5, lineHeight: 17, marginTop: 2, color: current ? C.blueText : C.muted }}>{timeText}</Text>
          ) : null}
        </View>
        {step.description ? <Text style={[{ fontFamily: FONT[400], fontSize: 13, lineHeight: 19, color: C.muted }, WRAP]}>{step.description}</Text> : null}
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

// `d` is what buildTrackingDetails returns. Tracking Details shows tracking only: it has no way over to Request Details.
// `highlightKeys`: the steps with a stage event that is new since the last pull-to-refresh (shown with a brief highlight).
export default function TrackingDetails({ d, highlightKeys = [] }) {
  const { t } = useApp();
  return (
    <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 0, gap: 14 }}>
      <TrackingBanner d={d} />
      {d.message ? <Message text={d.message} t={t} /> : null}
      <Section title={t('td_progress')}>
        <Card padding={0} style={{ paddingTop: 18, paddingHorizontal: 16, paddingBottom: 4 }}>
          <View role="list" accessibilityRole="list">
            {d.steps.map((step, i) => <StepRow key={step.key} step={step} last={i === d.steps.length - 1} t={t} isNew={highlightKeys.includes(step.key)} />)}
          </View>
        </Card>
      </Section>
    </View>
  );
}
