import { useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { HOME_SERVICES } from '../data/mock';
import { BottomNav, Screen, TopBar, useScrollToTopOnTabTap } from '../components/layout';
import { Text } from '../components/ui';
import { openService } from '../components/ServiceGrid';
import { ServiceIcon } from '../components/home/ServiceIcon';
import { useFabScrollPad } from '../components/sos/hooks';
import { PressBox } from '../components/PressBox';

const TAB_BAR = 64;
const MAX_WIDTH = 720;
const NAVY = '#0D2340';

// Every service as its own full-width card with its subtitle, in one scrolling column. The same eight services, in
// the same order and with the same destinations as the tiles on Home (HOME_SERVICES in data/mock.js): Air Ambulance is
// one card that opens the choice between its two services, and a placeholder is drawn as a card that does nothing.
export default function AllServices() {
  const { t, isRTL } = useApp();
  const insets = useSafeAreaInsets();
  // The scroll area ends above the tab bar; its bottom padding is its own (16) or the room the floating SOS button needs, whichever is more.
  const { paddingBottom, scrollProps } = useFabScrollPad({ ownPad: 16, edge: TAB_BAR + insets.bottom });
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  return (
    <Screen>
      <TopBar title={t('filter_svc_all')} />

      <ScrollView ref={scrollRef} style={{ flex: 1, marginBottom: TAB_BAR + insets.bottom }} contentContainerStyle={{ paddingBottom }} {...scrollProps} showsVerticalScrollIndicator={false}>
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', padding: 14, gap: 12 }}>
          {HOME_SERVICES.map((s) => {
            const card = (pressed) => ({ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 14, backgroundColor: pressed ? '#F5F8FC' : '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#D6E2F2' });
            const label = s.sub ? `${t(s.title)}. ${t(s.sub)}` : t(s.title);
            const body = (
              <>
                <View style={{ width: 54, height: 54, borderRadius: 14, backgroundColor: '#EDF2F9', alignItems: 'center', justifyContent: 'center' }}>
                  <ServiceIcon serviceKey={s.key} size={25} color={NAVY} fill={NAVY} fillOpacity={0.12} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text className="font-inter-semibold" style={{ fontSize: 14.5, lineHeight: 20, color: NAVY }}>{t(s.title)}</Text>
                  {s.sub ? <Text style={{ marginTop: 3, fontSize: 12.5, lineHeight: 17, color: '#5B6B84' }}>{t(s.sub)}</Text> : null}
                </View>
                {s.placeholder ? null : (
                  <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
                    <ChevronRight size={18} color="#8A9BB5" strokeWidth={2.2} />
                  </View>
                )}
              </>
            );
            if (s.placeholder) return <View key={s.key} accessible accessibilityLabel={label} style={card(false)}>{body}</View>;
            return (
              <PressBox
                key={s.key}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => (s.route ? router.push(s.route) : openService(s.key))}
                style={({ pressed }) => card(pressed)}
              >
                {body}
              </PressBox>
            );
          })}
        </View>
      </ScrollView>

      <BottomNav />
    </Screen>
  );
}
