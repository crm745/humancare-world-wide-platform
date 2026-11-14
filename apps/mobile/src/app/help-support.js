import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ChevronDown, Mail, Phone } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { EMERGENCY_TEL, FAQS, OPS_EMAIL, REGIONAL_NUMBERS } from '../data/mock';
import { Body, Screen, TopBar } from '../components/layout';
import { Card, InfoRow, Text } from '../components/ui';
import { COLORS } from '../theme/colors';

function ContactTile({ Icon, bg, color, label, onPress }) {
  return (
    <Pressable onPress={onPress} className="w-[48.5%] items-center rounded-[14px] border border-line bg-white px-1.5 py-4 active:opacity-80">
      <View className={`mb-2 h-9 w-9 items-center justify-center rounded-full ${bg}`}><Icon size={16} color={color} /></View>
      <Text className="font-inter-bold text-[13px]">{label}</Text>
    </Pressable>
  );
}

function Faq({ q, a, last }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={`overflow-hidden p-0 ${last ? 'mb-4' : 'mb-3'}`}>
      <Pressable onPress={() => setOpen(!open)} className="flex-row items-center justify-between gap-2 px-3.5 py-[15px]">
        <Text className="flex-1 font-inter-bold text-[13.5px]">{q}</Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><ChevronDown size={16} color="#97A4B8" /></View>
      </Pressable>
      {open && <Text className="px-3.5 pb-[15px] text-[13px] leading-[21px] text-muted">{a}</Text>}
    </Card>
  );
}

function Heading({ children }) {
  return <Text className="mb-3 font-inter-black text-[12.5px] uppercase text-muted">{children}</Text>;
}

export default function HelpSupport() {
  const { t } = useApp();
  return (
    <Screen>
      <TopBar title={t('help_support')} />
      <Body contentClassName="px-[18px] py-4">
        <View className="mb-[26px] flex-row justify-between">
          <ContactTile Icon={Phone} bg="bg-cancel-soft" color="#D64545" label={t('btn_call_alarm_desk')} onPress={() => Linking.openURL(`tel:${EMERGENCY_TEL}`)} />
          <ContactTile Icon={Mail} bg="bg-primary-soft" color={COLORS.primary} label={t('btn_email_ops')} onPress={() => Linking.openURL(`mailto:${OPS_EMAIL}`)} />
        </View>

        <Heading>{t('lbl_regional_numbers')}</Heading>
        <Card className="mb-[26px] px-3.5 py-1.5">
          {REGIONAL_NUMBERS.map((n, i) => (
            <InfoRow
              key={n.tel}
              last={i === REGIONAL_NUMBERS.length - 1}
              onPress={() => Linking.openURL(`tel:${n.tel}`)}
              label={t(n.label)}
              labelClassName="font-inter-bold text-[13.5px] text-ink"
              valueNode={<Text className="font-inter-bold text-[13.5px] text-primary">{n.display}</Text>}
            />
          ))}
        </Card>

        <Heading>{t('lbl_faq')}</Heading>
        {FAQS.map((f, i) => <Faq key={f.q} q={t(f.q)} a={f.a} last={i === FAQS.length - 1} />)}
      </Body>
    </Screen>
  );
}
