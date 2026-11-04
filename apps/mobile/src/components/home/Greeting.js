import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';

// "Hello, <name>" and the sub-line. With no name yet it is just "Hello".
export function Greeting({ name }) {
  const { t } = useApp();
  const hello = name ? `${t('greeting')} ${name}` : t('greeting').replace(/[,،]\s*$/, '');
  return (
    <View style={{ gap: 4, marginBottom: 16 }}>
      <Text className="font-inter-black" accessibilityRole="header" style={{ fontSize: 22, lineHeight: 28, letterSpacing: -0.22, color: '#0D2340' }}>{hello}</Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: '#5B6B84' }}>{t('greetingSub')}</Text>
    </View>
  );
}
