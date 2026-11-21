import { View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import { COLORS, NOTICE } from '../../theme/colors';
import { Button, Text } from '../ui';
import { NETWORK_ICONS } from './icons';

// The ONE layout of "something is not available right now": a screen that could not load (components/LoadFailure.js) and the Can't Connect screen (app/cant-connect.js) both use it.
//   a 128 px soft circle, an 84 px white circle with a soft shadow inside it, the 38 px icon in the brand blue, and a small warning badge with "!" at its bottom right
//   the title, the body, a filled "Try again" button with a refresh icon, and (optionally) a pill under the button
const FONT = { 400: 'Inter_400Regular', 700: 'Inter_700Bold', 800: 'Inter_800ExtraBold' };

export function StateView({ icon, title, body, retryLabel, onRetry, retrying = false, pill = null, style }) {
  const Icon = NETWORK_ICONS[icon];
  const PillIcon = pill ? NETWORK_ICONS[pill.icon] : null;
  return (
    <View accessibilityRole="alert" style={[{ alignItems: 'center', paddingHorizontal: 20 }, style]}>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 128, height: 128, borderRadius: 64, backgroundColor: COLORS.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: COLORS.primary, shadowOpacity: 0.16, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4 }}>
          <Icon size={38} color={COLORS.primary} strokeWidth={2} />
        </View>
        <View style={{ position: 'absolute', end: 2, bottom: 2, width: 36, height: 36, borderRadius: 18, backgroundColor: '#F3F4FA', alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: NOTICE.warning.bg, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: FONT[800], fontSize: 15, lineHeight: 18, color: NOTICE.warning.text }}>!</Text>
          </View>
        </View>
      </View>
      <Text accessibilityRole="header" style={{ marginTop: 28, textAlign: 'center', fontFamily: FONT[800], fontSize: 22, lineHeight: 28, color: '#0D2340' }}>{title}</Text>
      {body ? <Text style={{ marginTop: 10, maxWidth: 300, textAlign: 'center', fontFamily: FONT[400], fontSize: 15, lineHeight: 22, color: '#5B6B84' }}>{body}</Text> : null}
      {onRetry ? (
        <View style={{ width: '100%', maxWidth: 300, marginTop: 28 }}>
          <Button
            title={retryLabel} onPress={onRetry} loading={retrying} className="min-h-[52px] rounded-2xl"
            icon={<RefreshCw size={19} color="#FFFFFF" strokeWidth={2.4} />}
          />
        </View>
      ) : null}
      {pill ? (
        <View style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: NOTICE.success.bg }}>
          <PillIcon size={17} color={NOTICE.success.text} strokeWidth={2.2} />
          <Text style={{ fontFamily: FONT[700], fontSize: 14, lineHeight: 19, color: NOTICE.success.text }}>{pill.text}</Text>
        </View>
      ) : null}
    </View>
  );
}
