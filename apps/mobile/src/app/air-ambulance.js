import { View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { AIR_OPTIONS } from '../data/mock';
import { Body, Screen, TopBar } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ServiceIcon } from '../components/home/ServiceIcon';
import { PressBox } from '../components/PressBox';

const NAVY = '#0D2340';

// Air Ambulance, opened from its one tile on Home: a clean choice between the two air services, each a card that goes
// to that service's own existing page (the same one its tile opened before). Nothing new is requested or stored here.
// It is a normal screen on the stack, so the back button and the Android back key both return to Home.
export default function AirAmbulance() {
  const { t, isRTL } = useApp();
  return (
    <Screen>
      <TopBar title={t('svc_air')} />
      <Body contentClassName="px-[18px] py-[18px]">
        <Text className="mb-4 text-[14px] leading-[20px] text-muted">{t('air_amb_sub')}</Text>
        <View style={{ gap: 12 }}>
          {AIR_OPTIONS.map((s) => (
            <PressBox
              key={s.key}
              accessibilityRole="button"
              accessibilityLabel={`${t(s.title)}. ${t(s.sub)}`}
              onPress={() => openService(s.key)}
              style={({ pressed }) => ({ minHeight: 84, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, backgroundColor: pressed ? '#F5F8FC' : '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#E4E9F2' })}
            >
              <View style={{ width: 54, height: 54, borderRadius: 14, backgroundColor: '#EDF2F9', alignItems: 'center', justifyContent: 'center' }}>
                <ServiceIcon serviceKey={s.key} size={25} color={NAVY} fill={NAVY} fillOpacity={0.12} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text className="font-inter-semibold" style={{ fontSize: 14.5, lineHeight: 20, color: NAVY }}>{t(s.title)}</Text>
                <Text style={{ marginTop: 3, fontSize: 12.5, lineHeight: 17, color: '#5B6B84' }}>{t(s.sub)}</Text>
              </View>
              <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
                <ChevronRight size={18} color="#8A9BB5" strokeWidth={2.2} />
              </View>
            </PressBox>
          ))}
        </View>
      </Body>
    </Screen>
  );
}
