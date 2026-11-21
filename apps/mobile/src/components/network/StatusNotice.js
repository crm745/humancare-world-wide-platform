import { View } from 'react-native';
import { NOTICE } from '../../theme/colors';
import { Text } from '../ui';
import { Reveal } from '../skeleton/Reveal';
import { NETWORK_ICONS } from './icons';

// A notice card: a warning (something that may not have gone through) or an info note (something that already happened). One icon, a title, an optional text and an optional
// action underneath (a link or a button passed as children). Colours: theme/colors.js NOTICE.
const FONT = { 400: 'Inter_400Regular', 800: 'Inter_800ExtraBold' };
const LOOK = {
  warning: { box: NOTICE.warning, title: NOTICE.warning.title, text: NOTICE.warning.text, icon: NOTICE.warning.title },
  info: { box: NOTICE.info, title: NOTICE.info.title, text: NOTICE.info.text, icon: NOTICE.info.text },
};

export function StatusNotice({ tone = 'warning', icon = 'alert', title, text, children, style, accessibilityRole = 'alert' }) {
  const look = LOOK[tone];
  const Icon = NETWORK_ICONS[icon];
  // A notice APPEARS with the app's Reveal (fade + a 6 px rise); with Reduce Motion it simply appears.
  return (
    <Reveal animate>
    <View accessibilityRole={accessibilityRole} style={[{ flexDirection: 'row', gap: 12, borderRadius: 14, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: look.box.bg, borderColor: look.box.border }, style]}>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ paddingTop: 1 }}>
        <Icon size={22} color={look.icon} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? <Text style={{ fontFamily: FONT[800], fontSize: 14.5, lineHeight: 20, color: look.title }}>{title}</Text> : null}
        {text ? <Text style={{ marginTop: title ? 2 : 0, fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19, color: look.text }}>{text}</Text> : null}
        {children}
      </View>
    </View>
    </Reveal>
  );
}
