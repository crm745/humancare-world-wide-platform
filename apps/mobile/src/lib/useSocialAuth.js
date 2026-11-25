import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { errorText } from './errorText';
import { useGoogleSignIn, isGoogleConfigured } from './googleAuth';
import { signInWithApple } from './appleAuth';
import { apiPost } from './api';
import { beginSignIn } from './session';
import { setAuthStep } from './authFlow';
import { runGoogleLogin } from './googleLogin';
import { GoogleMark, AppleMark } from '../components/SocialMarks';
import { useNetwork } from '../state/NetworkContext';
import { TIMEOUT_CODE, createFlowWatch, isOfflineError, startSocialSignIn } from './socialGuard';

// Used by login.js: Google works on both platforms, Apple is
// iOS-only (per App Store rule — see the task doc). `afterSocialLogin` gets the
// backend's { token, refreshToken, user } once either provider succeeds.
// `t` is the app's translate function (the offline sentence). Offline rules (lib/socialGuard.js): nothing starts while the phone is known to be offline, checked again at the tap; a flow that is
// running when the connection drops, or that the provider never finishes, ends with a message and the person is back on the login screen.
export function useSocialAuth({ toast, afterSocialLogin, t }) {
  const { isOffline } = useNetwork(); // the ONE network state of the app (the banner and every offline-disabled button use it); unknown counts as online
  const offlineRef = useRef(isOffline);
  const [watch] = useState(() => createFlowWatch({ offlineMessage: t('net_google_offline'), timeoutMessage: t('net_social_timeout') }));
  useEffect(() => {
    offlineRef.current = isOffline;
    if (isOffline) watch.abort(); // the connection dropped while a provider screen was open
  }, [isOffline, watch]);
  // Each attempt is numbered before its request goes out (see session.js beginSignIn), so an answer that arrives after
  // a newer sign-in or a sign-out is refused instead of restoring a session.
  // An existing account is signed straight in, and so is a new Google user whose email Google verified (the backend
  // creates the account; mobile and the rest are added later from Personal Details). A new Apple user gets a sign-up
  // ticket with the name and email Apple vouched for, and finishes on complete-profile.js (mobile + consents). Without
  // a ticket (the provider hadn't verified the email) it's the full form.
  const onFailed = (err) => {
    if (err.code === 'stale_sign_in') return; // replaced by a newer sign-in or a sign-out
    if (err.code === 'no_account' && err.data?.signupTicket) {
      setAuthStep('social-signup', { signupTicket: err.data.signupTicket, ...err.data.profile });
      router.push('/complete-profile');
      return;
    }
    toast(isOfflineError(err) ? t('net_google_offline') : err.code === TIMEOUT_CODE ? t('net_social_timeout') : errorText(err, t));
    if (err.code === 'no_account') router.push('/register');
  };

  // googleAuth.web.js (popup) on web, googleAuth.native.js (native picker) on phones.
  const google = useGoogleSignIn();

  const googleGuard = useRef({ busy: false }); // a second tap while one attempt is running does nothing
  const onGoogle = async () => {
    if (!isGoogleConfigured) { toast(t('social_not_configured')); return; }
    try {
      const started = await startSocialSignIn({ isOffline: offlineRef.current, run: () => runGoogle() });
      if (started === 'offline') toast(t('net_google_offline')); // the state changed since the screen drew: say why nothing opened
    } catch (err) {
      onFailed(err);
    }
  };
  // (Called straight from the tap: the web popup has to open inside it, so nothing is awaited before google.signIn().)
  const runGoogle = () => runGoogleLogin({
    // Closing the picker or the popup ends quietly (no sign-in, no message); the screen after sign-in opens only once the backend has said yes.
    begin: beginSignIn,
    getIdToken: () => watch.run(google.signIn()), // ends with an error if the connection drops or Google never answers
    postToken: (idToken) => apiPost('/auth/google', { idToken }),
    afterLogin: afterSocialLogin,
    reopenPicker: google.reopen, // web: a second tap brings the popup back
  }, googleGuard.current);

  const onApple = async () => {
    try {
      if (offlineRef.current) { toast(t('net_google_offline')); return; } // Apple sign-in needs the internet too: nothing starts offline
      const attempt = beginSignIn();
      const { idToken, name } = await watch.run(signInWithApple());
      const data = await apiPost('/auth/apple', { idToken, name });
      await afterSocialLogin(data, attempt);
    } catch (err) {
      if (err.code === 'ERR_REQUEST_CANCELED' || err.code === 'stale_sign_in') return;
      if (err.code === 'no_account' || isOfflineError(err)) onFailed(err);
      else toast(errorText(err, t, 'apple_failed'));
    }
  };

  // `offline` is the same flag the banner and the other offline-disabled buttons use: the screens switch the button off and show the line under it.
  return [
    { key: 'google', Mark: GoogleMark, onPress: onGoogle, disabled: !google.ready, offline: isOffline },
    ...(Platform.OS === 'ios' ? [{ key: 'apple', Mark: AppleMark, onPress: onApple, offline: isOffline }] : []),
  ];
}
