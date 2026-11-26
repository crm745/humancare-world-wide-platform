import { Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { ChevronRight } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { ServiceIconTile } from '../home/ServiceIcon';
import { PressBox } from '../PressBox';
import { HighlightFill } from '../skeleton/HighlightFill';
import { trackingCardView } from '../../lib/activeRequests';
import { COLORS } from '../../theme/colors';

// One request on the Tracking tab: the shorter "tracking" card. No status pill and no full-width button (the stage line says where the request is, and a small "Track ›" button opens its
// tracking). The Home / My Requests card (components/home/ActiveRequestCard.js) is a different component and is not touched. Every text comes from lib/activeRequests.js trackingCardView.
// The whole card opens Tracking Details of THIS request, and reads to a screen reader as one summary; the Track button is its own button. The row layout mirrors in Arabic by itself (RTL flex).
const NAVY = '#0D2340';
const MUTED = '#5B6B84';
const PRIMARY = COLORS.primary;
const TILE = COLORS.primarySoft;
const LINE = '#E4E9F2';
const FONT = { 400: 'Inter_400Regular', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

function Route({ from, to }) {
  const text = { flexShrink: 1, maxWidth: '40%', fontFamily: FONT[700], fontSize: 13.5, lineHeight: 18, color: NAVY };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={text}>{from}</Text>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: PRIMARY }} />
        <Svg height={2} style={{ flex: 1 }}>
          <Line x1="0" y1="1" x2="100%" y2="1" stroke="#C9D3E1" strokeWidth={1} strokeDasharray="4 3" />
        </Svg>
        <View style={{ width: 7, height: 7, borderRadius: 4, borderWidth: 1.5, borderColor: PRIMARY }} />
      </View>
      <Text style={text}>{to}</Text>
    </View>
  );
}

// One segment per step of this request's workflow, filled up to the current step, from the start side (the right in Arabic, as the row mirrors).
function Segments({ total, step }) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap: 4 }}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: i < step ? PRIMARY : LINE }} />
      ))}
    </View>
  );
}

export function TrackingRequestCard({ item, onTrack, isNew, now }) {
  const { t, isRTL } = useApp();
  const v = trackingCardView(item, t, now);
  return (
    <View
      testID={`tracking-card-${v.reference}`}
      style={{
        backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 16, padding: 14, gap: 10,
        shadowColor: NAVY, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1,
      }}
    >
      {isNew ? <HighlightFill radius={16} /> : null}
      <PressBox
        testID={`tracking-card-body-${v.reference}`}
        accessibilityRole="button" accessibilityLabel={v.label} onPress={onTrack}
        style={({ pressed }) => ({ gap: 10, opacity: pressed ? 0.92 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <ServiceIconTile serviceKey={v.key} size={40} radius={11} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: FONT[800], fontSize: 15, lineHeight: 20, color: NAVY }}>{v.name}</Text>
            {/* The request number never breaks: "variant · " may wrap onto its own line, REQ-1067 stays whole. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' }}>
              {v.variant ? <Text style={{ flexShrink: 1, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: MUTED }}>{`${v.variant} · `}</Text> : null}
              <Text style={{ flexShrink: 0, fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: MUTED }}>{v.reference}</Text>
            </View>
          </View>
        </View>
        {v.route ? <Route from={v.route.from} to={v.route.to} /> : null}
        {v.progress ? <Segments total={v.progress.total} step={v.progress.step} /> : null}
      </PressBox>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {/* Tapping the stage text opens the same tracking; it is part of the card's summary, so it is not a second control for a screen reader. */}
        <PressBox accessible={false} importantForAccessibility="no" onPress={onTrack} style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: FONT[800], fontSize: 14, lineHeight: 19, color: NAVY }}>{v.stage}</Text>
          {v.subline ? <Text style={{ fontFamily: FONT[400], fontSize: 12.5, lineHeight: 17, color: MUTED }}>{v.subline}</Text> : null}
        </PressBox>
        <PressBox
          testID={`tracking-track-${v.reference}`}
          accessibilityRole="button" accessibilityLabel={`${t('tr_track')}, ${v.reference}`} onPress={onTrack}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={({ pressed }) => ({ height: 36, paddingStart: 12, paddingEnd: 4, borderRadius: 10, backgroundColor: TILE, flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.85 : 1 })}
        >
          <Text style={{ fontFamily: FONT[800], fontSize: 14, color: PRIMARY }}>{t('tr_track')}</Text>
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ChevronRight size={18} color={PRIMARY} strokeWidth={2.4} /></View>
        </PressBox>
      </View>
    </View>
  );
}
