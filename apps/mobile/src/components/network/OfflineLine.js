import { View } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { Text } from '../ui';

// One line that says why a button is pale while the phone is offline: a wifi-off icon and the sentence, 13 px, #5B6B84, centred (the same look as "Connect to the internet to submit." on the request form).
export function OfflineLine({ text }) {
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><WifiOff size={16} color="#5B6B84" strokeWidth={2.2} /></View>
      <Text style={{ flexShrink: 1, textAlign: 'center', fontSize: 13, lineHeight: 18, color: '#5B6B84' }}>{text}</Text>
    </View>
  );
}
