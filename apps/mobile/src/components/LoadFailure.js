import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Button, Text } from './ui';

// What a screen shows when its first load failed and there is nothing to display: a short message and a "Try again" button
// (the skeleton never stays for ever). `onRetry` runs the load again.
export function LoadFailure({ message, onRetry }) {
  const { t } = useApp();
  return (
    <View className="items-center px-5 py-[50px]" accessibilityRole="alert">
      <Text className="mb-4 text-center text-[13.5px] leading-5 text-muted">{message || t('sk_load_failed')}</Text>
      {onRetry ? <Button variant="outline" title={t('sk_try_again')} onPress={onRetry} className="min-w-[140px]" /> : null}
    </View>
  );
}
