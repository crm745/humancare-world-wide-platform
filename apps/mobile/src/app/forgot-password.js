import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Mail, Phone } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { COUNTRY_CODES, COUNTRY_CODE_LABELS } from '../data/mock';
import { errorText } from '../lib/errorText';
import { goBack } from '../lib/nav';
import { apiPost } from '../lib/api';
import { codeStepFrom, setAuthStep } from '../lib/authFlow';
import { isValidEmail, isValidMobileNumber } from '../lib/validators';
import { BackButton, Body, Screen } from '../components/layout';
import { Button, Field, FieldLabel, Heading, Input, Spacer, Text } from '../components/ui';
import { Select } from '../components/widgets';
import { NeedsInternet } from '../components/network/NeedsInternet';

// Shared screen, two backends: corporates reset by email through the corporate flow
// (reset-password.js); patients can use their mobile or email, verify the code on
// forgot-password-otp.js and then pick a new password on set-password.js.
export default function ForgotPassword() {
  const { t, toast } = useApp();
  const { origin = '/login' } = useLocalSearchParams();
  const isCorporate = origin === '/corporate-login';
  const [mode, setMode] = useState(isCorporate ? 'email' : 'phone');
  const [id, setId] = useState('');
  const [phone, setPhone] = useState('');
  const [cc, setCc] = useState('+91');
  const [busy, setBusy] = useState(false);

  const valid = mode === 'phone' ? isValidMobileNumber(phone, cc) : isValidEmail(id);

  const submit = async () => {
    if (!valid) { toast(mode === 'phone' ? t('err_valid_mobile') : t('change_err_email')); return; }
    setBusy(true);
    try {
      if (isCorporate) {
        await apiPost('/auth/forgot-password', { email: id });
        toast(t('forgot_sent_generic'));
        router.push({ pathname: '/reset-password', params: { identifier: id, origin } });
      } else {
        const body = mode === 'phone' ? { mobile: phone.trim(), countryCode: cc } : { email: id.trim() };
        const data = await apiPost('/auth/password/forgot', body);
        toast(t('forgot_sent_generic'));
        setAuthStep('forgot-password-otp', codeStepFrom(data));
        router.push('/forgot-password-otp');
      }
    } catch (err) {
      toast(errorText(err, t));
      // Email not verified yet: the reset has to go through the mobile number.
      if (err.code === 'use_mobile') setMode('phone');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bg="bg-white">
      <Body contentClassName="p-[26px]">
        <BackButton className="mb-10" />
        <Heading className="text-center text-[27.5px]">{t('forgot_pwd_title')}</Heading>
        <Text className="mb-9 mt-3.5 text-center text-[16.5px] leading-[25px] text-muted">{t('forgot_pwd_sub')}</Text>
        {mode === 'phone' ? (
          <View>
            <FieldLabel large required>{t('field_mobile_number')}</FieldLabel>
            <View className="flex-row gap-2">
              <Select large value={cc} options={COUNTRY_CODES} labels={COUNTRY_CODE_LABELS} onChange={setCc} title={t('field_mobile_number')} className="w-28" />
              <Input large className="flex-1" placeholder={t('field_mobile_number')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            </View>
            {phone && !valid ? <Text className="mt-1 text-[12px] text-danger">{t('err_number_for_country')}</Text> : null}
          </View>
        ) : (
          <Field
            large required label={t('field_email_address')} placeholder={isCorporate ? 'you@company.com' : 'you@example.com'} value={id} onChangeText={setId} autoCapitalize="none" keyboardType="email-address"
            error={id && !isValidEmail(id) ? t('change_err_email') : undefined}
          />
        )}
        {isCorporate ? null : (
          <Pressable
            onPress={() => setMode(mode === 'phone' ? 'email' : 'phone')}
            className="mt-4 h-12 flex-row items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-field bg-white active:opacity-80"
          >
            {mode === 'phone' ? <Mail size={20} color="#45526B" /> : <Phone size={20} color="#45526B" />}
            <Text className="font-inter-bold text-[14px] text-ink">{t(mode === 'phone' ? 'continue_with_email' : 'continue_with_phone')}</Text>
          </Pressable>
        )}
        <Spacer />
        <Button large title={t('forgot_pwd_btn')} dimmed={!valid || busy} needsNetwork onPress={submit} />
        <NeedsInternet />
        <Text className="mt-7 text-center text-[15px] text-muted">
          {t('forgot_pwd_remember_q')}{' '}
          <Text className="font-inter-bold text-primary" onPress={goBack}>{t('cta_back_to_login')}</Text>
        </Text>
      </Body>
    </Screen>
  );
}
