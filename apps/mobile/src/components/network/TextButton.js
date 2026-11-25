import { PressBox } from '../PressBox';
import { Text } from '../ui';

// A plain text button (no box, no border): "Return home" under the Try again button, "Cancel" under a sheet. At least 44 px tall.
export function TextButton({ title, onPress, style }) {
  return (
    <PressBox accessibilityRole="button" onPress={onPress} style={({ pressed }) => [{ minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, opacity: pressed ? 0.6 : 1 }, style]}>
      <Text className="font-inter-bold" style={{ fontSize: 16, color: '#5B6B84' }}>{title}</Text>
    </PressBox>
  );
}
