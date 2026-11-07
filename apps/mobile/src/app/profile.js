import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Check, ChevronRight, Mail, Pencil, Smartphone } from 'lucide-react-native';
import { initialsOf, useApp } from '../state/AppContext';
import { LANGUAGES } from '../data/mock';
import { navReplace } from '../lib/nav';
import { apiGet } from '../lib/api';
import { clearTokens } from '../lib/session';
import { Body, BottomNav, IconButton, Screen, TopBar } from '../components/layout';
import { Button, Card, InfoRow, Text } from '../components/ui';
import { Sheet } from '../components/widgets';
import { Spinner } from '../components/Spinner';

// `value` null = still loading: a small spinner instead of a misleading "0".
function Stat({ value, label, color, onPress, middle }) {
  return (
    <Pressable onPress={onPress} className={`flex-1 items-center ${middle ? 'border-x border-line' : ''}`}>
      {value === null ? (
        <View className="h-[30px] justify-center"><Spinner size={20} color="#1A73E8" trackColor="#E7F0FE" /></View>
      ) : (
        <Text className={`font-inter-black text-[22px] ${color}`}>{value}</Text>
      )}
      <Text className="mt-1 text-[11px] text-faint">{label}</Text>
    </Pressable>
  );
}

function Chevron() {
  const { isRTL } = useApp();
  return <View style={isRTL ? { transform: [{ scaleX: -1 }] } : null}><ChevronRight size={16} color="#97A4B8" /></View>;
}

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
              {on && <Check size={18} color="#1A73E8" strokeWidth={2.5} />}
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

export default function Profile() {
  const { t, isCorporate, profile, lang, toast } = useApp();
  const [langSheet, setLangSheet] = useState(false);
  const [counts, setCounts] = useState(null); // null until loaded

  useEffect(() => {
    const path = isCorporate ? '/corporate/cases' : '/requests/me';
    const key = isCorporate ? 'cases' : 'requests';
    apiGet(path)
      .then((data) => {
        const rows = data[key];
        const active = rows.filter((r) => r.status === 'submitted' || r.status === 'scheduled' || r.status === 'in_progress').length;
        const done = rows.filter((r) => r.status === 'completed').length;
        setCounts({ total: rows.length, active, done });
      })
      .catch((err) => {
        toast(err.message);
        setCounts({ total: '–', active: '–', done: '–' }); // stop the spinners; the toast says why
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  }, [isCorporate]);

  const shown = (n) => (counts ? String(n) : null);
  const stats = isCorporate
    ? { total: shown(counts?.total), active: shown(counts?.active), done: shown(counts?.done), totalLbl: t('lbl_total'), doneLbl: t('lbl_done') }
    : { total: shown(counts?.total), active: shown(counts?.active), done: shown(counts?.done), totalLbl: t('lbl_total_requests'), doneLbl: t('status_completed') };
  const openStat = (status) => (isCorporate ? navReplace('/corporate-dashboard') : navReplace(`/my-requests?status=${status}`));
  const langLabel = LANGUAGES.find((l) => l.code === lang).label;
  // Signed-out people already have an account, so they land on their login screen.
  const signOut = async () => { await clearTokens(); navReplace(isCorporate ? '/corporate-login' : '/welcome'); };

  return (
    <Screen>
      <TopBar title={t('profile_title')} />
      <Body withNav contentClassName="px-[18px] pb-10 pt-[22px]">
        <Card className="mb-5 flex-row items-center gap-3.5 p-[18px]">
          <View className="h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft">
            <Text className="font-inter-black text-[18.5px] text-primary">{initialsOf(profile.name)}</Text>
          </View>
          <View className="min-w-0 flex-1">
            <Text className="font-inter-black text-[16.5px]">{profile.name}</Text>
            {isCorporate ? (
              <Text className="mt-[5px] text-[12px] text-primary">{profile.email}</Text>
            ) : (
              <>
                <View className="mt-[7px] flex-row items-center gap-[5px]">
                  <Smartphone size={12} color="#97A4B8" />
                  <Text className="font-inter-bold text-[11px] uppercase text-faint">{t('lbl_mobile')}</Text>
                  <Text className="text-[12.5px] text-muted">{profile.cc} {profile.phone}</Text>
                </View>
                <View className="mt-1.5 flex-row items-center gap-[5px]">
                  <Mail size={12} color="#97A4B8" />
                  <Text className="font-inter-bold text-[11px] uppercase text-faint">{t('lbl_email')}</Text>
                  <Text className="flex-1 text-[12px] text-muted" numberOfLines={1}>{profile.email}</Text>
                </View>
              </>
            )}
          </View>
          {!isCorporate && <IconButton onPress={() => router.push('/edit-profile')}><Pencil size={15} color="#45526B" /></IconButton>}
        </Card>

        <Card className="mb-5 px-[18px] py-5">
          <Text className="mb-4 font-inter-black text-[12px] uppercase tracking-wide text-faint">{t('lbl_overview')}</Text>
          <View className="flex-row">
            <Stat value={stats.total} label={stats.totalLbl} color="text-navy" onPress={() => openStat('all')} />
            <Stat middle value={stats.active} label={t('lbl_active')} color="text-primary" onPress={() => openStat('active')} />
            <Stat value={stats.done} label={stats.doneLbl} color="text-success" onPress={() => openStat('completed')} />
          </View>
        </Card>

        <Card className="mb-5 px-[18px] py-1.5">
          <InfoRow className="py-[15px]" label={t('my_documents')} valueNode={<Chevron />} onPress={() => router.push('/my-documents')} />
          <InfoRow className="py-[15px]" label={t('emergency_contact')} valueNode={<Chevron />} onPress={() => router.push('/help-support')} />
          <InfoRow className="py-[15px]" label={t('help_support')} valueNode={<Chevron />} onPress={() => router.push('/help-support')} />
          <InfoRow className="py-[15px]" last label={t('language')} value={`${langLabel} >`} valueClassName="text-primary" onPress={() => setLangSheet(true)} />
        </Card>

        <Button variant="danger" title={t('sign_out')} onPress={signOut} className="py-[15px]" />
      </Body>
      <BottomNav />
      <LanguageSheet visible={langSheet} onClose={() => setLangSheet(false)} />
    </Screen>
  );
}
