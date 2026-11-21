import { useState } from 'react';
import { Redirect } from 'expo-router';
import { useApp } from '../state/AppContext';
import { OtpScreen } from '../components/OtpScreen';
import { apiPost } from '../lib/api';
import { clearAuthSteps, getAuthStep } from '../lib/authFlow';
import { navReplace } from '../lib/nav';
import { clearTokens } from '../lib/session';
import { submissionTracker } from '../lib/pendingSubmissionStore';
import { uploadJournal } from '../lib/uploadJournalDevice';
import { usePhoneCode } from '../lib/usePhoneCode';

// Delete account, step 2 of 2: the code sent to the account's own email or mobile. The ticket from step 1 (kept in authFlow, never in the URL) ties this code to
// the password that was just checked. On success the server has retired the account (every session ends at once); the app then shows Login first and clears its
// tokens, in that order, so the sign-in gate does not bounce the person around (the same order as Log out).
export default function DeleteAccountOtp() {
  const { t, toast, clearDraftEverywhere } = useApp();
  const [step] = useState(() => getAuthStep('delete-account-otp'));
  const { proof, resend } = usePhoneCode(step);
  if (!step) return <Redirect href="/profile" />;
  const { ticket, contact } = step;

  const onVerify = async (code) => {
    await apiPost('/auth/me/delete/confirm', { ticket, confirm: true, ...(await proof(code)) });
    clearAuthSteps();
    await submissionTracker.clearAll(); // the account is gone: no unresolved request key of it is kept
    await clearDraftEverywhere(); // nor its saved draft or the key that protects it
    await uploadJournal.clearAll(); // nor the ids of its unconfirmed uploads
    toast(t('del_done'));
    navReplace('/login');
    await clearTokens();
    return { next: '/login' };
  };

  return (
    <OtpScreen
      titleKey="otp_enter_title"
      contact={contact}
      session="patient"
      onVerify={onVerify}
      onResend={resend}
      recaptcha
    />
  );
}
