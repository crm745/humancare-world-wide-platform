import { View } from 'react-native';
import { ArrowRight, Check, X } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Button, Card, Text } from '../ui';
import {
  COLORS, DOT_SIZE, changesMessage, mirrorStyle, routeEnds, rowAccessibilityLabel, showOpenRequest, timelineRows, toneColors,
} from '../../lib/tracking/privateCharterTrackingView';

// The Private Charter tracking presentation. It draws what buildPrivateCharterTracking returns and decides
// nothing about the journey itself. Screens put it inside their own Screen / TopBar / Body.

// A 26px dot: filled with a check (completed), filled with a restrained halo (active), an outline (pending),
// or red with a cross (cancelled). Every row reads its own state, so a journey with no active step draws fine.
function Dot({ dot }) {
  const base = { width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2, alignItems: 'center', justifyContent: 'center' };
  if (dot === 'completed') return <View style={[base, { backgroundColor: COLORS.PRIMARY }]}><Check size={14} color={COLORS.WHITE} strokeWidth={3} /></View>;
  if (dot === 'cancelled') return <View style={[base, { backgroundColor: COLORS.CANCEL }]}><X size={14} color={COLORS.WHITE} strokeWidth={3} /></View>;
  if (dot === 'active') {
    return (
      <View style={base}>
        <View style={{ position: 'absolute', width: DOT_SIZE + 8, height: DOT_SIZE + 8, borderRadius: (DOT_SIZE + 8) / 2, backgroundColor: COLORS.PRIMARY, opacity: 0.14 }} />
        <View style={[base, { backgroundColor: COLORS.PRIMARY }]}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.WHITE }} /></View>
      </View>
    );
  }
  return <View style={[base, { backgroundColor: COLORS.WHITE, borderWidth: 2, borderColor: COLORS.FAINT }]} />;
}

const TITLE_COLOR = { completed: COLORS.TEXT, active: COLORS.PRIMARY, pending: COLORS.FAINT, cancelled: COLORS.CANCEL };

function Row({ row, t }) {
  const connector = row.dot === 'completed' ? COLORS.PRIMARY : COLORS.LINE;
  return (
    <View accessible accessibilityLabel={rowAccessibilityLabel(row, t)} style={{ flexDirection: 'row', gap: 14, paddingBottom: row.last ? 0 : 26 }}>
      {!row.last && <View style={{ position: 'absolute', start: DOT_SIZE / 2 - 1, top: DOT_SIZE + 2, bottom: 2, width: 2, backgroundColor: connector }} />}
      <Dot dot={row.dot} />
      <View style={{ flex: 1 }}>
        <Text className="font-inter-bold" style={{ fontSize: 14.5, lineHeight: 20, color: TITLE_COLOR[row.dot] }}>{t(row.titleKey)}</Text>
        <Text style={{ marginTop: 2, fontSize: 12.5, lineHeight: 18, color: row.dot === 'pending' ? COLORS.FAINT : COLORS.MUTED }}>{t(row.subKey)}</Text>
        {row.time ? <Text style={{ marginTop: 3, fontSize: 12, color: row.dot === 'cancelled' ? COLORS.CANCEL : COLORS.FAINT }}>{row.time}</Text> : null}
        {row.showPendingLabel ? <Text style={{ marginTop: 3, fontSize: 12, color: COLORS.FAINT }}>{t('timeline_pending')}</Text> : null}
      </View>
    </View>
  );
}

function TimelineCard({ model }) {
  const { t } = useApp();
  const rows = timelineRows(model);
  return (
    <Card className="rounded-[18px] p-[18px]">
      <Text className="font-inter-black" style={{ marginBottom: 16, fontSize: 14, color: COLORS.SECONDARY }}>{t('tcp_timeline_heading')}</Text>
      {rows.map((row) => <Row key={row.key} row={row} t={t} />)}
    </Card>
  );
}

function End({ label, city }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 12, color: COLORS.FAINT }}>{label}</Text>
      <Text className="font-inter-bold" numberOfLines={2} style={{ marginTop: 3, fontSize: 15, lineHeight: 20, color: city ? COLORS.SECONDARY : COLORS.FAINT }}>{city || '—'}</Text>
    </View>
  );
}

function RouteCard({ model }) {
  const { t, isRTL } = useApp();
  const { origin, destination } = routeEnds(model);
  return (
    <Card className="rounded-[18px] p-[18px]">
      <Text className="font-inter-black" style={{ marginBottom: 12, fontSize: 14, color: COLORS.SECONDARY }}>{t('tcp_route_heading')}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <End label={t('lbl_from')} city={origin} />
        <View style={mirrorStyle(isRTL)}><ArrowRight size={18} color={COLORS.PRIMARY} /></View>
        <End label={t('lbl_to')} city={destination} />
      </View>
    </Card>
  );
}

// The Admin's message while changes are requested.
function ChangesNotice({ model }) {
  const { t } = useApp();
  const message = changesMessage(model);
  if (!message) return null;
  return (
    <Card className="rounded-[18px] p-[18px]" style={{ backgroundColor: COLORS.WARNING_SOFT, borderColor: COLORS.WARNING_SOFT }}>
      <Text className="font-inter-bold" style={{ fontSize: 12.5, color: COLORS.WARNING }}>{t('tcp_changes_label')}</Text>
      <Text style={{ marginTop: 4, fontSize: 13.5, lineHeight: 20, color: COLORS.TEXT }}>{message}</Text>
    </Card>
  );
}

// Just the message and the timeline: for a screen that already has its own header, such as a Timeline tab.
export function PrivateCharterTimelineSection({ model }) {
  return (
    <View style={{ gap: 12 }}>
      <ChangesNotice model={model} />
      <TimelineCard model={model} />
    </View>
  );
}

// The status chip, from the model's own status (label and tone), so every place that shows the status of a
// Private Charter request agrees with its timeline. `compact` matches the small chip of the details header.
export function PrivateCharterStatusChip({ model, compact }) {
  const { t } = useApp();
  const tone = toneColors(model.status.tone);
  return (
    <View style={{ alignSelf: 'flex-start', borderRadius: 999, backgroundColor: tone.bg, paddingHorizontal: compact ? 10 : 12, paddingVertical: compact ? 4 : 6 }}>
      <Text className="font-inter-black" style={{ fontSize: 11.5, letterSpacing: compact ? 0.4 : 0.5, color: tone.fg }}>{t(model.status.labelKey).toUpperCase()}</Text>
    </View>
  );
}

// The whole page content: reference, service and status, the route, the message and the timeline.
export default function PrivateCharterTracking({ model, onOpenRequest }) {
  const { t } = useApp();
  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text className="font-inter-black" style={{ fontSize: 17, lineHeight: 23, color: COLORS.SECONDARY }}>{model.reference || '—'}</Text>
        <Text style={{ marginTop: 2, fontSize: 13, color: COLORS.MUTED }}>{model.serviceName}</Text>
        <View style={{ marginTop: 10 }}><PrivateCharterStatusChip model={model} /></View>
      </View>
      <RouteCard model={model} />
      <ChangesNotice model={model} />
      <TimelineCard model={model} />
      {onOpenRequest && showOpenRequest(model) ? <Button title={t('tcp_open_request')} onPress={onOpenRequest} className="mt-1 bg-[#303A8F]" /> : null}
    </View>
  );
}
