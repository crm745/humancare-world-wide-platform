import { useState } from 'react';
import { Image, View } from 'react-native';
import { router } from 'expo-router';
import { useApp } from '../state/AppContext';
import { BackButton, Body, Screen } from '../components/layout';
import { Button, Field, Heading, Text } from '../components/ui';
import { SignupConsents, consentsBody } from '../components/SignupConsents';
import { NationalityPhoneFields } from '../components/NationalityPhone';
import { GenderField } from '../components/GenderField';
import { PasswordField } from '../components/widgets';
import { LOGO } from '../data/images';
import { apiPost } from '../lib/api';
import { codeStepFrom, setAuthStep } from '../lib/authFlow';
import { INITIAL_PHONE_STATE, dialOf, pickNationality, pickPhoneCountry } from '../lib/phoneCountry';
import { PASSWORD_HINT, isValidEmail, isValidMobileNumber, isValidNamePart, passwordProblem } from '../lib/validators';

const LOGO_W = 150;
const LOGO_RATIO = 2440 / 1405;

// The sign-up form. Google/Apple buttons live on the Login screen only; someone new who
// uses them finishes on complete-profile.js (gender, nationality, mobile + consents) instead.
export default function Register() {
  const { t, toast } = useApp();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState('');
  // Nationality, and the phone's country: its calling code follows the nationality until the
  // person changes the code by hand (see lib/phoneCountry.js).
  const [where, setWhere] = useState(INITIAL_PHONE_STATE);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // The one consent: the Terms and Conditions and the Privacy Policy. Required.
  const [agreed, setAgreed] = useState(false);
  const passwordError = password ? passwordProblem(password) : null;
  const confirmError = confirm && confirm !== password ? 'Passwords do not match.' : null;
  const ready = isValidNamePart(firstName) && isValidNamePart(lastName) && gender && where.nationality && isValidMobileNumber(phone, dialOf(where.phoneCountry)) && isValidEmail(email)
    && password && !passwordError && confirm === password && agreed;

  // Creates the account (unverified, password hashed server-side) and texts an OTP;
  // register-otp.js verifies it with the ticket and signs straight in.
  const submit = async () => {
    if (!ready) {
      setAttempted(true);
      toast('Enter your first and last name, gender, nationality, a valid mobile number, email and password, and accept the Terms and Conditions and Privacy Policy.');
      return;
    }
    setBusy(true);
    try {
      // The backend saves these as proof of consent and refuses sign-up without the two required ones.
      const data = await apiPost('/auth/register', {
        name: `${firstName.trim()} ${lastName.trim()}`, firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), mobile: phone.trim(), password,
        countryCode: dialOf(where.phoneCountry), phoneCountry: where.phoneCountry,
        gender, nationality: where.nationality,
        consents: consentsBody(agreed),
      });
      toast('OTP sent');
      setAuthStep('register-otp', codeStepFrom(data));
      router.push('/register-otp');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bg="bg-white">
      {/* No header strip: the back button is the first thing inside the scrolling page, so it scrolls away with it. */}
      <Body contentClassName="px-[26px] pb-[26px] pt-[26px]">
        <BackButton className="mb-3" />
        {/* The official HumanCare logo, as it is everywhere else in the app: its own proportions, never stretched. The picture already carries the HUMANCARE wordmark. */}
        <Image
          source={LOGO} accessible accessibilityLabel={t('gs_logo_label')} resizeMode="contain"
          style={{ width: LOGO_W, height: LOGO_W / LOGO_RATIO, alignSelf: 'center', marginBottom: 14 }}
        />
        <Heading className="text-center text-[27.5px]">{t('register_title')}</Heading>
        <Text className="mb-7 mt-2.5 text-center text-[16.5px] text-muted">{t('register_sub')}</Text>
        <View className="gap-[18px]">
          <View className="flex-row gap-2.5">
            <Field
              large required className="flex-1" label={t('field_first_name')} placeholder="First name" value={firstName} onChangeText={setFirstName}
              autoCapitalize="words" error={firstName && !isValidNamePart(firstName) ? 'Enter your first name.' : undefined}
            />
            <Field
              large required className="flex-1" label={t('field_last_name')} placeholder="Last name" value={lastName} onChangeText={setLastName}
              autoCapitalize="words" error={lastName && !isValidNamePart(lastName) ? 'Enter your last name.' : undefined}
            />
          </View>
          <GenderField value={gender} onChange={setGender} showError={attempted} />
          <NationalityPhoneFields
            nationality={where.nationality} phoneCountry={where.phoneCountry} phone={phone} showErrors={attempted}
            onNationality={(code) => setWhere((s) => pickNationality(s, code))}
            onPhoneCountry={(code) => setWhere((s) => pickPhoneCountry(s, code))}
            onPhone={setPhone}
          />
          <Field
            large required label={t('field_email_address')} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail}
            error={email && !isValidEmail(email) ? 'Enter a valid email address.' : undefined}
          />
          <PasswordField
            required label={t('field_password')} placeholder="Create a password" value={password} onChangeText={setPassword}
            error={passwordError} hint={PASSWORD_HINT}
          />
          <PasswordField
            required label={t('field_confirm_password')} placeholder="Re-enter your password" value={confirm} onChangeText={setConfirm}
            error={confirmError}
          />
        </View>
        <SignupConsents value={agreed} onChange={setAgreed} />
        <Button large title={t('register_btn')} dimmed={!ready} loading={busy} onPress={submit} className="mt-[26px]" textClassName="tracking-wide" />
        <Text className="mt-6 text-center text-[15px] text-muted">
          {t('register_login_q')} <Text className="font-inter-bold text-primary" onPress={() => router.push('/login')}>{t('cta_login')}</Text>
        </Text>
      </Body>
    </Screen>
  );
}
