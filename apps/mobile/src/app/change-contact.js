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
import { PasswordField, Select } from '../components/widgets';

// Change mobile or email, step 1 (`kind` = "mobile" | "email"): current password + the
// new value. The backend then sends a code to the NEW value (change-contact-otp.js), so
// a stolen session without the password can't move the login code somewhere else.
export default function ChangeContact() {
  const { t, toast, profile } = useApp();
  const { kind } = useLocalSearchParams();
  const isMobile = kind === 'mobile';
  const [cc, setCc] = useState(profile.cc || '+91');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const valid = isMobile ? isValidMobileNumber(phone, cc) : isValidEmail(email);
  const ready = valid && password.length > 0;

  const submit = async () => {
    if (!ready) return;
    setFormError(null);
    setBusy(true);
    try {
      const body = isMobile
        ? { kind, mobile: phone.trim(), countryCode: cc, password }
        : { kind, email: email.trim(), password };
      const data = await apiPost('/auth/me/contact', body);
      toast('OTP sent');
      setAuthStep('change-contact-otp', codeStepFrom(data, { kind }));
      router.push('/change-contact-otp');
    } catch (err) {
      if (['invalid_password', 'account_locked', 'password_required'].includes(err.code)) setFormError(err.message);
      else toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const current = isMobile ? `${profile.cc} ${profile.phone}` : profile.email;

  return (
    <Screen bg="bg-white">
      <TopBar title={t(isMobile ? 'change_mobile_title' : 'change_email_title')} />
      <Body contentClassName="px-[18px] pb-[26px] pt-5">
        <Text className="mb-[26px] text-center text-[14.5px] text-muted">
          {t('change_contact_current')} <Text className="font-inter-bold text-navy">{current}</Text>
        </Text>
        <View className="gap-[18px]">
          {isMobile ? (
            <View>
              <FieldLabel large required>{t('field_new_mobile')}</FieldLabel>
              <View className="flex-row gap-2">
                <Select large value={cc} options={COUNTRY_CODES} labels={COUNTRY_CODE_LABELS} onChange={setCc} title={t('field_new_mobile')} className="w-28" />
                <Input large className="flex-1" placeholder="Mobile number" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              </View>
              {phone && !valid ? <Text className="mt-1 text-[12px] text-danger">Enter a valid mobile number for the selected country.</Text> : null}
            </View>
          ) : (
            <Field
              large required label={t('field_new_email')} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail}
              error={email && !valid ? 'Enter a valid email address.' : undefined}
            />
          )}
          <PasswordField
            required label={t('field_current_password')} placeholder="Your password" value={password} onChangeText={setPassword}
            hint={t(isMobile ? 'change_mobile_hint' : 'change_email_hint')}
          />
        </View>
        {formError ? <Text className="mt-4 text-center text-[13.5px] text-danger">{formError}</Text> : null}
        <Spacer />
        <Button large title={t('send_otp_btn')} disabled={!ready} loading={busy} onPress={submit} />
      </Body>
    </Screen>
  );
}
