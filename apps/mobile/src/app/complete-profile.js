import { useState } from 'react';
import { View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useApp } from '../state/AppContext';
import { BackButton, Body, Screen } from '../components/layout';
import { Button, Field, Heading, Text } from '../components/ui';
import { NationalityPhoneFields } from '../components/NationalityPhone';
import { GenderField } from '../components/GenderField';
import { SignupConsents, consentsBody } from '../components/SignupConsents';
import { apiPost } from '../lib/api';
import { codeStepFrom, getAuthStep, setAuthStep } from '../lib/authFlow';
import { INITIAL_PHONE_STATE, dialOf, pickNationality, pickPhoneCountry } from '../lib/phoneCountry';
import { isValidMobileNumber, isValidName, isValidNamePart } from '../lib/validators';

// Sign-up for someone new who tapped Google/Apple on the Login screen: a short step for what
// the provider cannot give us (gender, nationality, mobile number) and the consents. The name
// and email the provider already gave are not asked for again; the name is only asked when the
// provider sent none (Apple lets people hide it). The mobile code on register-otp.js finishes
// the account and lands on Home. No password: they sign in with Google/Apple.
export default function CompleteProfile() {
  const { t, toast } = useApp();
  const [step] = useState(() => getAuthStep('social-signup'));
  const nameKnown = isValidName(step?.name);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [gender, setGender] = useState('');
  const [where, setWhere] = useState(INITIAL_PHONE_STATE);
  const [phone, setPhone] = useState('');
  const [consents, setConsents] = useState([false, false, false]);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  if (!step) return <Redirect href="/login" />;

  const name = nameKnown ? step.name.trim() : '';
  const ready = (nameKnown || (isValidNamePart(firstName) && isValidNamePart(lastName))) && gender && where.nationality && isValidMobileNumber(phone, dialOf(where.phoneCountry)) && consents[0] && consents[1];

  const submit = async () => {
    if (!ready) {
      setAttempted(true);
      toast('Enter your name, gender, nationality and a valid mobile number, and accept the required consents.');
      return;
    }
    setBusy(true);
    try {
      const data = await apiPost('/auth/social/register', {
        signupTicket: step.signupTicket, mobile: phone.trim(),
        ...(nameKnown ? { name } : { firstName: firstName.trim(), lastName: lastName.trim() }),
        countryCode: dialOf(where.phoneCountry), phoneCountry: where.phoneCountry,
        gender, nationality: where.nationality,
        consents: consentsBody(consents),
      });
      toast('OTP sent');
      setAuthStep('register-otp', codeStepFrom(data));
      router.push('/register-otp');
    } catch (err) {
      toast(err.message);
      // The 15-minute sign-up ticket ran out: start again from the Google/Apple button.
      if (err.code === 'ticket_invalid') router.replace('/login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bg="bg-white">
      <View className="px-[26px] pt-[26px]"><BackButton /></View>
      <Body contentClassName="px-[26px] pb-[26px] pt-5">
        <Heading className="text-center text-[27.5px]">{t('complete_profile_title')}</Heading>
        <Text className="mt-2.5 text-center text-[16.5px] text-muted">{t('complete_profile_sub')}</Text>
        {nameKnown ? (
          <View className="mb-7 mt-4 rounded-xl bg-input px-4 py-3">
            <Text className="text-center text-[13.5px] text-muted">{t('complete_profile_signing_as').replace('{name}', name)}</Text>
            <Text className="mt-0.5 text-center text-[13.5px] text-faint" numberOfLines={1}>{step.email}</Text>
          </View>
        ) : <View className="mb-7" />}
        <View className="gap-[18px]">
          {!nameKnown && (
            <View className="flex-row gap-2.5">
              <Field
                large required className="flex-1" label={t('field_first_name')} placeholder="First name" value={firstName} onChangeText={setFirstName}
                autoCapitalize="words" error={(attempted || firstName) && !isValidNamePart(firstName) ? 'Enter your first name.' : undefined}
              />
              <Field
                large required className="flex-1" label={t('field_last_name')} placeholder="Last name" value={lastName} onChangeText={setLastName}
                autoCapitalize="words" error={(attempted || lastName) && !isValidNamePart(lastName) ? 'Enter your last name.' : undefined}
              />
            </View>
          )}
          <GenderField value={gender} onChange={setGender} showError={attempted} />
          <NationalityPhoneFields
            nationality={where.nationality} phoneCountry={where.phoneCountry} phone={phone} showErrors={attempted}
            onNationality={(code) => setWhere((s) => pickNationality(s, code))}
            onPhoneCountry={(code) => setWhere((s) => pickPhoneCountry(s, code))}
            onPhone={setPhone}
          />
        </View>
        <SignupConsents value={consents} onChange={setConsents} />
        <Button large title={t('send_otp_btn')} dimmed={!ready} loading={busy} onPress={submit} className="mt-[26px]" />
      </Body>
    </Screen>
  );
}
