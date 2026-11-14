import { useState } from 'react';
import { Redirect } from 'expo-router';
import { OtpScreen } from '../components/OtpScreen';
import { apiPost } from '../lib/api';
import { getAuthStep } from '../lib/authFlow';
import { profileFromUser } from '../lib/profile';
import { usePhoneCode } from '../lib/usePhoneCode';

// Sign-up step 2 (last): the mobile code. Passing it finishes the account and lands on
// Home, signed in. The email isn't verified here; that happens the first time a code
// sent to it is used (an email login). To use a different number, go back to the form:
// the ticket is tied to the account that was just created.
export default function RegisterOtp() {
  const [step] = useState(() => getAuthStep('register-otp'));
  const { proof, resend } = usePhoneCode(step);
  if (!step) return <Redirect href="/register" />;
  const { ticket, contact } = step;

  const onVerify = async (code) => {
    const data = await apiPost('/auth/register/verify-otp', { ticket, ...(await proof(code)) });
    return { token: data.token, refreshToken: data.refreshToken, profile: profileFromUser(data.user) };
  };

  return <OtpScreen titleKey="register_otp_title" contact={contact} session="patient" onVerify={onVerify} onResend={resend} recaptcha />;
}
