import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { errorText } from '../lib/errorText';
import { navReplace } from '../lib/nav';
import { beginSignIn, saveTokens } from '../lib/session';
import { hasValidTokens, postSignInRoute } from '../lib/tokens';
import { clearAuthSteps } from '../lib/authFlow';
import { BackButton, Body, Screen } from './layout';
import { Button, Input, Heading, Spacer, Text } from './ui';
import { useNetwork } from '../state/NetworkContext';
import { OtpInput, otpComplete } from './widgets';
import { RecaptchaNotice } from './RecaptchaNotice';
import { NeedsInternet } from './network/NeedsInternet';
import { classifyOtpError, isTransientOtpKind } from '../lib/otpErrors';

const RESEND_COOLDOWN_SECONDS = 30; // matches the backend's own cooldown

function formatTime(totalSeconds) {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Inline text for the error codes the auth API returns; anything else falls back to a toast.
// (lib/otpErrors.js tells the kinds apart: a wrong code, an expired one, no internet, a timeout and a server error each get their own, true message.)
function otpErrorMessage(err, t) {
  const view = classifyOtpError(err);
  if (view.key) return { text: t(view.key), kind: view.kind, keepCode: view.keepCode };
  if (view.literal) return { text: view.literal, kind: view.kind, keepCode: view.keepCode };
  return { text: null, kind: view.kind, keepCode: view.keepCode };
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
// `recaptcha`: this screen sends its code through Firebase, which runs reCAPTCHA on the web, so it shows Google's notice.
export function OtpScreen({ titleKey, identifier, contact, note, session, compact, recaptcha, onVerify, onResend, onChangeIdentifier }) {
  const { t, toast, setSession, setProfile } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState(null);
  const [errorKind, setErrorKind] = useState(null); // see lib/otpErrors.js: a failure that is not about the code (network, timeout, server) is shown until the connection is back, and never clears the code
  const [errorAtRestore, setErrorAtRestore] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);
  const { isOffline, restoredCount } = useNetwork(); // verifying and resending need the internet; the code stays typed
  const setError = (text, kind = null) => { setErrorText(text); setErrorKind(text ? kind : null); setErrorAtRestore(restoredCount); };
  // A "no internet" / "timed out" message is true only until the connection returns (and the offline line under the button says it meanwhile): then it goes by itself, with the code still typed.
  const staleFailure = (errorKind === 'network' || errorKind === 'timeout') && (restoredCount !== errorAtRestore || (errorKind === 'network' && isOffline));
  const shownError = staleFailure ? null : error;
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
    if (!otpComplete(code)) { setError(t('err_enter_6_digits')); return; }
    // A code screen with nothing to verify the code against cannot sign anyone in: no session without credentials.
    if (!onVerify) { toast(t('otp_err_step')); return; }

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
      if (!destination || !hasValidTokens(result)) throw Object.assign(new Error(t('err_signin_incomplete')), { code: 'invalid_credentials_response' });
      await saveTokens({ token: result.token, refreshToken: result.refreshToken }, { signIn: true, attempt });
      clearAuthSteps();
      if (result.profile) setProfile(result.profile);
      setSession(session);
      navReplace(destination);
    } catch (err) {
      if (err.code === 'stale_sign_in') return; // replaced by a newer sign-in or a sign-out: nothing to show
      const shown = otpErrorMessage(err, t);
      if (!shown.text) { toast(errorText(err, t, 'otp_verify_failed')); return; }
      setError(shown.text, shown.kind);
      // Only a code that cannot be tried again (expired, locked, lost) clears the boxes. A failure that is not about the code (no internet, a timeout, a server error) keeps it typed.
      if (!shown.keepCode) setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (secondsLeft > 0 || !onResend || resending) return;
    setResending(true);
    try {
      await onResend(currentId);
      toast(t('otp_resent'));
      setCode('');
      setError(null);
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      if (err.secondsLeft) setSecondsLeft(err.secondsLeft);
      const shown = otpErrorMessage(err, t);
      if (shown.text) setError(shown.text, shown.kind);
      else toast(errorText(err, t, 'otp_resend_failed'));
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
      toast(t('otp_sent_new'));
    } catch (err) {
      toast(errorText(err, t, 'otp_send_new_failed'));
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
            <Input large value={editValue} onChangeText={setEditValue} autoCapitalize="none" placeholder={t('ph_phone_or_email')} />
            <View className="mt-2.5 flex-row justify-end gap-4">
              <Text className="font-inter-bold text-[13.5px] text-faint" onPress={() => setEditing(false)}>{t('sos_modal_cancel')}</Text>
              <Text className="font-inter-bold text-[13.5px] text-primary" onPress={savingEdit || isOffline ? undefined : saveEdit}>{savingEdit ? 'Sending…' : 'Save & resend'}</Text>
            </View>
          </View>
        ) : (
          <Text className={`${compact ? 'mb-6 mt-1.5 text-[14px]' : 'mb-8 mt-3.5 text-center text-[15.5px]'} text-muted`}>
            {t('otp_sent_to')} <Text className="font-inter-bold text-navy">{contact || currentId}</Text>
            {onChangeIdentifier ? <Text className="font-inter-bold text-[11px] text-primary" onPress={startEdit}> Edit</Text> : null}
          </Text>
        )}

        <OtpInput value={code} onChange={changeCode} large={!compact} error={!!shownError && !isTransientOtpKind(errorKind)} />
        {shownError ? <Text className={`mt-2.5 text-[13px] ${isTransientOtpKind(errorKind) ? 'text-muted' : 'text-danger'} ${compact ? '' : 'text-center'}`}>{shownError}</Text> : null}
        <View className={`items-center ${compact ? 'mt-4' : 'mt-5'}`}>
          {secondsLeft > 0 ? (
            <Text className="text-[14.5px] text-faint">Resend OTP in {formatTime(secondsLeft)}</Text>
          ) : onResend ? (
            <Pressable onPress={resend} disabled={resending || isOffline} accessibilityRole="button" accessibilityState={{ disabled: resending || isOffline }} accessibilityHint={isOffline ? t('net_offline_text') : undefined} style={isOffline ? { opacity: 0.45 } : undefined}>
              <Text className="font-inter-bold text-[14.5px] text-primary">{resending ? 'Resending…' : 'Resend OTP'}</Text>
            </Pressable>
          ) : (
            <Text className="text-[14.5px] text-faint">{"Didn't get it? Go back and try again."}</Text>
          )}
        </View>
        {recaptcha ? <RecaptchaNotice /> : null}
        <Spacer />
        <Button large={!compact} title={t('otp_verify_btn')} onPress={verify} loading={busy} needsNetwork />
        <NeedsInternet />
      </Body>
    </Screen>
  );
}
