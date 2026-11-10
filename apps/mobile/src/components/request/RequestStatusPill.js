import { View } from 'react-native';
import { Pill, Text } from '../ui';
import { toUiStatus } from '../../lib/requestShape';

const TONE = {
  warning: 'bg-warning-soft text-warning',
  info: 'bg-primary-soft text-primary-dark',
  success: 'bg-success-soft text-success',
};

// The status chip of a request. A request in the review workflow passes its `pill` (see reviewPill in
// lib/requestDocuments), which says the same as its banner; every other request, and a workflow request
// whose Case is under way, keeps the usual chip for its status.
export default function RequestStatusPill({ pill, status }) {
  if (!pill) return <Pill status={toUiStatus(status)} />;
  const [bg, fg] = TONE[pill.tone].split(' ');
  return (
    <View className={`rounded-full px-2.5 py-1 ${bg}`}>
      <Text className={`font-inter-black text-[11.5px] uppercase tracking-wide ${fg}`}>{pill.label}</Text>
    </View>
  );
}
