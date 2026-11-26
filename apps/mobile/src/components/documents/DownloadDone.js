import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CircleCheck, X } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { COLORS } from '../../theme/colors';
import { Text } from '../ui';

// The in-app "Download complete" message of Documents & Reports: the file name, "Download complete" and an OPEN button, with a way to dismiss it. It is shown where a notification is not (iOS, Android with
// notifications refused, or a copy kept inside the app). `done`: { name, onOpen } or null. It sits above the bottom edge and the floating call button's corner is left to the screen's own padding.
export function DownloadDone({ done, onDismiss }) {
  const { t } = useApp();
  const insets = useSafeAreaInsets();
  if (!done) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute', left: 16, right: 16, bottom: 16 + insets.bottom, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingLeft: 14, paddingRight: 6,
        borderRadius: 14, backgroundColor: '#0D2340', shadowColor: '#0D2340', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
      }}
    >
      <CircleCheck size={20} color="#7DD3A8" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} ellipsizeMode="middle" style={{ fontFamily: 'Inter_700Bold', fontSize: 13.5, lineHeight: 18, color: '#FFFFFF' }}>{done.name}</Text>
        <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 16, color: '#C9D3E1' }}>{t('docs_dl_complete')}</Text>
      </View>
      <Pressable
        testID="download-open" accessibilityRole="button" accessibilityLabel={`${t('docs_open')} ${done.name}`} onPress={done.onOpen} hitSlop={{ top: 6, bottom: 6 }}
        style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#FFFFFF' }}
      >
        <Text style={{ fontFamily: 'Inter_800ExtraBold', fontSize: 13, color: COLORS.primary }}>{String(t('docs_open')).toUpperCase()}</Text>
      </Pressable>
      <Pressable testID="download-dismiss" accessibilityRole="button" accessibilityLabel={t('docs_dismiss')} onPress={onDismiss} hitSlop={8} style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
        <X size={18} color="#C9D3E1" />
      </Pressable>
    </View>
  );
}
