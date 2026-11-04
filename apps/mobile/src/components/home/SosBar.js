import { useState } from 'react';
import { Linking, Modal, Pressable, View } from 'react-native';
import { Bell, ChevronRight, Phone } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { EMERGENCY_DISPLAY, EMERGENCY_TEL } from '../../data/mock';
import { Button, Text } from '../ui';

// The app's existing SOS action, unchanged: ask first, then dial the 24/7 line.
function SosModal({ visible, onClose }) {
  const call = () => { onClose(); Linking.openURL(`tel:${EMERGENCY_TEL}`); };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-navy/50 p-[26px]">
        <Pressable className="w-full items-center rounded-[20px] bg-white p-6">
          <View className="mb-4 h-14 w-14 items-center justify-center rounded-full bg-danger-soft"><Bell size={26} color="#D64545" strokeWidth={2.2} /></View>
          <Text className="mb-2 font-inter-black text-[16.5px] text-navy">Call Emergency Assistance?</Text>
          <Text className="mb-[22px] text-center text-[13.5px] leading-5 text-muted">
            This will immediately call our 24/7 emergency line at <Text className="font-inter-bold text-navy">{EMERGENCY_DISPLAY}</Text>.
          </Text>
          <View className="w-full flex-row gap-2.5">
            <Button variant="outline" title="Cancel" onPress={onClose} className="flex-1" />
            <Button variant="sos" title="Call Now" onPress={call} className="flex-1" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Pinned above the tab bar by the screen that uses it. It needs no data, so it keeps
// working when everything else on the screen fails to load.
export function SosBar({ bottom, onLayout }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <View
        onLayout={onLayout}
        style={{ position: 'absolute', left: 0, right: 0, bottom, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E4E9F2', paddingHorizontal: 12, paddingVertical: 8 }}
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
