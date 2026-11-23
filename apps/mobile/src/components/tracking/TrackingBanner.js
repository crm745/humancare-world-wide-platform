import { useEffect, useMemo, useState } from 'react';
import { Image, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { CalendarCheck, Clock } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { ServiceIcon } from '../home/ServiceIcon';
import { FONT } from '../request/DetailsParts';
import { COLORS } from '../../theme/colors';
import { GLOW, GRADIENT, bannerAccessibilityLabel, bannerTexts, relativeParts, relativeSpoken, relativeText, startMinuteTicker, statusColorOf } from '../../lib/trackingBanner';
import { placeImage, textWidths } from '../../lib/trackingBannerImages';

// The top card of Tracking Details: a blue banner (the service chip and the request number, the route or the service, the service's drawn picture) over a white strip
// (current status, last updated). Everything it says comes from `d`, built by lib/trackingDetailsView.js; the chip is configured in lib/trackingBannerConfig.js and the picture's
// size and place in lib/trackingBannerImages.js. The pictures are bundled with the app and never loaded from the network. A service with no picture is the blue alone.
const BRAND = COLORS.primary;
const LINE = '#E4E9F2';
const TILE = COLORS.primarySoft;
const NAVY = '#0D2340';
const MUTED = '#5B6B84';

// The bundled pictures, by the name lib/trackingBannerImages.js uses.
const PICTURES = {
  'banner-private-charter': require('../../../assets/images/banner/banner-private-charter.png'),
  'banner-medical-escort': require('../../../assets/images/banner/banner-medical-escort.png'),
  'banner-ground-ambulance': require('../../../assets/images/banner/banner-ground-ambulance.png'),
  'banner-hospital': require('../../../assets/images/banner/banner-hospital.png'),
  'banner-home-healthcare': require('../../../assets/images/banner/banner-home-healthcare.png'),
  'banner-teleconsultation': require('../../../assets/images/banner/banner-teleconsultation.png'),
  'banner-repatriation': require('../../../assets/images/banner/banner-repatriation.png'),
  'banner-marine': require('../../../assets/images/banner/banner-marine.png'),
  'banner-medical-travel': require('../../../assets/images/banner/banner-medical-travel.png'),
  'banner-corporate': require('../../../assets/images/banner/banner-corporate.png'),
};

// The current time, moved on once a minute while the screen is open (so "2 min ago" keeps up).
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startMinuteTicker(() => setNow(Date.now())), []);
  return now;
}

function Cell({ tile, label, value, valueColor, round, isRTL }) {
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 38, height: 38, borderRadius: round ? 19 : 11, backgroundColor: TILE, alignItems: 'center', justifyContent: 'center' }}>{tile}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{ fontFamily: FONT[600], fontSize: 12, lineHeight: 16, color: MUTED, textAlign: isRTL ? 'right' : 'left' }}>{label}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" adjustsFontSizeToFit minimumFontScale={0.8} style={{ fontFamily: FONT[800], fontSize: 15, lineHeight: 20, color: valueColor, textAlign: isRTL ? 'right' : 'left' }}>{value}</Text>
      </View>
    </View>
  );
}

// `d` is what buildTrackingDetails returns.
export default function TrackingBanner({ d }) {
  const { t, isRTL } = useApp();
  const { width: screenWidth } = useWindowDimensions();
  const [cardWidth, setCardWidth] = useState(Math.max(0, screenWidth - 32));
  const now = useMinuteClock();

  const texts = useMemo(() => bannerTexts(d, isRTL), [d, isRTL]);
  const parts = relativeParts(d.updatedAt, now);
  const when = relativeText(parts, t);
  const statusLabel = d.badge.label;
  const label = bannerAccessibilityLabel({ ...d, status: statusLabel, whenSpoken: relativeSpoken(parts, t) }, t);

  const image = d.bannerImage && PICTURES[d.bannerImage.image] ? d.bannerImage : null;
  const place = placeImage(image, screenWidth);
  const widths = textWidths({ image, cardWidth, screenWidth, title: texts.title });
  const align = isRTL ? 'right' : 'left';
  // The picture's corner: bottom-right, and bottom-left in Arabic, with the same offsets. (The screen's own direction already runs the rows the other way.)
  const side = isRTL ? 'left' : 'right';
  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

  return (
    <View
      accessible accessibilityRole="summary" accessibilityLabel={label}
      onLayout={(e) => setCardWidth(Math.round(e.nativeEvent.layout.width))}
      style={{ backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: LINE, overflow: 'hidden', shadowColor: NAVY, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.1, shadowRadius: 24, elevation: 4 }}
    >
      <View style={{ minHeight: 158, padding: 16, backgroundColor: GRADIENT.colors[1] }}>
        <LinearGradient colors={GRADIENT.colors} locations={GRADIENT.locations} start={GRADIENT.start} end={GRADIENT.end} style={fill} />
        {/* A soft glow in the top corner: a radial fade from white to nothing, never a solid circle. */}
        <View accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ position: 'absolute', top: -GLOW.size / 2, [side]: -GLOW.size / 3, width: GLOW.size, height: GLOW.size }}>
          <Svg width={GLOW.size} height={GLOW.size}>
            <Defs>
              <RadialGradient id="tbGlow" cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#FFFFFF" stopOpacity={GLOW.opacity} />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={GLOW.size / 2} cy={GLOW.size / 2} r={GLOW.size / 2} fill="url(#tbGlow)" />
          </Svg>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flexShrink: 1, minWidth: 0, height: 28, borderRadius: 14, paddingHorizontal: 11, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ServiceIcon serviceKey={d.chipIcon} size={15} color={BRAND} fill={BRAND} fillOpacity={0.15} />
            {texts.showChipLabel ? <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: FONT[800], fontSize: 12.5, color: BRAND }}>{d.chipLabel}</Text> : null}
          </View>
          <View style={{ width: 1, height: 16, backgroundColor: 'rgba(255,255,255,0.35)' }} />
          <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: FONT[700], fontSize: 12.5, letterSpacing: 0.375, color: 'rgba(255,255,255,0.85)' }}>{d.reference}</Text>
        </View>

        <View style={{ marginTop: 14, alignItems: 'flex-start' }}>
          <Text numberOfLines={2} ellipsizeMode="tail" style={{ maxWidth: widths.title, fontFamily: FONT[800], fontSize: 22, lineHeight: 28, color: '#FFFFFF', textAlign: align }}>{texts.title}</Text>
          {texts.subtitle ? <Text numberOfLines={2} ellipsizeMode="tail" style={{ maxWidth: widths.subtitle, marginTop: 4, fontFamily: FONT[400], fontSize: 13.5, lineHeight: 18, color: 'rgba(255,255,255,0.82)', textAlign: align }}>{texts.subtitle}</Text> : null}
        </View>

        {image ? (
          <Image
            source={PICTURES[image.image]} accessible={false} importantForAccessibility="no" resizeMode="contain"
            style={{ position: 'absolute', bottom: place.bottom, [side]: place.right, width: place.width, height: place.height }}
          />
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: '#FFFFFF' }}>
        <Cell isRTL={isRTL} tile={<CalendarCheck size={20} color={BRAND} strokeWidth={2} />} label={t('tb_status_label')} value={statusLabel} valueColor={statusColorOf(d.status)} />
        <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: LINE }} />
        <Cell isRTL={isRTL} round tile={<Clock size={20} color={BRAND} strokeWidth={2} />} label={t('tb_updated_label')} value={when || '—'} valueColor={NAVY} />
      </View>
    </View>
  );
}
