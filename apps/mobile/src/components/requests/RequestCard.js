import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { ArrowRight, ChevronRight, MapPin } from 'lucide-react-native';
import { ServiceIcon } from '../home/ServiceIcon';
import { SEGMENT_TODO, STEP_COUNT, badgeBelowFor, cardView } from '../../lib/myRequestsView';

// One request on My Requests, drawn to the design: the service icon tile (Home's own ServiceIcon, same colours and
// stroke, smaller), the service name with "REQ-1064 · 13 Nov 2026", the status badge, the route (the cities only), and
// the progress: five segments and "Step n of 5 · <stage>". The whole card is one button; its label says everything.
const NAVY = '#0D2340';
const INK = '#17233D';
const MUTED = '#5B6B84';
const FONT = { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

export function RequestCard({ item, onPress, t, isRTL }) {
  const v = cardView(item, t);
  const { width, fontScale } = useWindowDimensions();
  const badgeBelow = badgeBelowFor(width, fontScale);
  const flip = isRTL ? { transform: [{ scaleX: -1 }] } : null;
  const { progress } = v;
  const badge = (
    <View style={{ flexShrink: 0, alignSelf: badgeBelow ? 'flex-start' : 'auto', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, backgroundColor: v.badge.bg }}>
      <Text style={{ fontFamily: FONT[800], fontSize: 11.5, lineHeight: 14, letterSpacing: 0.575, textTransform: 'uppercase', color: v.badge.fg }}>{v.statusLabel}</Text>
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${v.label}. ${t('mr_view_details')}`}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E9EEF6', borderRadius: 18, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 4, gap: 12,
        shadowColor: '#0D2340', shadowOpacity: 0.04, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 0, opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* The icon, the name and the date, and the badge beside them (under them on a narrow screen or with large text, so a
          name never breaks in the middle). The badge never shrinks, so a long name wraps instead. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', alignItems: 'center', justifyContent: 'center' }}>
          <ServiceIcon serviceKey={v.key} size={22} color={NAVY} fill={NAVY} fillOpacity={0.12} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: FONT[800], fontSize: 16, lineHeight: 22, color: NAVY }}>{v.name}</Text>
          {v.sub ? <Text style={{ fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: MUTED }}>{v.sub}</Text> : null}
          {badgeBelow ? <View style={{ marginTop: 6 }}>{badge}</View> : null}
        </View>
        {badgeBelow ? null : badge}
      </View>

      {v.route ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <MapPin size={16} color={MUTED} />
          {v.route.from ? <Text style={{ flexShrink: 1, fontFamily: FONT[600], fontSize: 14, lineHeight: 20, color: INK }}>{v.route.from}</Text> : null}
          {v.route.from && v.route.to ? <View style={flip}><ArrowRight size={14} color="#8A97AB" /></View> : null}
          {v.route.to ? <Text style={{ flexShrink: 1, fontFamily: FONT[600], fontSize: 14, lineHeight: 20, color: INK }}>{v.route.to}</Text> : null}
        </View>
      ) : null}

      <View style={{ borderTopWidth: 1, borderTopColor: '#EEF1F6', paddingTop: 12, gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i < progress.filled ? progress.color : SEGMENT_TODO }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18 }}>
            {progress.kind === 'step' ? (
              <>
                <Text style={{ fontFamily: FONT[700], color: INK }}>{t('mr_step_of', { n: progress.step, total: STEP_COUNT })}</Text>
                <Text style={{ fontFamily: FONT[500], color: MUTED }}>{` · ${t(progress.stageKey)}`}</Text>
              </>
            ) : (
              <Text style={{ fontFamily: FONT[700], color: progress.kind === 'cancelled' ? MUTED : INK }}>{v.statusLabel}</Text>
            )}
          </Text>
          <View style={{ flexShrink: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Text style={{ fontFamily: FONT[700], fontSize: 14.5, color: '#1A5FC4' }}>{t('mr_view_details')}</Text>
            <View style={flip}><ChevronRight size={16} color="#1A5FC4" strokeWidth={2.2} /></View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}
