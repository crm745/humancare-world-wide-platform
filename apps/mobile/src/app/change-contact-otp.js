import { useState } from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '../state/AppContext';
import { OtpScreen } from '../components/OtpScreen';
import { apiPost } from '../lib/api';
import { clearAuthSteps, getAuthStep } from '../lib/authFlow';
import { profileFromUser } from '../lib/profile';
import { usePhoneCode } from '../lib/usePhoneCode';

// Change mobile or email, step 2: the code sent to the new number/inbox. On success the
// profile is updated and the person goes back to their Profile.
export default function ChangeContactOtp() {
  const { t, toast } = useApp();
  const [step] = useState(() => getAuthStep('change-contact-otp'));
  const { proof, resend } = usePhoneCode(step);
  if (!step) return <Redirect href="/edit-profile" />;
  const { ticket, contact, kind } = step;

  const onVerify = async (code) => {
    const data = await apiPost('/auth/me/contact/verify-otp', { ticket, ...(await proof(code)) });
    clearAuthSteps();
    toast(t(kind === 'mobile' ? 'change_mobile_updated' : 'change_email_updated'));
    return { profile: profileFromUser(data.user), next: '/profile' };
  };

  return (
    <OtpScreen
      titleKey={kind === 'mobile' ? 'register_otp_title' : 'register_email_otp_title'}
      contact={contact}
      session="patient"
      onVerify={onVerify}
      onResend={resend}
    />
  );
}
