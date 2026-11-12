import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { initialsOf, useApp } from '../state/AppContext';
import { goBack } from '../lib/nav';
import { apiPatch } from '../lib/api';
import { isValidName } from '../lib/validators';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Field, FieldLabel, Spacer, Text } from '../components/ui';

// Name saves here. Mobile and email are where login codes and password resets go, so
// each has its own Change flow (the new value + a code sent to it), the same for every account.
export default function EditProfile() {
  const { t, toast, profile, setProfile } = useApp();
  // Only what the person has typed is kept; until then the field shows the profile's
  // name, so it still fills in if the screen opened before the profile had loaded
  // (e.g. a refresh on web).
  const [typedName, setTypedName] = useState(null);
  const name = typedName ?? profile.name;
  const [busy, setBusy] = useState(false);
  const ready = isValidName(name) && name.trim() !== profile.name;

  const save = async () => {
    if (!isValidName(name)) { toast('Enter a valid name.'); return; }
    setBusy(true);
    try {
      await apiPatch('/auth/me', { name: name.trim() });
      setProfile({ ...profile, name: name.trim() });
      toast('Profile updated');
      goBack();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const contactRow = (label, value, kind) => (
    <View>
      <FieldLabel large>{label}</FieldLabel>
      <View className="flex-row items-center justify-between gap-3 rounded-xl border-[1.5px] border-field bg-input px-3.5 py-3.5">
        <Text numberOfLines={1} style={{ minWidth: 0 }} className="flex-1 text-[15px] text-ink">{value || '—'}</Text>
        <Text className="font-inter-bold text-[14px] text-primary" onPress={() => router.push({ pathname: '/change-contact', params: { kind } })}>
          {t('cta_change')}
        </Text>
      </View>
    </View>
  );

  return (
    <Screen bg="bg-white">
      <TopBar title={t('edit_profile_title')} />
      <Body contentClassName="px-[18px] pb-[26px] pt-5">
        <Text className="mb-[26px] text-center text-[14.5px] text-muted">{t('edit_profile_sub')}</Text>
        <View className="mb-[26px] items-center">
          <View className="h-16 w-16 items-center justify-center rounded-[18px] bg-primary-soft">
            <Text className="font-inter-black text-[21px] text-primary">{initialsOf(name)}</Text>
          </View>
        </View>
        <View className="gap-[18px]">
          <Field
            large required label={t('field_full_name')} value={name} onChangeText={setTypedName}
            error={name && !isValidName(name) ? 'Enter a valid name.' : undefined}
          />
          {contactRow(t('field_mobile_number'), profile.phone ? `${profile.cc} ${profile.phone}` : '', 'mobile')}
          {contactRow(t('field_email_address'), profile.email, 'email')}
        </View>
        <Spacer />
        <Button large title={t('btn_save_changes')} disabled={!ready} loading={busy} onPress={save} />
      </Body>
    </Screen>
  );
}
