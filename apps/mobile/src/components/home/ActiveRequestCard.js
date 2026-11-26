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

// The sizes of the two variants. "full" (Home, the default) is the original card; "compact" (My Requests) is the same card with smaller sizes, so more fit on the screen.
const SIZES = {
  full: {
    pad: 16, radius: 18, gap: 14, shadow: { shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 2 }, tile: 44, tileRadius: 12, tileGap: 12,
    name: [16, 21], sub: [13, 18], pill: { py: 4, px: 10, radius: 12, size: 12.5, line: 16, max: '44%' }, route: [14, 19], dot: 7, hollow: 7, seg: 6, segGap: 5, bar: 8, step: [13, 18],
    track: { minHeight: 46, radius: 12, size: 15, arrow: 18 },
  },
  compact: {
    pad: 14, radius: 16, gap: 10, shadow: { shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 }, tile: 40, tileRadius: 11, tileGap: 12,
    name: [15, 20], sub: [12.5, 17], pill: { py: 3, px: 9, radius: 11, size: 12, line: 16, max: '42%' }, route: [13.5, 18], dot: 6, hollow: 7, seg: 5, segGap: 4, bar: 6, step: [12.5, 17],
    track: { minHeight: 36, radius: 10, size: 14, arrow: 15 },
    inline: true, // the step line and the Track Request button share ONE row under the bar (as on the Tracking card), instead of the button under the step line
  },
};

function Route({ from, to, S }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={2} style={{ flexShrink: 1, maxWidth: '40%', fontFamily: FONT[700], fontSize: S.route[0], lineHeight: S.route[1], color: NAVY }}>{from}</Text>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <View style={{ width: S.dot, height: S.dot, borderRadius: S.dot / 2, backgroundColor: COLORS.primary }} />
        <Svg height={2} style={{ flex: 1 }}>
          <Line x1="0" y1="1" x2="100%" y2="1" stroke="#C9D3E1" strokeWidth={2} strokeDasharray="4 3" />
        </Svg>
        <View style={{ width: S.hollow, height: S.hollow, borderRadius: S.hollow / 2, borderWidth: S === SIZES.compact ? 1.5 : 2, borderColor: COLORS.primary }} />
      </View>
      <Text numberOfLines={2} style={{ flexShrink: 1, maxWidth: '40%', fontFamily: FONT[700], fontSize: S.route[0], lineHeight: S.route[1], color: NAVY, textAlign: 'right' }}>{to}</Text>
    </View>
  );
}

// One segment per step of this request's workflow, filled up to the current step (from the start side: the right in Arabic, as the row mirrors).
// "Step 1 of 5 · Request received".
function StepLine({ progress, stage, t, S }) {
  return (
    <Text style={{ fontSize: S.step[0], lineHeight: S.step[1] }}>
      <Text style={{ fontFamily: FONT[400], color: MUTED }}>{t('mr_step_of', { n: progress.step, total: progress.total })}</Text>
      {stage ? <Text style={{ fontFamily: FONT[700], color: NAVY }}>{` · ${stage}`}</Text> : null}
    </Text>
  );
}

function Progress({ progress, stage, t, S }) {
  const segments = (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap: S.segGap }}>
      {Array.from({ length: progress.total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: S.seg, borderRadius: 3, backgroundColor: i < progress.step ? COLORS.primary : '#E4E9F2' }} />
      ))}
    </View>
  );
  if (S.inline) return segments; // the step line is drawn beside the Track Request button (StepLine)
  return (
    <View style={{ gap: S.bar }}>
      {segments}
      <StepLine progress={progress} stage={stage} t={t} S={S} />
    </View>
  );
}

