import { Pressable, View, useWindowDimensions } from 'react-native';
import { LayoutGrid } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';
import { ServiceIcon } from './ServiceIcon';
import { gridFor } from '../../lib/homeLayout';

const NAVY = '#0D2340';

// "Our Services" title, the eight services of HOME_SERVICES (data/mock.js) and a "More" tile as the ninth, which opens
// All Services (there is no "View all services" link any more), in ALWAYS four columns, on every screen width: a narrow screen gets less padding and a smaller gap around the
// tiles (see lib/homeLayout.js), and a long name wraps onto more lines. A tile marked `placeholder` is only drawn: it
// has no press, no button role and no pressed state, so it neither looks nor acts like something that is broken.
// Rows are laid out one at a time so every tile in a row is equally tall.
export function ServicesGrid({ services, onPressService, onViewAll }) {
  const { t } = useApp();
  const { width } = useWindowDimensions();
  const { columns, gap, bleed, labelSize, lineHeight } = gridFor(width);
  // The ninth cell is "More": it opens All Services.
  const items = [...services, { key: '__more', more: true }];
  const rows = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <Text className="font-inter-black" accessibilityRole="header" style={{ fontSize: 15.5, color: '#0D2340' }}>{t('ourServices')}</Text>
      </View>
      <View style={{ gap: 12, marginHorizontal: -bleed }}>
        {rows.map((row, r) => (
          <View key={r} style={{ flexDirection: 'row', gap }}>
            {row.map((s) => {
              const content = (
                <>
                  <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', alignItems: 'center', justifyContent: 'center' }}>
                    {s.more
                      ? <LayoutGrid size={22} color={NAVY} strokeWidth={1.8} />
                      : <ServiceIcon serviceKey={s.key} size={24} color={NAVY} fill={NAVY} fillOpacity={0.12} />}
                  </View>
                  <Text className="font-inter-medium" numberOfLines={3} style={{ fontSize: labelSize, lineHeight, color: NAVY, textAlign: 'center' }}>
                    {s.more ? t('home_more') : t(s.title)}
                  </Text>
                </>
              );
              const cell = { flex: 1, minWidth: 0, alignItems: 'center', gap: 6 };
              if (s.placeholder) return <View key={s.key} accessible accessibilityLabel={t(s.title)} style={cell}>{content}</View>;
              return (
                <Pressable key={s.key} accessibilityRole="button" accessibilityLabel={s.more ? t('home_more') : t(s.title)} onPress={() => (s.more ? onViewAll() : onPressService(s))} style={cell}>
                  {content}
                </Pressable>
              );
            })}
            {row.length < columns && Array.from({ length: columns - row.length }, (_, k) => <View key={`pad${k}`} style={{ flex: 1, minWidth: 0 }} />)}
          </View>
        ))}
      </View>
    </View>
  );
}
