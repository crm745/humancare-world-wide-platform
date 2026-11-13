import { Pressable, View } from 'react-native';
import { ChevronRight, LayoutGrid } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';
import { ServiceIcon } from './ServiceIcon';

const NAVY = '#0D2340';
const COLUMNS = 4;
const MAX_SERVICES = 7;

// "Our Services" title, the "View all services" link, and the first seven services plus a
// "More" tile (the eighth cell) that opens All Services. `services` are entries of the app's own SERVICE_TILES.
// Always four columns; the `columns` prop that Home still passes is no longer used.
// Rows are laid out one at a time so every tile in a row is equally tall.
export function ServicesGrid({ services, onPressService, onViewAll }) {
  const { t } = useApp();
  const items = [...services.slice(0, MAX_SERVICES), { key: '__more', more: true }];
  const rows = [];
  for (let i = 0; i < items.length; i += COLUMNS) rows.push(items.slice(i, i + COLUMNS));
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <Text className="font-inter-black" accessibilityRole="header" style={{ fontSize: 15.5, color: '#0D2340' }}>{t('ourServices')}</Text>
        <Pressable accessibilityRole="button" onPress={onViewAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 0 }} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text className="font-inter-black" style={{ fontSize: 12.5, color: '#1A5FC4' }}>{t('home_view_all')}</Text>
          <ChevronRight size={14} color="#1A5FC4" strokeWidth={2.6} />
        </Pressable>
      </View>
      <View style={{ gap: 12 }}>
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', gap: 8 }}>
            {row.map((s) => (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                accessibilityLabel={s.more ? t('home_more') : t(s.title)}
                onPress={() => (s.more ? onViewAll() : onPressService(s))}
                style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 6 }}
              >
                <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', alignItems: 'center', justifyContent: 'center' }}>
                  {s.more
                    ? <LayoutGrid size={22} color={NAVY} strokeWidth={1.8} />
                    : <ServiceIcon serviceKey={s.key} size={24} color={NAVY} fill={NAVY} fillOpacity={0.12} />}
                </View>
                <Text className="font-inter-medium" numberOfLines={3} style={{ fontSize: 10.5, lineHeight: 14, color: NAVY, textAlign: 'center' }}>
                  {s.more ? t('home_more') : t(s.title)}
                </Text>
              </Pressable>
            ))}
            {row.length < COLUMNS && Array.from({ length: COLUMNS - row.length }, (_, k) => <View key={`pad${k}`} style={{ flex: 1, minWidth: 0 }} />)}
          </View>
        ))}
      </View>
    </View>
  );
}
