import { Clock } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { reviewBanner } from '../../lib/requestDocuments';
import { C, FONT, StatusLayout, WRAP } from './DetailsParts';
import { COLORS } from '../../theme/colors';

const TONE = {
  warning: { bg: '#FDF0DA', fg: '#8F4C08' },
  info: { bg: COLORS.primarySoft, fg: COLORS.primary },
};

// Where a request in the review workflow stands while it waits (for documents, for the patient's answer, or with
// the Admin), drawn as the screen's status card: the tile, where it stands, and what the Admin asked for while changes
// are requested. Nothing for older requests and other services, and nothing once approved (the status card says so).
export default function ReviewBanner({ request }) {
  const banner = reviewBanner(request);
  if (!banner) return null;
  if (banner.key === 'approved') return null;
  const tone = TONE[banner.tone] || TONE.info;
  return (
    <StatusLayout bg={tone.bg} fg={tone.fg} Icon={Clock} title={banner.title}>
      {banner.reason && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontFamily: FONT[600], fontSize: 12.5, lineHeight: 16, color: C.muted }}>What we need from you</Text>
          <Text style={[{ marginTop: 2, fontFamily: FONT[500], fontSize: 13.5, lineHeight: 19, color: C.ink }, WRAP]}>{banner.reason}</Text>
        </View>
      )}
    </StatusLayout>
  );
}
