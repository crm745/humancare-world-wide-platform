import { useState } from 'react';
import { View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useApp } from '../state/AppContext';
import { BackButton, Body, Screen } from '../components/layout';
import { Button, Field, FieldLabel, Heading, Text } from '../components/ui';
import { NationalityPhoneFields } from '../components/NationalityPhone';
import { ChoiceChips } from '../components/request/fields';
import { SignupConsents, consentsBody } from '../components/SignupConsents';
import { apiPost } from '../lib/api';
import { codeStepFrom, getAuthStep, setAuthStep } from '../lib/authFlow';
import { GENDER_OPTIONS } from '../data/mock';
import { INITIAL_PHONE_STATE, dialOf, pickNationality, pickPhoneCountry } from '../lib/phoneCountry';
import { isValidMobileNumber, isValidName } from '../lib/validators';

// Sign-up for someone new who tapped Google/Apple on the Login screen: a short step for what
// the provider cannot give us (gender, nationality, mobile number) and the consents. The name
// and email the provider already gave are not asked for again; the name is only asked when the
// provider sent none (Apple lets people hide it). The mobile code on register-otp.js finishes
// the account and lands on Home. No password: they sign in with Google/Apple.
export default function CompleteProfile() {
  const { t, toast } = useApp();
  const [step] = useState(() => getAuthStep('social-signup'));
  const nameKnown = isValidName(step?.name);
  const [typedName, setTypedName] = useState('');
  const [gender, setGender] = useState('');
  const [where, setWhere] = useState(INITIAL_PHONE_STATE);
  const [phone, setPhone] = useState('');
  const [consents, setConsents] = useState([false, false, false]);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  if (!step) return <Redirect href="/login" />;

  const name = nameKnown ? step.name.trim() : typedName.trim();
  const ready = isValidName(name) && gender && where.nationality && isValidMobileNumber(phone, dialOf(where.phoneCountry)) && consents[0] && consents[1];

  const submit = async () => {
    if (!ready) {
      setAttempted(true);
      toast('Enter your gender, nationality and a valid mobile number, and accept the required consents.');
      return;
    }
    setBusy(true);
    try {
      const data = await apiPost('/auth/social/register', {
        signupTicket: step.signupTicket, name, mobile: phone.trim(),
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
            <Field
              large required label={t('field_full_name')} placeholder="Your full name" value={typedName} onChangeText={setTypedName}
              error={(attempted || typedName) && !isValidName(typedName) ? 'Enter a valid name.' : undefined}
            />
          )}
          <View>
            <FieldLabel large required>{t('field_gender')}</FieldLabel>
            <ChoiceChips
              columns={2} label={t('field_gender')} value={gender} onChange={setGender}
              options={GENDER_OPTIONS.map((value) => ({ value, label: t(`gender_${value}`) }))}
            />
            {attempted && !gender ? <Text className="mt-1 text-[12px] text-danger">{t('gender_required')}</Text> : null}
          </View>
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
