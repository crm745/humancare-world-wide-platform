import { useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BookOpen, Bell, Check, ChevronRight, CircleHelp, CreditCard, FileText, Globe, LogOut, ShieldCheck, User } from 'lucide-react-native';
import { initialsOf, useApp } from '../state/AppContext';
import { LANGUAGES } from '../data/mock';
import { navReplace } from '../lib/nav';
import { clearTokens } from '../lib/session';
import { BottomNav, Screen, TopBar, useScrollToTopOnTabTap } from '../components/layout';
import { useFabScrollPad } from '../components/sos/hooks';
import { SectionLabel, Text } from '../components/ui';
import { Sheet } from '../components/widgets';
import { COLORS } from '../theme/colors';
import { PressBox } from '../components/PressBox';

const TAB_BAR = 64;
const MAX_WIDTH = 720;

function LanguageSheet({ visible, onClose }) {
  const { t, lang, setLang, toast } = useApp();
  const choose = (l) => {
    setLang(l.code);
    toast('Language set to ' + l.name);
    setTimeout(onClose, 350);
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={t('choose_language')}>
      <View className="mb-1.5 gap-2">
        {LANGUAGES.map((l) => {
          const on = l.code === lang;
          return (
            <Pressable key={l.code} onPress={() => choose(l)} className={`flex-row items-center justify-between rounded-xl border-[1.5px] px-3.5 py-[13px] ${on ? 'border-primary bg-primary-soft' : 'border-line bg-white'}`}>
              <Text className="font-inter-bold text-[14px] text-navy">{l.name}</Text>
              {on && <Check size={18} color={COLORS.primary} strokeWidth={2.5} />}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

// One tappable row: icon tile, label, chevron, and nothing else.
function Row({ Icon, label, onPress, first }) {
  const { isRTL } = useApp();
  return (
    <PressBox
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64, paddingVertical: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
        borderTopWidth: first ? 0 : 1, borderTopColor: '#EEF1F6', backgroundColor: pressed ? '#F7F9FC' : '#FFFFFF',
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF3FB' }}>
        <Icon size={20} strokeWidth={1.8} color={COLORS.primary} />
      </View>
      <Text className="font-inter-semibold" style={{ flex: 1, fontSize: 15.5, lineHeight: 21, color: '#17233D' }}>{label}</Text>
      <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}>
        <ChevronRight size={18} strokeWidth={2} color="#8A97AB" />
      </View>
    </PressBox>
  );
}

function Section({ label, rows }) {
  return (
    <View>
      <SectionLabel>{label}</SectionLabel>
      <View style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: 16, overflow: 'hidden' }}>
        {rows.map((row, i) => <Row key={row.label} first={i === 0} {...row} />)}
      </View>
    </View>
  );
}

export default function Profile() {
  const { t, isCorporate, profile, toast } = useApp();
  const insets = useSafeAreaInsets();
  // The scroll area ends above the tab bar; its bottom padding is its own (24) or the room the floating SOS button needs, whichever is more.
  const { paddingBottom, scrollProps } = useFabScrollPad({ ownPad: 24, edge: TAB_BAR + insets.bottom });
  const [langSheet, setLangSheet] = useState(false);
  const scrollRef = useRef(null);
  useScrollToTopOnTabTap(scrollRef);

  // Signed-out people already have an account, so they land on their login screen.
  // The destination is shown first, then the tokens are cleared: clearing them while this screen is still open
  // would let the auth gate send the person to Login before Getting Started opens.
  const signOut = async () => { navReplace(isCorporate ? '/corporate-login' : '/welcome'); await clearTokens(); };
  const soon = () => toast(t('prof_soon'));

  const account = [
    // Personal details opens the patient's own account; a corporate account has no such screen yet.
    { Icon: User, label: t('prof_personal'), onPress: isCorporate ? soon : () => router.push('/personal-details') },
    { Icon: FileText, label: t('prof_documents'), onPress: () => router.push('/my-documents') },
    { Icon: CreditCard, label: t('prof_payment'), onPress: soon },
  ];
  const preferences = [
    { Icon: Globe, label: t('prof_language'), onPress: () => setLangSheet(true) },
    { Icon: Bell, label: t('prof_notifications'), onPress: () => router.push('/notifications') },
    { Icon: ShieldCheck, label: t('prof_privacy'), onPress: () => router.push('/privacy') },
  ];
  const support = [
    { Icon: CircleHelp, label: t('prof_help'), onPress: () => router.push('/help-support') },
    { Icon: BookOpen, label: t('prof_terms'), onPress: () => router.push('/terms') },
  ];

  const email = profile.email || '';
  const place = [profile.city, profile.country].filter(Boolean).join(', ');
  const version = Constants.expoConfig?.version || '1.0.0';

  return (
    <Screen>
      <TopBar title={t('prof_title')} />
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, marginBottom: TAB_BAR + insets.bottom }}
        contentContainerStyle={{ paddingBottom }}
        {...scrollProps}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 16, gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 68, height: 68, borderRadius: 20, backgroundColor: COLORS.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text className="font-inter-black" style={{ fontSize: 24, color: COLORS.primary }}>{initialsOf(profile.name || '')}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text className="font-inter-black" style={{ fontSize: 21, lineHeight: 26, color: '#0D2340' }}>{profile.name}</Text>
              <Text style={{ marginTop: 4, fontSize: 13.5, lineHeight: 19, color: '#5B6B84' }}>{place ? `${email} · ${place}` : email}</Text>
            </View>
          </View>

          <Section label={t('prof_account')} rows={account} />
          <Section label={t('prof_preferences')} rows={preferences} />
          <Section label={t('prof_support')} rows={support} />

          <PressBox
            accessibilityRole="button"
            accessibilityLabel={t('prof_logout')}
            onPress={signOut}
            style={({ pressed }) => ({
              minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              backgroundColor: pressed ? '#F7F9FC' : '#FFFFFF', borderWidth: 1, borderColor: '#E4E9F2', borderRadius: 18,
            })}
          >
            <LogOut size={20} strokeWidth={1.9} color="#C53030" />
            <Text className="font-inter-bold" style={{ fontSize: 15.5, color: '#C53030' }}>{t('prof_logout')}</Text>
          </PressBox>

          <Text style={{ fontSize: 12, lineHeight: 16, color: '#5B6B84', textAlign: 'center' }}>{t('prof_footer').replace('{v}', version)}</Text>
        </View>
      </ScrollView>
      <BottomNav />
      <LanguageSheet visible={langSheet} onClose={() => setLangSheet(false)} />
    </Screen>
  );
}
