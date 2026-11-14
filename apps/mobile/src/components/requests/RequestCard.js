import { Text, View, useWindowDimensions } from 'react-native';
import { ArrowRight, ChevronRight, MapPin } from 'lucide-react-native';
import { ServiceIcon } from '../home/ServiceIcon';
import { SEGMENT_TODO, STEP_COUNT, cardView } from '../../lib/myRequestsView';
import { badgeBelowFor, cardSpec, scaleFor } from '../../lib/myRequestsLayout';
import { COLORS } from '../../theme/colors';
import { PressBox } from '../PressBox';

// One request on My Requests, drawn to the design: the service icon tile (Home's own ServiceIcon, same colours and
// stroke, smaller), the service name with "REQ-1064 · 13 Nov 2026", the status badge, the route (the cities only), and
// the progress: five segments and "Step n of 5 · <stage>". The whole card is one button; its label says everything.
// The sizes are the design's (lib/myRequestsLayout.js), scaled to the screen.
const NAVY = '#0D2340';
const INK = '#17233D';
const MUTED = '#5B6B84';
const FONT = { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

export function RequestCard({ item, onPress, t, isRTL }) {
  const v = cardView(item, t);
  const { width, fontScale } = useWindowDimensions();
  const L = cardSpec(scaleFor(width));
  const badgeBelow = badgeBelowFor(width, fontScale);
  const flip = isRTL ? { transform: [{ scaleX: -1 }] } : null;
  const { progress } = v;
  const badge = (
    <View style={{ flexShrink: 0, alignSelf: badgeBelow ? 'flex-start' : 'auto', paddingVertical: L.badgePadY, paddingHorizontal: L.badgePadX, borderRadius: 999, backgroundColor: v.badge.bg }}>
      <Text style={{ fontFamily: FONT[800], fontSize: L.badgeSize, lineHeight: L.badgeLine, letterSpacing: L.badgeSpacing, textTransform: 'uppercase', color: v.badge.fg }}>{v.statusLabel}</Text>
    </View>
  );
  return (
    <PressBox
      accessibilityRole="button"
      accessibilityLabel={`${v.label}. ${t('mr_view_details')}`}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E9EEF6', borderRadius: L.radius, paddingTop: L.padTop, paddingHorizontal: L.padSide, paddingBottom: L.padBottom, gap: L.gap,
        shadowColor: '#0D2340', shadowOpacity: 0.04, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 0, opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* The icon, the name and the date, and the badge beside them (under them on a narrow screen or with large text, so a
          name never breaks in the middle). The badge never shrinks, so a long name wraps instead. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: L.gap }}>
        <View style={{ width: L.tile, height: L.tile, borderRadius: L.tileRadius, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', alignItems: 'center', justifyContent: 'center' }}>
          <ServiceIcon serviceKey={v.key} size={L.icon} color={NAVY} fill={NAVY} fillOpacity={0.12} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: FONT[800], fontSize: L.nameSize, lineHeight: L.nameLine, color: NAVY }}>{v.name}</Text>
          {v.sub ? <Text style={{ fontFamily: FONT[400], fontSize: L.subSize, lineHeight: L.subLine, color: MUTED }}>{v.sub}</Text> : null}
          {badgeBelow ? <View style={{ marginTop: 6 }}>{badge}</View> : null}
        </View>
        {badgeBelow ? null : badge}
      </View>

      {v.route ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: L.routeGap }}>
          <MapPin size={L.pin} color={MUTED} />
          {v.route.from ? <Text style={{ flexShrink: 1, fontFamily: FONT[600], fontSize: L.routeSize, lineHeight: L.routeLine, color: INK }}>{v.route.from}</Text> : null}
          {v.route.from && v.route.to ? <View style={flip}><ArrowRight size={L.arrow} color="#8A97AB" /></View> : null}
          {v.route.to ? <Text style={{ flexShrink: 1, fontFamily: FONT[600], fontSize: L.routeSize, lineHeight: L.routeLine, color: INK }}>{v.route.to}</Text> : null}
        </View>
      ) : null}

      <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: L.progressPad, gap: L.progressGap }}>
        <View style={{ flexDirection: 'row', gap: L.segGap }}>
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <View key={i} style={{ flex: 1, height: L.segHeight, borderRadius: L.segRadius, backgroundColor: i < progress.filled ? progress.color : SEGMENT_TODO }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ flex: 1, minWidth: 0, fontSize: L.stepSize, lineHeight: L.stepLine }}>
            {progress.kind === 'step' ? (
              <>
                <Text style={{ fontFamily: FONT[700], color: INK }}>{t('mr_step_of', { n: progress.step, total: STEP_COUNT })}</Text>
                <Text style={{ fontFamily: FONT[500], color: MUTED }}>{` · ${t(progress.stageKey)}`}</Text>
              </>
            ) : (
              <Text style={{ fontFamily: FONT[700], color: progress.kind === 'cancelled' ? MUTED : INK }}>{v.statusLabel}</Text>
            )}
          </Text>
          <View style={{ flexShrink: 0, minHeight: L.detailsMinHeight, flexDirection: 'row', alignItems: 'center', gap: L.detailsGap }}>
            <Text style={{ fontFamily: FONT[700], fontSize: L.detailsSize, color: COLORS.primary }}>{t('mr_view_details')}</Text>
            <View style={flip}><ChevronRight size={L.detailsChevron} color={COLORS.primary} strokeWidth={2.2} /></View>
          </View>
        </View>
      </View>
    </PressBox>
  );
}
