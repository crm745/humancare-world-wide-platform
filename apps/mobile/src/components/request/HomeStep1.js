import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, MapPin } from 'lucide-react-native';
import { genderLabels } from '../../lib/genderLabels';
import { useApp } from '../../state/AppContext';
import { displayNameOf, countryDisplay } from '../../lib/countryNames';
import { pickRequestCountry, pickRequestPhoneCountry } from '../../lib/requestForm';
import { isValidMobileNumber, isValidName } from '../../lib/validators';
import {
  AGE_MAX, AGE_MIN, GENDERS, TEXT_MAX, codePointLength, freeTextProblem, homeStep1Problems, isValidHomeAge, isValidServiceDate,
} from '../../lib/homeHealthcare';
import { CountryPicker } from '../NationalityPhone';
import { Anchor, RequestFrame } from './RequestFrame';
import { FieldError, FieldHeader } from './fields';
import { HomeDateField } from './HomeDateField';
import { MultilineInput } from './MultilineInput';
import { Field, FieldLabel, Input, Text } from '../ui';
import { Select } from '../widgets';

// Step 1 of 3 for Home Healthcare Services: the patient, the Complete Home Address (where the care is given: it replaces Current Location and
// Destination) and the Service Date. Used by app/request/step1.js when the chosen service is "homecare"; every other service keeps its own Step 1.
// The rules are in lib/homeHealthcare.js (the contract with the server).
export function HomeStep1() {
  const { t, draft, updateDraft } = useApp();
  // Flips true the first time Continue is tapped while something required is still blank (no red borders on a form not yet started).
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(null); // 'country' | 'phone' | null
  const problems = homeStep1Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = t('req_required');
  const addressProblem = freeTextProblem(draft.homeAddress, { required: true });
  const addressError = addressProblem === 'too_long' ? t('home_err_too_long', { max: TEXT_MAX })
    : addressProblem === 'characters' ? t('home_err_text_chars')
      : attempted && addressProblem === 'required' ? required : null;

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical"
    >
      <Text className="font-inter-black text-[17px] text-navy">{t('step1_heading')}</Text>

      <Anchor id="name">
        <Field
          required label={t('field_patient_name')} placeholder={t('ph_patient_full_name')} value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidName(draft.name) ? t('pd_err_full') : undefined}
        />
      </Anchor>

      <Anchor id="age">
        <View className="flex-row gap-2.5">
          <Field
            required className="flex-1" label={t('field_age')} placeholder={t('field_deceased_age')} keyboardType="number-pad" maxLength={3}
            value={draft.age} onChangeText={(age) => updateDraft({ age })}
            error={(attempted || draft.age) && !isValidHomeAge(draft.age) ? t('home_err_age', { min: AGE_MIN, max: AGE_MAX }) : undefined}
          />
          <View className="flex-1">
            <FieldLabel required>{t('field_gender')}</FieldLabel>
            <Select value={draft.gender} options={GENDERS} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} labels={genderLabels(t)} keepSize placeholder={t('gender_placeholder')} />
            {attempted && !draft.gender ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
          </View>
        </View>
      </Anchor>

      <Anchor id="country">
        <FieldLabel required>{t('field_country')}</FieldLabel>
        <Pressable
          onPress={() => setPicking('country')} accessibilityRole="button" accessibilityLabel={`${t('field_country')}, ${countryDisplay(draft.countryIso, draft.country) || t('ph_select_country')}`}
          className="min-h-[48px] flex-row items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3 active:opacity-80"
        >
          <Text className={`flex-1 text-[15px] ${draft.country ? '' : 'text-faint'}`} numberOfLines={1}>{countryDisplay(draft.countryIso, draft.country) || t('ph_select_country')}</Text>
          <ChevronDown size={16} color="#97A4B8" />
        </Pressable>
        {attempted && !draft.country ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
      </Anchor>

      <Anchor id="phone">
        <FieldLabel required>{t('field_contact_number')}</FieldLabel>
        <View className="flex-row gap-2">
          <Pressable
            onPress={() => setPicking('phone')} accessibilityRole="button" accessibilityLabel={`${t('phone_country_code_label')}, ${displayNameOf(draft.phoneCountry)} ${draft.cc}`}
            className="min-h-[48px] min-w-[96px] flex-row items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-field bg-input px-3 active:opacity-80"
          >
            <Text className="text-[13px]">{draft.phoneCountry} {draft.cc}</Text>
            <ChevronDown size={16} color="#97A4B8" />
          </Pressable>
          <Input className="flex-1" placeholder={t('ph_enter_number')} keyboardType="phone-pad" value={draft.phone} onChangeText={(phone) => updateDraft({ phone })} />
        </View>
        {(attempted || draft.phone) && !isValidMobileNumber(draft.phone, draft.cc)
          ? <Text className="mt-1 text-[12px] text-danger">{draft.phone ? t('err_number_for_country') : required}</Text> : null}
      </Anchor>

      <Anchor id="address">
        <FieldHeader title={t('field_home_address')} required hint={`${codePointLength(draft.homeAddress)}/${TEXT_MAX}`} />
        <View className="min-h-[96px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><MapPin size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" value={draft.homeAddress} onChangeText={(homeAddress) => updateDraft({ homeAddress })}
            accessibilityLabel={t('field_home_address')} placeholder={t('field_home_address_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[72px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{addressError}</FieldError>
      </Anchor>

      <Anchor id="date">
        <HomeDateField
          required label={t('field_service_date')} value={draft.date} onChange={(date) => updateDraft({ date })}
          error={(attempted || draft.date) && !isValidServiceDate(draft.date) ? (draft.date ? t('home_err_service_date') : required) : undefined}
        />
      </Anchor>

      <CountryPicker
        visible={picking === 'country'} title={t('field_country')} selected={draft.countryIso}
        onPick={(code) => { setPicking(null); updateDraft(pickRequestCountry(draft, code)); }} onClose={() => setPicking(null)}
      />
      <CountryPicker
        visible={picking === 'phone'} title={t('phone_country_code_label')} selected={draft.phoneCountry}
        onPick={(code) => { setPicking(null); updateDraft(pickRequestPhoneCountry(draft, code)); }} onClose={() => setPicking(null)}
      />
    </RequestFrame>
  );
}
