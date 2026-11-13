import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

// The building blocks of the Request Details screen, drawn to the design: a section label above a white card, and a
// label-over-value field whose value always wraps (nothing runs off the screen, however long).
export const FONT = { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };
export const C = { navy: '#0D2340', ink: '#17233D', muted: '#5B6B84', line: '#E4E9F2', divider: '#EEF1F6', blue: '#1A73E8', blueText: '#1A5FC4', soft: '#EEF3FB' };

// A long word or an address with no spaces breaks instead of widening the card (on the web the browser needs telling).
export const WRAP = Platform.OS === 'web' ? { overflowWrap: 'anywhere', wordBreak: 'break-word' } : null;

// 12/16/800 uppercase, #5B6B84, 4 from the left, 8 above its card. A heading for screen readers.
export function Section({ title, children }) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        accessibilityRole="header"
        style={{ paddingLeft: 4, fontFamily: FONT[800], fontSize: 12, lineHeight: 16, letterSpacing: 0.96, textTransform: 'uppercase', color: C.muted }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

// White, 1px #E4E9F2, radius 18, padding 16 (the summary and status cards use 20 and 18).
export function Card({ children, big, padding, style }) {
  return (
    <View style={[{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, borderRadius: big ? 20 : 18, padding: padding === undefined ? (big ? 18 : 16) : padding }, style]}>
      {children}
    </View>
  );
}

// Label 12.5/16/600 #5B6B84, 2 gap, value 15/21/700 #17233D, wrapping.
export function Field({ label, value, style }) {
  return (
    <View style={[{ minWidth: 0, gap: 2 }, style]}>
      <Text style={{ fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted }}>{label}</Text>
      <Text style={[{ fontFamily: FONT[700], fontSize: 15, lineHeight: 21, color: C.ink, flexShrink: 1 }, WRAP]}>{value}</Text>
    </View>
  );
}

// A vertical dashed line that fills the height it is given.
export function DashedLine({ color = '#C9D3E1' }) {
  const [height, setHeight] = useState(0);
  return (
    <View style={{ flex: 1, width: 2, minHeight: 8 }} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
      {height > 0 ? (
        <Svg width={2} height={height}>
          <Line x1={1} y1={0} x2={1} y2={height} stroke={color} strokeWidth={2} strokeDasharray="4 4" />
        </Svg>
      ) : null}
    </View>
  );
}

// The card for every state without live tracking: a 40x40 tile with an icon, a title and a line of text.
export function StatusLayout({ bg, fg, Icon, title, text, children }) {
  return (
    <Card big>
      <View accessibilityRole="summary" style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={20} color={fg} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[{ fontFamily: FONT[800], fontSize: 15.5, lineHeight: 21, color: C.navy }, WRAP]}>{title}</Text>
          {text ? <Text style={[{ marginTop: 2, fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19, color: C.muted }, WRAP]}>{text}</Text> : null}
          {children}
        </View>
      </View>
    </Card>
  );
}
