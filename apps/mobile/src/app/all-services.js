import { useRef, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { SERVICE_TILES } from '../data/mock';
import { BottomNav, Screen, TopBar, useScrollToTopOnTabTap } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ServiceIconTile } from '../components/home/ServiceIcon';
import { SosBar } from '../components/home/SosBar';

const TAB_BAR = 64;
const MAX_WIDTH = 720;

// Every service, two to a row, each with its subtitle. Same list and same destinations
// as the tiles on Home.
export default function AllServices() {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [sosH, setSosH] = useState(72);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);
  const rows = [];
  for (let i = 0; i < SERVICE_TILES.length; i += 2) rows.push(SERVICE_TILES.slice(i, i + 2));

  return (
    <Screen bg="" style={{ backgroundColor: '#F5F8FC' }}>
      <TopBar title={t('filter_svc_all')} />

      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: TAB_BAR + insets.bottom + sosH + 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', padding: 14, gap: 10 }}>
          {rows.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map((s) => (
                <Pressable
                  key={s.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${t(s.title)}. ${t(s.sub)}`}
                  onPress={() => (s.route ? router.push(s.route) : openService(s.key))}
                  style={{ flex: 1, minHeight: width < 360 ? 120 : 108, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', gap: 6, shadowColor: '#0D2340', shadowOpacity: 0.06, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 }}
                >
                  <ServiceIconTile serviceKey={s.key} />
                  <Text className="font-inter-bold" style={{ fontSize: 13, lineHeight: 16, color: '#17233D', textAlign: 'center' }}>{t(s.title)}</Text>
                  <Text style={{ fontSize: 12, lineHeight: 15, color: '#5B6B84', textAlign: 'center' }}>{t(s.sub)}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      <SosBar bottom={TAB_BAR + insets.bottom} onLayout={(e) => setSosH(e.nativeEvent.layout.height)} />
      <BottomNav />
    </Screen>
  );
}
