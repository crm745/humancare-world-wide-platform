import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { navReplace } from '../lib/nav';
import { beginSignIn, saveTokens } from '../lib/session';
import { hasValidTokens, postSignInRoute } from '../lib/tokens';
import { clearAuthSteps } from '../lib/authFlow';
import { BackButton, Body, Screen } from './layout';
import { Button, Input, Heading, Spacer, Text } from './ui';
import { OtpInput, otpComplete } from './widgets';

const RESEND_COOLDOWN_SECONDS = 30; // matches the backend's own cooldown

function formatTime(totalSeconds) {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Inline text for the error codes the auth API returns; anything else falls back to a toast.
function otpErrorMessage(err) {
  switch (err.code) {
    case 'otp_invalid':
      return 'Incorrect code. Please try again.';
    case 'otp_expired':
      return 'This code has expired. Request a new one with "Resend OTP".';
    case 'otp_locked':
      return 'Too many incorrect attempts. Request a new code with "Resend OTP".';
    case 'otp_missing':
      return 'This code is no longer valid. Request a new one with "Resend OTP".';
    case 'ticket_invalid':
      return 'This step has expired. Go back and start again.';
    default:
      return null;
  }
}

// Shared by every 6-digit code screen (login, register, forgot password, corporate).
// `contact` is what the "sent to" line shows (a masked number/email from the API, or the
// corporate email). `note` is an optional line above it.
//
// `onVerify(code, identifier)` resolves to either `{ token, refreshToken, profile }`
// (sign in as `session`, go Home) or `{ next, profile? }` (a route to replace this
// screen with, e.g. set-password, optionally updating the profile first). `onResend(identifier)` and `onChangeIdentifier(newIdentifier)` take
// the CURRENT identifier, since the edit link can change it right here. Any of the three
// can be left out — screens that can't support one just don't get that affordance.
export function OtpScreen({ titleKey, identifier, contact, note, session, compact, onVerify, onResend, onChangeIdentifier }) {
  const { t, toast, setSession, setProfile } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);
  const [currentId, setCurrentId] = useState(identifier);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(identifier);
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, []);

  const changeCode = (next) => { setCode(next); setError(null); };

  const verify = async () => {
    if (!otpComplete(code)) { setError('Enter all 6 digits.'); return; }
    // A code screen with nothing to verify the code against cannot sign anyone in: no session without credentials.
    if (!onVerify) { toast('This step cannot be completed. Please go back and try again.'); return; }

    setBusy(true);
    try {
      // Numbered before the request goes out: if this answer arrives after a newer sign-in began, or after a
      // sign-out, saveTokens refuses it (a stale answer can never restore a session).
      const attempt = beginSignIn();
      const result = await onVerify(code, currentId);
      if (result.next) {
        if (result.profile) setProfile(result.profile);
        navReplace(result.next);
        return;
      }
      // Signing in needs usable credentials and a session kind this app knows (patient or corporate), each
      // going to its own destination. Checked before anything is stored or announced.
      const destination = postSignInRoute(session);
      if (!destination || !hasValidTokens(result)) throw Object.assign(new Error('We could not complete sign-in. Please try again.'), { code: 'invalid_credentials_response' });
      await saveTokens({ token: result.token, refreshToken: result.refreshToken }, { signIn: true, attempt });
      clearAuthSteps();
      if (result.profile) setProfile(result.profile);
      setSession(session);
      navReplace(destination);
    } catch (err) {
      if (err.code === 'stale_sign_in') return; // replaced by a newer sign-in or a sign-out: nothing to show
      const message = otpErrorMessage(err);
      if (!message) { toast(err.message || 'Could not verify code'); return; }
      setError(message);
      // A locked or expired code can't be retried, so clear the boxes for the new one.
      if (err.code !== 'otp_invalid') setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (secondsLeft > 0 || !onResend || resending) return;
    setResending(true);
    try {
      await onResend(currentId);
      toast('A new code has been sent.');
      setCode('');
      setError(null);
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err.secondsLeft) setSecondsLeft(err.secondsLeft);
      const message = otpErrorMessage(err);
      if (message) setError(message);
      else toast(err.message || 'Could not resend code');
    } finally {
      setResending(false);
    }
  };

  const startEdit = () => { setEditValue(currentId); setEditing(true); };

  const saveEdit = async () => {
    const next = editValue.trim();
    if (!next || next === currentId) { setEditing(false); return; }
    setSavingEdit(true);
    try {
      await onChangeIdentifier(next);
      setCurrentId(next);
      setCode('');
      setError(null);
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
      setEditing(false);
      toast('Code sent to the new number/email.');
    } catch (err) {
      toast(err.message || 'Could not send a code to that number/email.');
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <Screen bg={compact ? 'bg-canvas' : 'bg-white'}>
      <Body contentClassName="p-[26px]">
        <BackButton className={compact ? 'mb-[22px]' : 'mb-10'} />
        <Heading className={compact ? 'text-[21.5px]' : 'text-center text-[27.5px]'}>{t(titleKey)}</Heading>
        {note ? (
          <Text className={`${compact ? 'mt-1.5 text-[14px]' : 'mt-3.5 text-center text-[15.5px]'} font-inter-bold text-navy`}>{note}</Text>
        ) : null}

        {editing ? (
          <View className={compact ? 'mb-6 mt-1.5' : 'mb-8 mt-3.5'}>
            <Input large value={editValue} onChangeText={setEditValue} autoCapitalize="none" placeholder="Mobile number or email" />
            <View className="mt-2.5 flex-row justify-end gap-4">
              <Text className="font-inter-bold text-[13.5px] text-faint" onPress={() => setEditing(false)}>Cancel</Text>
              <Text className="font-inter-bold text-[13.5px] text-primary" onPress={savingEdit ? undefined : saveEdit}>{savingEdit ? 'Sending…' : 'Save & resend'}</Text>
            </View>
          </View>
        ) : (
          <Text className={`${compact ? 'mb-6 mt-1.5 text-[14px]' : 'mb-8 mt-3.5 text-center text-[15.5px]'} text-muted`}>
            {t('otp_sent_to')} <Text className="font-inter-bold text-navy">{contact || currentId}</Text>
            {onChangeIdentifier ? <Text className="font-inter-bold text-[11px] text-primary" onPress={startEdit}> Edit</Text> : null}
          </Text>
        )}

        <OtpInput value={code} onChange={changeCode} large={!compact} error={!!error} />
        {error ? <Text className={`mt-2.5 text-[13px] text-danger ${compact ? '' : 'text-center'}`}>{error}</Text> : null}
        <View className={`items-center ${compact ? 'mt-4' : 'mt-5'}`}>
          {secondsLeft > 0 ? (
            <Text className="text-[14.5px] text-faint">Resend OTP in {formatTime(secondsLeft)}</Text>
          ) : onResend ? (
            <Pressable onPress={resend} disabled={resending}>
              <Text className="font-inter-bold text-[14.5px] text-primary">{resending ? 'Resending…' : 'Resend OTP'}</Text>
            </Pressable>
          ) : (
            <Text className="text-[14.5px] text-faint">{"Didn't get it? Go back and try again."}</Text>
          )}
        </View>
        <Spacer />
        <Button large={!compact} title={t('otp_verify_btn')} onPress={verify} loading={busy} />
      </Body>
    </Screen>
  );
}