// `variant`: "full" (the default: Home) or "compact" (the My Requests list). Only sizes differ; the content and its order are the same.
export function ActiveRequestCard({ item, onOpen, onTrack, isNew, variant = 'full' }) {
  const { t, isRTL } = useApp();
  const S = SIZES[variant] || SIZES.full;
  const v = activeCardView(item, t);
  return (
    <View
      testID={`active-card-${v.reference}`}
      style={{
        backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: S.radius, padding: S.pad, gap: S.gap,
        shadowColor: NAVY, ...S.shadow,
      }}
    >
      {/* After a pull-to-refresh a request that is new fades from #E2E3EF to the card colour behind its content (My Requests). */}
      {isNew ? <HighlightFill radius={S.radius} /> : null}
      {/* The body of the card (everything above the Track button) opens Request Details of THIS request, and reads as one summary for a screen reader. The Track Request button below is NOT inside
          it (a sibling), so one tap is one action: the button cannot also open the details. */}
      <PressBox
        accessibilityRole="button" accessibilityLabel={`${v.label}. ${t('mr_view_details')}`} onPress={onOpen}
        style={({ pressed }) => ({ gap: S.gap, opacity: pressed ? 0.92 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: S.tileGap }}>
          <ServiceIconTile serviceKey={v.key} size={S.tile} radius={S.tileRadius} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: FONT[800], fontSize: S.name[0], lineHeight: S.name[1], color: NAVY }}>{v.name}</Text>
            {/* The request number never breaks: "variant · " may wrap onto its own line, REQ-1067 stays whole. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' }}>
              {v.variant ? <Text style={{ flexShrink: 1, fontFamily: FONT[400], fontSize: S.sub[0], lineHeight: S.sub[1], color: MUTED }}>{`${v.variant} · `}</Text> : null}
              <Text style={{ flexShrink: 0, fontFamily: FONT[400], fontSize: S.sub[0], lineHeight: S.sub[1], color: MUTED }}>{v.reference}</Text>
            </View>
          </View>
          <View style={{ maxWidth: S.pill.max, flexShrink: 1, paddingVertical: S.pill.py, paddingHorizontal: S.pill.px, borderRadius: S.pill.radius, backgroundColor: v.badge.bg, alignItems: 'center' }}>
            <Text style={{ fontFamily: FONT[800], fontSize: S.pill.size, lineHeight: S.pill.line, textAlign: 'center', color: v.badge.fg }}>{v.statusLabel}</Text>
          </View>
        </View>
        {v.route ? <Route from={v.route.from} to={v.route.to} S={S} /> : null}
        {v.progress ? <Progress progress={v.progress} stage={v.stage} t={t} S={S} /> : null}
      </PressBox>
      {S.inline ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {/* The step text opens the details like the rest of the body; it is part of the card's summary, so it is not a second control for a screen reader. */}
          <PressBox accessible={false} importantForAccessibility="no" onPress={onOpen} style={{ flex: 1, minWidth: 0 }}>
            {v.progress ? <StepLine progress={v.progress} stage={v.stage} t={t} S={S} /> : null}
          </PressBox>
          <PressBox
            accessibilityRole="button"
            accessibilityLabel={`${t('tr_track')}, ${v.reference}`}
            onPress={onTrack}
            hitSlop={{ top: Math.ceil((48 - S.track.minHeight) / 2), bottom: Math.ceil((48 - S.track.minHeight) / 2), left: 6, right: 6 }}
            style={({ pressed }) => ({ maxWidth: '55%', flexShrink: 0, minHeight: S.track.minHeight, borderRadius: S.track.radius, backgroundColor: COLORS.primarySoft, flexDirection: 'row', alignItems: 'center', gap: 4, paddingStart: 12, paddingEnd: 4, opacity: pressed ? 0.85 : 1 })}
          >
            <Text style={{ flexShrink: 1, fontFamily: FONT[800], fontSize: S.track.size, color: COLORS.primary }}>{t('tr_track')}</Text>
            <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={S.track.arrow} color={COLORS.primary} strokeWidth={2.4} /></View>
          </PressBox>
        </View>
      ) : (
        <PressBox
          accessibilityRole="button"
          accessibilityLabel={`${t('home_track_request')}, ${v.reference}`}
          onPress={onTrack}
          hitSlop={{ top: Math.ceil((48 - S.track.minHeight) / 2), bottom: Math.ceil((48 - S.track.minHeight) / 2) }}
          style={({ pressed }) => ({ minHeight: S.track.minHeight, borderRadius: S.track.radius, backgroundColor: COLORS.primarySoft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, opacity: pressed ? 0.85 : 1 })}
        >
          <Text style={{ fontFamily: FONT[800], fontSize: S.track.size, color: COLORS.primary }}>{t('home_track_request')}</Text>
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ArrowRight size={S.track.arrow} color={COLORS.primary} strokeWidth={2.4} /></View>
        </PressBox>
      )}
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
