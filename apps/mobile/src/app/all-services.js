import { useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { SERVICE_TILES } from '../data/mock';
import { goBack } from '../lib/nav';
import { BottomNav, Screen, useScrollToTopOnTabTap } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ServiceIcon } from '../components/home/ServiceIcon';
import { SosBar } from '../components/home/SosBar';

const TAB_BAR = 64;
const MAX_WIDTH = 720;
const NAVY = '#0D2340';

// Every service as its own full-width card with its subtitle, in one scrolling column. Same list and
// same destinations as the tiles on Home; a service added to SERVICE_TILES shows up here.
export default function AllServices() {
  const { t, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  const [sosH, setSosH] = useState(72);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  return (
    <Screen bg="" style={{ backgroundColor: '#F5F8FC' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E4E9F2' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('home_back')}
          onPress={goBack}
          style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#EEF3FB', alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
            <ChevronLeft size={20} color="#0D2340" strokeWidth={2.4} />
          </View>
        </Pressable>
        <Text className="font-inter-black" accessibilityRole="header" style={{ fontSize: 16, color: '#0D2340' }}>{t('filter_svc_all')}</Text>
      </View>

      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: TAB_BAR + insets.bottom + sosH + 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', padding: 14, gap: 12 }}>
          {SERVICE_TILES.map((s) => (
            <Pressable
              key={s.key}
              accessibilityRole="button"
              accessibilityLabel={`${t(s.title)}. ${t(s.sub)}`}
              onPress={() => (s.route ? router.push(s.route) : openService(s.key))}
              style={({ pressed }) => ({ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, backgroundColor: pressed ? '#F5F8FC' : '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#D6E2F2' })}
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
            </Pressable>
          ))}
        </View>
      </ScrollView>

      <SosBar bottom={TAB_BAR + insets.bottom} onLayout={(e) => setSosH(e.nativeEvent.layout.height)} />
      <BottomNav />
    </Screen>
  );
}
