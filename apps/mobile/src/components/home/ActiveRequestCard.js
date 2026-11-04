import { Pressable, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';
import { ServiceIconTile } from './ServiceIcon';

// origin -> destination with a dashed line between the two dots.
function Route({ origin, destination }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text className="font-inter-bold" numberOfLines={1} style={{ flexShrink: 1, maxWidth: '40%', fontSize: 13, color: '#17233D' }}>{origin}</Text>
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#1A73E8' }} />
        <Svg height={2} style={{ flex: 1 }}>
          <Line x1="0" y1="1" x2="100%" y2="1" stroke="#C9D3E1" strokeWidth={2} strokeDasharray="4 3" />
        </Svg>
        <View style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 2, borderColor: '#1A73E8' }} />
      </View>
      <Text className="font-inter-bold" numberOfLines={1} style={{ flexShrink: 1, maxWidth: '40%', fontSize: 13, color: '#17233D', textAlign: 'right' }}>{destination}</Text>
    </View>
  );
}

// One segment per step: finished ones green, the current one blue, the rest grey.
function Progress({ step, total }) {
  const { t } = useApp();
  const label = t('home_step_of').replace('{n}', step).replace('{total}', total);
  return (
    <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 5, borderRadius: 5, backgroundColor: i + 1 < step ? '#1E8E4A' : i + 1 === step ? '#1A73E8' : '#E4E9F2' }} />
        ))}
      </View>
      <Text style={{ fontSize: 12, color: '#5B6B84' }}>{label}</Text>
    </View>
  );
}

// `request`: { serviceKey, serviceName, reference, statusLabel, origin, destination, step, totalSteps }.
// The route and progress rows are left out when the request doesn't have that data.
export function ActiveRequestCard({ request, onTrack }) {
  const { t } = useApp();
  const { serviceKey, serviceName, reference, statusLabel, origin, destination, step, totalSteps } = request;
  return (
    <View
      style={{ marginBottom: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: 18, padding: 14, gap: 11, shadowColor: '#0D2340', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 1 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text className="font-inter-bold" style={{ flexShrink: 1, fontSize: 12.5, color: '#5B6B84' }}>{t('home_active_request')}</Text>
        <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#D6E6FD' }}>
          <Text className="font-inter-black" style={{ fontSize: 12, color: '#0F4FB0' }}>{statusLabel}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ServiceIconTile serviceKey={serviceKey} tint="#E7F0FE" color="#1A5FC4" fill="#1A73E8" fillOpacity={0.22} radius={13} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text className="font-inter-black" style={{ fontSize: 15, color: '#0D2340' }}>{serviceName}</Text>
          <Text style={{ fontSize: 12.5, color: '#5B6B84' }}>{reference}</Text>
        </View>
      </View>
      {origin && destination ? <Route origin={origin} destination={destination} /> : null}
      {step && totalSteps ? <Progress step={step} total={totalSteps} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('home_track_request')}, ${reference}`}
        onPress={onTrack}
        style={{ minHeight: 44, borderRadius: 12, backgroundColor: '#E7F0FE', alignItems: 'center', justifyContent: 'center' }}
      >
        <Text className="font-inter-black" style={{ fontSize: 13.5, color: '#1A5FC4' }}>{t('home_track_request')}</Text>
      </Pressable>
    </View>
  );
}
