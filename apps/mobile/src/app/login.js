import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowRight, Building2 } from 'lucide-react-native';
import { useApp } from '../state/AppContext';
import { Body, Screen } from '../components/layout';
import { Button, FieldLabel, Heading, Input, Text } from '../components/ui';
import { PasswordField, Select } from '../components/widgets';
import { navReplace } from '../lib/nav';
import { apiPost } from '../lib/api';
import { saveTokens } from '../lib/session';
import { postSignInRoute } from '../lib/tokens';
import { codeStepFrom, setAuthStep } from '../lib/authFlow';
import { profileFromUser } from '../lib/profile';
import { useSocialAuth } from '../lib/useSocialAuth';
import { isValidEmail, isValidMobileNumber } from '../lib/validators';
import { COUNTRY_CODES, CALLING_CODE_COUNTRY } from '../data/mock';
import { LOGO } from '../data/images';
import { AppleMark } from '../components/SocialMarks';

const LOGO_W = 150;
const LOGO_RATIO = 2440 / 1405;

// "+91" -> "🇮🇳 +91": the country's flag (built from its two-letter code) beside the calling code.
const flagOf = (iso) => String.fromCodePoint(...[...iso].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
const CODE_LABELS = Object.fromEntries(COUNTRY_CODES.map((code) => [code, `${CALLING_CODE_COUNTRY[code] ? flagOf(CALLING_CODE_COUNTRY[code]) : ''} ${code}`.trim()]));

// The Mobile Login / Email Login switch.
function ModeToggle({ mode, onChange, t }) {
  const tab = (key, label) => {
    const on = mode === key;
    return (
      <Pressable
        key={key} onPress={() => onChange(key)} accessibilityRole="tab" accessibilityState={{ selected: on }}
        className={`flex-1 items-center justify-center rounded-full py-3.5 ${on ? 'bg-primary' : ''}`}
      >
        <Text className={`font-inter-bold text-[15px] ${on ? 'text-white' : 'text-muted'}`}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View accessibilityRole="tablist" className="mb-[22px] flex-row rounded-full border border-field bg-input p-1">
      {tab('phone', t('login_tab_mobile'))}
      {tab('email', t('login_tab_email'))}
    </View>
  );
}

export default function Login() {
  const { t, toast, setSession, setProfile } = useApp();
  // Phone and email used to share one field that guessed which you meant — split into
  // two explicit modes instead, so there's no ambiguity and the country code always
  // has a home next to the number.
  const [mode, setMode] = useState('phone');
  const [phone, setPhone] = useState('');
  const [cc, setCc] = useState('+91');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const valid = mode === 'phone' ? isValidMobileNumber(phone, cc) : isValidEmail(email);
  const ready = valid && password.length > 0;

  // Password first; the backend then texts an OTP to the registered mobile and
  // login-otp.js finishes the sign-in with the ticket it hands back.
  const submit = async () => {
    if (!ready) return;
    setFormError(null);
    setBusy(true);
    try {
      const body = mode === 'phone' ? { mobile: phone.trim(), countryCode: cc, password } : { email: email.trim(), password };
      const data = await apiPost('/auth/login', body);
      setAuthStep('login-otp', codeStepFrom(data, { setup: !!data.needsPasswordSetup }));
      router.push('/login-otp');
    } catch (err) {
      if (err.code === 'invalid_credentials' || err.code === 'account_locked') setFormError(err.message);
      else toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next) => {
    setMode(next);
    setFormError(null);
  };

  // Google / Apple: the response must carry usable credentials before anyone is signed in (saveTokens refuses
  // a missing or empty token and stores and announces nothing), and the profile is read before they are saved.
  const afterSocialLogin = async ({ token, refreshToken, user }, attempt) => {
    const destination = postSignInRoute('patient');
    const profile = user ? profileFromUser(user) : null;
    await saveTokens({ token, refreshToken }, { signIn: true, attempt });
    if (profile) setProfile(profile);
    setSession('patient');
    navReplace(destination);
  };

  const socialButtons = useSocialAuth({ toast, afterSocialLogin });

  return (
    <Screen bg="bg-white">
      <Body contentClassName="justify-center p-[26px]">
        {/* The official HumanCare logo (its picture already carries the HUMANCARE wordmark), in its own proportions. */}
        <Image
          source={LOGO} accessible accessibilityLabel={t('gs_logo_label')} resizeMode="contain"
          style={{ width: LOGO_W, height: LOGO_W / LOGO_RATIO, alignSelf: 'center', marginBottom: 14 }}
        />
        <Heading className="text-center text-[29.5px]">{t('login_title_back')}</Heading>
        <Text className="mb-6 mt-2.5 text-center text-[16.5px] text-muted">{t('login_sub_back')}</Text>
        <ModeToggle mode={mode} onChange={switchTo} t={t} />

        {mode === 'phone' ? (
          <>
            <FieldLabel large required>{t('field_mobile_number')}</FieldLabel>
            <View className="flex-row gap-2">
              <Select large value={cc} options={COUNTRY_CODES} labels={CODE_LABELS} onChange={setCc} title={t('field_mobile_number')} className="w-32" />
              <Input large className="flex-1" placeholder="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            </View>
            {phone && !valid ? <Text className="mt-1 text-[12px] text-danger">Enter a valid number for the selected country.</Text> : null}
          </>
        ) : (
          <>
            <FieldLabel large required>{t('field_email_address')}</FieldLabel>
            <Input large placeholder="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            {email && !valid ? <Text className="mt-1 text-[12px] text-danger">Enter a valid email address.</Text> : null}
          </>
        )}

        <View className="mt-[18px]">
          <PasswordField required label={t('field_password')} placeholder="Your password" value={password} onChangeText={setPassword} />
        </View>
        <View className="mt-2.5 items-end">
          <Text className="font-inter-bold text-[14.5px] text-primary" onPress={() => router.push({ pathname: '/forgot-password', params: { origin: '/login' } })}>
            {t('cta_forgot_password')}
          </Text>
        </View>

        {formError ? <Text className="mt-4 text-center text-[13.5px] text-danger">{formError}</Text> : null}
        <Button large title={t('login_btn')} disabled={!ready} loading={busy} onPress={submit} className={formError ? 'mt-4' : 'mt-[30px]'} />
        <Text className="my-[22px] text-center text-[14px] text-faint">{t('login_or')}</Text>
        <View className="gap-2.5">
          {socialButtons.filter((b) => b.key !== 'apple').map(({ key, Mark, onPress, disabled }) => (
            <Pressable key={key} onPress={onPress} disabled={disabled} className="h-12 flex-row items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-field bg-white active:opacity-80 disabled:opacity-40">
              <Mark />
              <Text className="font-inter-bold text-[14px] text-ink">{t(`continue_with_${key}`)}</Text>
            </Pressable>
          ))}
          {/* Apple Sign-In is not switched on yet: shown, but dimmed and it does nothing. */}
          <View
            accessible accessibilityRole="button" accessibilityState={{ disabled: true }} accessibilityLabel={t('continue_with_apple')}
            className="h-12 flex-row items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-field bg-white opacity-40"
          >
            <AppleMark />
            <Text className="font-inter-bold text-[14px] text-ink">{t('continue_with_apple')}</Text>
          </View>
        </View>
        <Text className="mt-6 text-center text-[15px] text-muted">
          {t('login_signup_q')}{' '}
          <Text className="font-inter-bold text-primary" onPress={() => router.push('/register')}>{t('cta_signup')}</Text>
        </Text>
        <Pressable
          onPress={() => router.push('/corporate-login')} accessibilityRole="button" accessibilityLabel={`${t('login_partner_q')} ${t('login_partner_cta')}`}
          className="mt-5 flex-row items-center gap-3 rounded-2xl border-[1.5px] border-navy bg-white p-3.5 active:opacity-80"
        >
          <View className="h-11 w-11 items-center justify-center rounded-full bg-primary-soft"><Building2 size={22} color="#0D2340" /></View>
          <Text className="flex-1 font-inter-bold text-[14.5px] text-navy">{t('login_partner_q')}</Text>
          <View className="flex-row items-center gap-1">
            <Text className="font-inter-bold text-[14px] text-navy">{t('login_partner_cta')}</Text>
            <ArrowRight size={16} color="#0D2340" />
          </View>
        </Pressable>
      </Body>
    </Screen>
  );
}
