import { useState } from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '../state/AppContext';
import { OtpScreen } from '../components/OtpScreen';
import { apiPost } from '../lib/api';
import { getAuthStep, setAuthStep } from '../lib/authFlow';
import { profileFromUser } from '../lib/profile';
import { usePhoneCode } from '../lib/usePhoneCode';

// Second factor of login. The ticket from /auth/login (passed via authFlow, never the
// URL) is what ties this code to the password that was just checked. Accounts created
// before passwords existed arrive with `setup` set, and go on to set-password instead.
export default function LoginOtp() {
  const { t } = useApp();
  const [step] = useState(() => getAuthStep('login-otp'));
  const { proof, resend } = usePhoneCode(step);
  if (!step) return <Redirect href="/login" />;
  const { ticket, contact, setup } = step;

  const onVerify = async (code) => {
    const data = await apiPost('/auth/login/verify-otp', { ticket, ...(await proof(code)) });
    if (data.setPasswordTicket) {
      setAuthStep('set-password', { ticket: data.setPasswordTicket, reason: 'setup' });
      return { next: '/set-password' };
    }
    return { token: data.token, refreshToken: data.refreshToken, profile: profileFromUser(data.user) };
  };

  return (
    <OtpScreen
      titleKey="otp_enter_title"
      contact={contact}
      note={setup ? t('login_setup_note') : undefined}
      session="patient"
      onVerify={onVerify}
      onResend={resend}
      recaptcha
    />
  );
}
