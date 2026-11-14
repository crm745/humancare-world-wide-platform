import { View } from 'react-native';
import { Spinner } from './Spinner';
import { Text } from './ui';
import { COLORS } from '../theme/colors';

// Shown while a screen's data is on its way, so a screen never claims "nothing here"
// (or shows 0s) before it actually knows.
export function LoadingState({ label = 'Loading…', className = '' }) {
  return (
    <View className={`items-center justify-center gap-3 py-[50px] ${className}`}>
      <Spinner size={28} color={COLORS.primary} trackColor={COLORS.primarySoft} />
      {label ? <Text className="text-[12.5px] text-faint">{label}</Text> : null}
    </View>
  );
}

// Shown when loading failed and there's nothing to display (the toast says why).
export function LoadError({ message = "Couldn't load this. Please go back and try again." }) {
  return (
    <View className="items-center px-5 py-[50px]">
      <Text className="text-center text-[13px] text-faint">{message}</Text>
    </View>
  );
}
