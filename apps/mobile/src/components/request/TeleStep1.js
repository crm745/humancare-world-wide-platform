import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, MapPin } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { nameOf } from '../../lib/phoneCountry';
import { pickRequestCountry, pickRequestPhoneCountry } from '../../lib/requestForm';
import { isValidMobileNumber, isValidName } from '../../lib/validators';
import {
  ADDRESS_MAX, asksScope, TELE_SCOPES, TELE_SCOPE_LABEL_KEYS, TELE_TYPES, TELE_TYPE_LABEL_KEYS, codePointLength, isValidTeleAge, teleStep1Problems,
} from '../../lib/teleConsultation';
import { CountryPicker } from '../NationalityPhone';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader } from './fields';
import { MultilineInput } from './MultilineInput';
import { Field, FieldLabel, Input, Text } from '../ui';
import { Select } from '../widgets';

// Step 1 of 3 for Teleconsultation ("Tele Consultation & House Call"): Consultation Type, then (for a House Call only) Scope, then the patient and the
// Current Address. An Online Consultation has no Scope. No origin, destination or Date of Service (a House Call's date is asked on the next page), and
// neither Type nor Scope is preselected. Used by
// app/request/step1.js when the chosen service is "tele"; every other service keeps its own Step 1.
export function TeleStep1() {
  const { t, draft, updateDraft } = useApp();
  // Flips true the first time Continue is tapped while something required is still blank (no red borders on a form not yet started).
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(null); // 'country' | 'phone' | null
  const problems = teleStep1Problems(draft);
  const wrong = Object.fromEntries(problems);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = t('req_required');
  const addressLength = codePointLength(draft.address);

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical"
    >
      <Text className="font-inter-black text-[17px] text-navy">{t('step1_heading')}</Text>

      <Anchor id="type">
        <FieldHeader title={t('field_consult_type')} required />
        <ChoiceChips
          columns={2} label={t('field_consult_type')} value={draft.teleType}
          // An Online Consultation has no visit date and no Scope: choosing it drops any date and Scope picked for a House Call.
          onChange={(teleType) => updateDraft(teleType === 'online' ? { teleType, date: '', teleScope: '' } : { teleType })}
          options={TELE_TYPES.map((key) => ({ value: key, label: t(TELE_TYPE_LABEL_KEYS[key]) }))}
        />
        <FieldError>{attempted && wrong.type ? required : null}</FieldError>
      </Anchor>

      {asksScope(draft) && (
        <Anchor id="scope">
          <FieldHeader title={t('field_consult_scope')} required />
          <ChoiceChips
            columns={2} label={t('field_consult_scope')} value={draft.teleScope} onChange={(teleScope) => updateDraft({ teleScope })}
            options={TELE_SCOPES.map((key) => ({ value: key, label: t(TELE_SCOPE_LABEL_KEYS[key]) }))}
          />
          <FieldError>{attempted && wrong.scope ? required : null}</FieldError>
        </Anchor>
      )}

      <Anchor id="name">
        <Field
          required label={t('field_patient_name')} placeholder="Enter patient's full name" value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidName(draft.name) ? 'Enter a valid name.' : undefined}
        />
      </Anchor>

      <Anchor id="age">
        <View className="flex-row gap-2.5">
          <Field
            required className="flex-1" label={t('field_age')} placeholder="Age" keyboardType="number-pad" maxLength={3}
            value={draft.age} onChangeText={(age) => updateDraft({ age })}
            error={(attempted || draft.age) && !isValidTeleAge(draft.age) ? 'Enter an age from 0 to 129.' : undefined}
          />
          <View className="flex-1">
            <FieldLabel required>{t('field_gender')}</FieldLabel>
            <Select value={draft.gender} options={['Male', 'Female', 'Other']} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} placeholder="Select gender" />
            {attempted && !draft.gender ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
          </View>
        </View>
      </Anchor>

      <Anchor id="country">
        <FieldLabel required>{t('field_country')}</FieldLabel>
        <Pressable
          onPress={() => setPicking('country')} accessibilityRole="button" accessibilityLabel={`${t('field_country')}, ${draft.country || 'Select country'}`}
          className="min-h-[48px] flex-row items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3 active:opacity-80"
        >
          <Text className={`flex-1 text-[15px] ${draft.country ? '' : 'text-faint'}`} numberOfLines={1}>{draft.country || 'Select country'}</Text>
          <ChevronDown size={16} color="#97A4B8" />
        </Pressable>
        {attempted && !draft.country ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
      </Anchor>

      <Anchor id="phone">
        <FieldLabel required>{t('field_contact_number')}</FieldLabel>
        <View className="flex-row gap-2">
          <Pressable
            onPress={() => setPicking('phone')} accessibilityRole="button" accessibilityLabel={`${t('phone_country_code_label')}, ${nameOf(draft.phoneCountry)} ${draft.cc}`}
            className="min-h-[48px] min-w-[96px] flex-row items-center justify-center gap-1 rounded-[10px] border-[1.5px] border-field bg-input px-3 active:opacity-80"
          >
            <Text className="text-[13px]">{draft.phoneCountry} {draft.cc}</Text>
            <ChevronDown size={16} color="#97A4B8" />
          </Pressable>
          <Input className="flex-1" placeholder="Enter number" keyboardType="phone-pad" value={draft.phone} onChangeText={(phone) => updateDraft({ phone })} />
        </View>
        {(attempted || draft.phone) && !isValidMobileNumber(draft.phone, draft.cc)
          ? <Text className="mt-1 text-[12px] text-danger">{draft.phone ? 'Enter a valid number for the selected country.' : required}</Text> : null}
      </Anchor>

      <Anchor id="address">
        <FieldHeader title={t('field_current_address')} required hint={`${addressLength}/${ADDRESS_MAX}`} />
        <View className="min-h-[96px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><MapPin size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" maxLength={ADDRESS_MAX} value={draft.address} onChangeText={(address) => updateDraft({ address })}
            accessibilityLabel={t('field_current_address')} placeholder={t('field_current_address_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[72px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{addressLength > ADDRESS_MAX ? t('tele_err_too_long', { max: ADDRESS_MAX }) : attempted && wrong.address ? required : null}</FieldError>
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
