import { Linking, Modal, Pressable, View } from 'react-native';
import { Bell } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { EMERGENCY_DISPLAY, EMERGENCY_TEL } from '../../data/mock';
import { emergencyUrl } from '../../lib/sos';
import { Button, Text } from '../ui';

// The app's one SOS confirmation, unchanged: ask first, then dial the 24/7 line. The red banner on Home and the floating
// SOS button both open it, so both start exactly the same emergency flow.
export function SosModal({ visible, onClose }) {
  const { t } = useApp();
  const call = () => { onClose(); Linking.openURL(emergencyUrl(EMERGENCY_TEL)); };
  // The number is set in bold inside the sentence, wherever the language puts it.
  const [before, after] = t('sos_modal_body', { number: EMERGENCY_DISPLAY }).split(EMERGENCY_DISPLAY);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-navy/50 p-[26px]">
        <Pressable className="w-full items-center rounded-[20px] bg-white p-6">
          <View className="mb-4 h-14 w-14 items-center justify-center rounded-full bg-danger-soft"><Bell size={26} color="#D64545" strokeWidth={2.2} /></View>
          <Text className="mb-2 font-inter-black text-[16.5px] text-navy">{t('sos_modal_title')}</Text>
          <Text className="mb-[22px] text-center text-[13.5px] leading-5 text-muted">
            {before}<Text className="font-inter-bold text-navy">{EMERGENCY_DISPLAY}</Text>{after}
          </Text>
          <View className="w-full flex-row gap-2.5">
            <Button variant="outline" title={t('sos_modal_cancel')} onPress={onClose} className="flex-1" />
            <Button variant="sos" title={t('sos_modal_call')} onPress={call} className="flex-1" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
