import { Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { ArrowRight } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { ServiceIconTile } from './ServiceIcon';
import { PressBox } from '../PressBox';
import { HighlightFill } from '../skeleton/HighlightFill';
import { activeCardView } from '../../lib/activeRequests';
import { COLORS } from '../../theme/colors';

// One ACTIVE request, as a card: the service icon, the service name (once) with "<variant> · REQ-1067", the status pill, the route (when the request has one), the progress of its own
// workflow ("Step 4 of 5 · <stage>", only when its steps are known). The card opens THAT request's details; "Track Request" opens THAT request's tracking. Used on Home and in My Requests. Never combines requests.
// All the texts come from lib/activeRequests.js activeCardView; the sizes are the design's.
const NAVY = '#0D2340';
const MUTED = '#5B6B84';
const FONT = { 400: 'Inter_400Regular', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

function Route({ from, to }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={2} style={{ flexShrink: 1, maxWidth: '40%', fontFamily: FONT[700], fontSize: 14, lineHeight: 19, color: NAVY }}>{from}</Text>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.primary }} />
        <Svg height={2} style={{ flex: 1 }}>
          <Line x1="0" y1="1" x2="100%" y2="1" stroke="#C9D3E1" strokeWidth={2} strokeDasharray="4 3" />
        </Svg>
        <View style={{ width: 7, height: 7, borderRadius: 4, borderWidth: 2, borderColor: COLORS.primary }} />
      </View>
      <Text numberOfLines={2} style={{ flexShrink: 1, maxWidth: '40%', fontFamily: FONT[700], fontSize: 14, lineHeight: 19, color: NAVY, textAlign: 'right' }}>{to}</Text>
    </View>
  );
}

// One segment per step of this request's workflow, filled up to the current step (from the start side: the right in Arabic, as the row mirrors).
function Progress({ progress, stage, t }) {
  return (
    <View style={{ gap: 8 }}>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap: 5 }}>
        {Array.from({ length: progress.total }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i < progress.step ? COLORS.primary : '#E4E9F2' }} />
        ))}
      </View>
      <Text style={{ fontSize: 13, lineHeight: 18 }}>
        <Text style={{ fontFamily: FONT[400], color: MUTED }}>{t('mr_step_of', { n: progress.step, total: progress.total })}</Text>
        {stage ? <Text style={{ fontFamily: FONT[700], color: NAVY }}>{` · ${stage}`}</Text> : null}
      </Text>
    </View>
  );
}

export function ActiveRequestCard({ item, onOpen, onTrack, isNew }) {
  const { t, isRTL } = useApp();
  const v = activeCardView(item, t);
  return (
    <View
      testID={`active-card-${v.reference}`}
      style={{
        backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: 18, padding: 16, gap: 14,
        shadowColor: NAVY, shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 2,
      }}
    >
      {/* After a pull-to-refresh a request that is new fades from #E2E3EF to the card colour behind its content (My Requests). */}
      {isNew ? <HighlightFill radius={18} /> : null}
      {/* The body of the card (everything above the Track button) opens Request Details of THIS request, and reads as one summary for a screen reader. The Track Request button below is NOT inside
          it (a sibling), so one tap is one action: the button cannot also open the details. */}
      <PressBox
        accessibilityRole="button" accessibilityLabel={`${v.label}. ${t('mr_view_details')}`} onPress={onOpen}
        style={({ pressed }) => ({ gap: 14, opacity: pressed ? 0.92 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <ServiceIconTile serviceKey={v.key} size={44} tint={COLORS.primarySoft} color={COLORS.primary} fill={COLORS.primary} fillOpacity={0.22} radius={12} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: FONT[800], fontSize: 16, lineHeight: 21, color: NAVY }}>{v.name}</Text>
            {/* The request number never breaks: "variant · " may wrap onto its own line, REQ-1067 stays whole. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' }}>
              {v.variant ? <Text style={{ flexShrink: 1, fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: MUTED }}>{`${v.variant} · `}</Text> : null}
              <Text style={{ flexShrink: 0, fontFamily: FONT[400], fontSize: 13, lineHeight: 18, color: MUTED }}>{v.reference}</Text>
            </View>
          </View>
          <View style={{ maxWidth: '44%', flexShrink: 1, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, backgroundColor: v.badge.bg, alignItems: 'center' }}>
            <Text style={{ fontFamily: FONT[800], fontSize: 12.5, lineHeight: 16, textAlign: 'center', color: v.badge.fg }}>{v.statusLabel}</Text>
          </View>
        </View>
        {v.route ? <Route from={v.route.from} to={v.route.to} /> : null}
        {v.progress ? <Progress progress={v.progress} stage={v.stage} t={t} /> : null}
      </PressBox>
      <PressBox
        accessibilityRole="button"
        accessibilityLabel={`${t('home_track_request')}, ${v.reference}`}
        onPress={onTrack}
        hitSlop={{ top: 1, bottom: 1 }}
        style={({ pressed }) => ({ minHeight: 46, borderRadius: 12, backgroundColor: COLORS.primarySoft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, opacity: pressed ? 0.85 : 1 })}
      >
        <Text style={{ fontFamily: FONT[800], fontSize: 15, color: COLORS.primary }}>{t('home_track_request')}</Text>
        <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={18} color={COLORS.primary} strokeWidth={2.4} /></View>
      </PressBox>
    </View>
  );
}

// The "Active Requests" section of Home: the header and the ONE card, when there is exactly one active request.
// `section` is lib/activeRequests.js homeActiveSection; nothing at all is drawn for none, or for two or more (the Tracking tab lists those).
export function ActiveRequestsSection({ section, onOpen, onTrack }) {
  const { t } = useApp();
  if (!section || !section.visible) return null;
  return (
    <View style={{ marginBottom: 18, gap: 12 }}>
      <Text accessibilityRole="header" style={{ fontFamily: FONT[800], fontSize: 18, lineHeight: 24, color: NAVY }}>{t('home_active_requests')}</Text>
      {section.shown.map((item) => <ActiveRequestCard key={item.rawId} item={item} onOpen={() => onOpen(item)} onTrack={() => onTrack(item)} />)}
    </View>
  );
}
