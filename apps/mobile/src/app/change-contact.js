import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useApp } from '../state/AppContext';
import { COUNTRY_CODES, COUNTRY_CODE_LABELS } from '../data/mock';
import { apiPost } from '../lib/api';
import { codeStepFrom, setAuthStep } from '../lib/authFlow';
import { isValidEmail, isValidMobileNumber } from '../lib/validators';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Field, FieldLabel, Input, Spacer, Text } from '../components/ui';
import { Select } from '../components/widgets';

// Change mobile or email, step 1 (`kind` = "mobile" | "email"): the new value only. The backend sends a code to
// that NEW value (change-contact-otp.js) and changes nothing until the code is entered. No password and no code to
// the old contact: the same for password, Google and Apple accounts.
export default function ChangeContact() {
  const { t, toast, profile } = useApp();
  const { kind } = useLocalSearchParams();
  const isMobile = kind === 'mobile';
  const [cc, setCc] = useState(profile.cc || '+91');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const ready = isMobile ? isValidMobileNumber(phone, cc) : isValidEmail(email);

  const submit = async () => {
    if (!ready || busy) return; // a second tap while the first request runs does nothing
    setFormError(null);
    setBusy(true);
    try {
      const body = isMobile
        ? { kind, mobile: phone.trim(), countryCode: cc }
        : { kind, email: email.trim() };
      const data = await apiPost('/auth/me/contact', body);
      toast(t('change_otp_sent'));
      setAuthStep('change-contact-otp', codeStepFrom(data, { kind }));
      router.push('/change-contact-otp');
    } catch (err) {
      // A refusal about the value typed (in use, wrong format, too soon for another code) shows under the form.
      if (err.status && err.status < 500) setFormError(err.message);
      else toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  // The number or email the account has now. An account with no mobile yet (a Google sign-up) has nothing to show, so
  // the line is left out rather than reading "Current: +91".
  const current = isMobile ? (profile.phone ? `${profile.cc} ${profile.phone}` : '') : profile.email;

  return (
    <Screen bg="bg-white">
      <TopBar title={t(isMobile ? (current ? 'change_mobile_title' : 'change_mobile_add_title') : 'change_email_title')} />
      <Body contentClassName="px-[18px] pb-[26px] pt-5">
        {current ? (
          <Text className="mb-[26px] text-center text-[14.5px] text-muted">
            {t('change_contact_current')} <Text className="font-inter-bold text-navy">{current}</Text>
          </Text>
        ) : null}
        <View className="gap-[18px]">
          {isMobile ? (
            <View>
              <FieldLabel large required>{t('field_new_mobile')}</FieldLabel>
              <View className="flex-row gap-2">
                <Select large value={cc} options={COUNTRY_CODES} labels={COUNTRY_CODE_LABELS} onChange={setCc} title={t('field_new_mobile')} className="w-28" />
                <Input large className="flex-1" placeholder={t('field_mobile_number')} keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              </View>
              {phone && !ready ? <Text className="mt-1 text-[12px] text-danger">{t('change_err_mobile')}</Text> : null}
            </View>
          ) : (
            <Field
              large required label={t('field_new_email')} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail}
              error={email && !ready ? t('change_err_email') : undefined}
            />
          )}
          <Text className="text-[13.5px] leading-5 text-muted">{t(isMobile ? (current ? 'change_mobile_hint' : 'change_mobile_add_hint') : 'change_email_hint')}</Text>
        </View>
        {formError ? <Text className="mt-4 text-center text-[13.5px] text-danger">{formError}</Text> : null}
        <Spacer />
        <Button large title={t(isMobile ? 'change_send_mobile_btn' : 'change_send_email_btn')} disabled={!ready} loading={busy} onPress={submit} />
      </Body>
    </Screen>
  );
}
