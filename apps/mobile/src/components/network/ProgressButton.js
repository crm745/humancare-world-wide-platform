import { View } from 'react-native';
import { Upload } from 'lucide-react-native';
import { COLORS } from '../../theme/colors';
import { Text } from '../ui';

// The Submit button while files upload: it IS the progress bar. A lighter base, the brand blue filling it from the start side as the overall upload progresses, an upload icon and the label
// ("Uploading file 2 of 3… 62%"). It takes no press (the upload is running). `progress` is 0..1.
const BASE = '#5D66AD';

export function ProgressButton({ title, progress = 0 }) {
  const share = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return (
    <View
      accessibilityRole="progressbar" accessibilityLabel={title} accessibilityState={{ disabled: true, busy: true }}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
      style={{ minHeight: 52, borderRadius: 16, backgroundColor: BASE, overflow: 'hidden', justifyContent: 'center' }}
    >
      <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, width: `${share * 100}%`, backgroundColor: COLORS.primary }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 }}>
        <Upload size={19} color="#FFFFFF" strokeWidth={2.4} />
        <Text className="font-inter-bold" numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 15 }}>{title}</Text>
      </View>
    </View>
  );
}
