import { View } from 'react-native';
import { reviewBanner } from '../../lib/requestDocuments';
import { Text } from '../ui';

const TONE = {
  warning: { box: 'border-warning bg-warning-soft', text: 'text-warning' },
  info: { box: 'border-primary bg-primary-soft', text: 'text-primary-dark' },
  success: { box: 'border-success bg-success-soft', text: 'text-success' },
};

// Where a request in the review workflow stands, and what the Admin asked for while changes are
// requested. Nothing for older requests and other services.
export default function ReviewBanner({ request }) {
  const banner = reviewBanner(request);
  if (!banner) return null;
  const tone = TONE[banner.tone];
  return (
    <View className={`mb-6 rounded-xl border px-3.5 py-3 ${tone.box}`} accessibilityRole="summary">
      <Text className={`font-inter-bold text-[14px] ${tone.text}`}>{banner.title}</Text>
      {banner.reason && (
        <View className="mt-2">
          <Text className="text-[12px] text-faint">What we need from you</Text>
          <Text className="mt-0.5 text-[13.5px] leading-5 text-ink">{banner.reason}</Text>
        </View>
      )}
    </View>
  );
}
