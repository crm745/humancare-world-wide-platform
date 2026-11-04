import { Image, Pressable, View } from 'react-native';
import { Bell } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { LOGO } from '../../data/images';

// White bar: the notifications bell on the left (red dot when something is unread) and the
// logo on the right. Left-to-right in every language so the sides never swap.
export function HomeHeader({ hasUnread, onBell }) {
  const { t } = useApp();
  return (
    <View style={{ direction: 'ltr', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E4E9F2' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hasUnread ? `${t('home_notifications')}, unread` : t('home_notifications')}
        onPress={onBell}
        style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#EEF3FB', alignItems: 'center', justifyContent: 'center' }}
      >
        <Bell size={18} color="#45526B" strokeWidth={2} />
        {hasUnread && <View style={{ position: 'absolute', top: 10, right: 11, width: 7, height: 7, borderRadius: 4, backgroundColor: '#D64545' }} />}
      </Pressable>
      <Image source={LOGO} accessible={false} style={{ height: 34, width: 34 * (2440 / 1405) }} resizeMode="contain" />
    </View>
  );
}
