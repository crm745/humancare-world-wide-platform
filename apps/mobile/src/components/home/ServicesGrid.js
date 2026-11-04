import { Pressable, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';
import { ServiceIconTile } from './ServiceIcon';

// "Our Services" title, the "View all services" link, and the first tiles.
// `services` are entries of the app's own SERVICE_TILES; `columns` is 3 on phones, 4 on
// wide screens. Rows are laid out one at a time so every tile in a row is equally tall.
export function ServicesGrid({ services, columns, onPressService, onViewAll }) {
  const { t } = useApp();
  const rows = [];
  for (let i = 0; i < services.length; i += columns) rows.push(services.slice(i, i + columns));
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <Text className="font-inter-black" accessibilityRole="header" style={{ fontSize: 15.5, color: '#0D2340' }}>{t('ourServices')}</Text>
        <Pressable accessibilityRole="button" onPress={onViewAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 0 }} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
          <Text className="font-inter-black" style={{ fontSize: 12.5, color: '#1A5FC4' }}>{t('home_view_all')}</Text>
          <ChevronRight size={14} color="#1A5FC4" strokeWidth={2.6} />
        </Pressable>
      </View>
      <View style={{ gap: 10 }}>
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', gap: 10 }}>
            {row.map((s) => (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                accessibilityLabel={t(s.title)}
                onPress={() => onPressService(s)}
                style={{ flex: 1, minWidth: 0, minHeight: 98, backgroundColor: '#FFFFFF', borderRadius: 16, paddingHorizontal: 5, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: '#0D2340', shadowOpacity: 0.06, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 }}
              >
                <ServiceIconTile serviceKey={s.key} />
                <Text className="font-inter-bold" style={{ fontSize: 12, lineHeight: 16, color: '#17233D', textAlign: 'center' }}>{t(s.title)}</Text>
              </Pressable>
            ))}
            {row.length < columns && Array.from({ length: columns - row.length }, (_, k) => <View key={`pad${k}`} style={{ flex: 1, minWidth: 0 }} />)}
          </View>
        ))}
      </View>
    </View>
  );
}
