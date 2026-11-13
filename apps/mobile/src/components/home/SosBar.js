import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight, Phone } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { Text } from '../ui';
import { SosModal } from '../sos/SosModal';

// The "Call Emergency Assistance?" confirmation (SosModal) is shared with the floating SOS button, so both start the same flow.
// Pinned above the tab bar by the screen that uses it. It needs no data, so it keeps
// working when everything else on the screen fails to load.
export function SosBar({ bottom, onLayout }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <View
        onLayout={onLayout}
        style={{ position: 'absolute', left: 0, right: 0, bottom, paddingHorizontal: 12, paddingVertical: 8 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('home_sos_a11y')}
          onPress={() => setOpen(true)}
          style={{ width: '100%', maxWidth: 720, alignSelf: 'center', minHeight: 56, borderRadius: 16, backgroundColor: '#C53030', paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        >
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
            <Phone size={19} color="#C53030" strokeWidth={2.3} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text className="font-inter-black" style={{ fontSize: 14, color: '#FFFFFF' }}>{t('sos_title')}</Text>
            <Text style={{ fontSize: 12, lineHeight: 16, color: '#FFE9E9', marginTop: 1 }}>{t('sos_sub')}</Text>
          </View>
          <ChevronRight size={20} color="#FFFFFF" strokeWidth={2.2} />
        </Pressable>
      </View>
      <SosModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
