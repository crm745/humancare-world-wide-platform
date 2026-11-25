import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApp } from '../state/AppContext';
import { errorText } from '../lib/errorText';
import { navReplace } from '../lib/nav';
import { apiPost } from '../lib/api';
import { BackButton, Body, Screen } from '../components/layout';
import { Button, Heading, Spacer, Text } from '../components/ui';
import { OtpInput, PasswordField, otpComplete } from '../components/widgets';
import { NeedsInternet } from '../components/network/NeedsInternet';

export default function ResetPassword() {
  const { t, toast } = useApp();
  const { identifier, origin = '/login' } = useLocalSearchParams();
  const [code, setCode] = useState('');
  const [pwd1, setPwd1] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = otpComplete(code) && pwd1.length >= 8 && pwd1 === pwd2;

  const submit = async () => {
    if (!otpComplete(code)) { toast(t('err_enter_6_digits')); return; }
    if (pwd1.length < 8) { toast(t('err_pwd_min_8')); return; }
    if (pwd1 !== pwd2) { toast(t('err_pwd_mismatch')); return; }
    setBusy(true);
    try {
      await apiPost('/auth/reset-password', { email: identifier, code, newPassword: pwd1 });
      toast(t('pwd_updated'));
      navReplace(origin);
    } catch (err) {
      toast(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bg="bg-white">
      <Body contentClassName="p-[26px]">
        <BackButton className="mb-10" />
        <Heading className="text-center text-[27.5px]">{t('reset_pwd_title')}</Heading>
        <Text className="mb-8 mt-3.5 text-center text-[15.5px] text-muted">
          {t('otp_sent_to')} <Text className="font-inter-bold text-navy">{identifier}</Text>
        </Text>
        <OtpInput large value={code} onChange={setCode} />
        <View className="mb-[34px] mt-5 items-center">
          <Text className="text-[14.5px] text-faint">{t('otp_resend')}</Text>
        </View>
        <View className="gap-5">
          <PasswordField
            required label={t('reset_pwd_new_label')} placeholder={t('ph_min_8')} value={pwd1} onChangeText={setPwd1}
            error={pwd1 && pwd1.length < 8 ? t('pwd_err_min') : undefined}
          />
          <PasswordField
            required label={t('reset_pwd_confirm_label')} placeholder={t('ph_reenter_new_password')} value={pwd2} onChangeText={setPwd2}
            error={pwd2 && pwd1 !== pwd2 ? t('err_pwd_mismatch') : undefined}
          />
        </View>
        <Spacer />
        <Button large title={t('reset_pwd_btn')} dimmed={!ready} loading={busy} needsNetwork onPress={submit} />
        <NeedsInternet />
      </Body>
    </Screen>
  );
}
