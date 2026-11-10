import { useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useApp } from '../state/AppContext';
import { navReplace } from '../lib/nav';
import { apiPost } from '../lib/api';
import { beginSignIn, saveTokens } from '../lib/session';
import { postSignInRoute } from '../lib/tokens';
import { clearAuthSteps, getAuthStep } from '../lib/authFlow';
import { profileFromUser } from '../lib/profile';
import { PASSWORD_HINT, passwordProblem } from '../lib/validators';
import { Body, Screen } from '../components/layout';
import { Button, Heading, Spacer, Text } from '../components/ui';
import { PasswordField } from '../components/widgets';

// Last step of two flows, both reached only after an OTP check:
//  - reason "setup": an account from before passwords existed must set one before
//    entering the app; success signs them in.
//  - reason "reset": forgot password; success signs out every device and goes to Login.
// No back button: there's nothing valid to go back to once the code has been used.
export default function SetPassword() {
  const { t, toast, setSession, setProfile } = useApp();
  const [step] = useState(() => getAuthStep('set-password'));
  const [pwd1, setPwd1] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  if (!step) return <Redirect href="/login" />;
  const { ticket, reason } = step;
  const isSetup = reason === 'setup';
  const pwdError = pwd1 ? passwordProblem(pwd1) : null;
  const matchError = pwd2 && pwd1 !== pwd2 ? 'Passwords do not match.' : null;
  const ready = pwd1 && !pwdError && pwd1 === pwd2;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const attempt = beginSignIn(); // before the request: a stale answer cannot restore a session
      const data = await apiPost('/auth/password/set', { ticket, password: pwd1 });
      clearAuthSteps();
      if (isSetup) {
        // Activation signs the person in: usable credentials first (saveTokens refuses a missing or empty
        // token and stores and announces nothing), the profile read before they are saved.
        const profile = profileFromUser(data.user);
        await saveTokens({ token: data.token, refreshToken: data.refreshToken }, { signIn: true, attempt });
        setProfile(profile);
        setSession('patient');
        navReplace(postSignInRoute('patient'));
      } else {
        toast(data.message || 'Password updated. Please log in.');
        navReplace('/login');
      }
    } catch (err) {
      if (err.code === 'stale_sign_in') return; // replaced by a newer sign-in or a sign-out
      toast(err.message);
      if (err.code === 'ticket_invalid') navReplace('/login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bg="bg-white">
      <Body contentClassName="p-[26px]">
        <Heading className="mt-10 text-center text-[27.5px]">{t(isSetup ? 'set_pwd_setup_title' : 'set_pwd_reset_title')}</Heading>
        <Text className="mb-8 mt-3.5 text-center text-[15.5px] text-muted">{t(isSetup ? 'set_pwd_setup_sub' : 'set_pwd_reset_sub')}</Text>
        <View className="gap-5">
          <PasswordField
            required label={t(isSetup ? 'field_password' : 'reset_pwd_new_label')} placeholder="Create a password" value={pwd1} onChangeText={setPwd1}
            error={pwdError} hint={PASSWORD_HINT}
          />
          <PasswordField
            required label={t(isSetup ? 'field_confirm_password' : 'reset_pwd_confirm_label')} placeholder="Re-enter your password" value={pwd2} onChangeText={setPwd2}
            error={matchError}
          />
        </View>
        <Spacer />
        <Button large title={t(isSetup ? 'set_pwd_btn' : 'reset_pwd_btn')} disabled={!ready} loading={busy} onPress={submit} />
        <Text className="mt-7 text-center text-[15px] text-muted">
          <Text className="font-inter-bold text-primary" onPress={() => navReplace('/login')}>{t('cta_back_to_login')}</Text>
        </Text>
      </Body>
    </Screen>
  );
}
