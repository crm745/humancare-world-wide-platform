import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Building2, ChevronDown } from 'lucide-react-native';
import { genderLabels } from '../../lib/genderLabels';
import { useApp } from '../../state/AppContext';
import { nameOf } from '../../lib/phoneCountry';
import { displayNameOf, countryDisplay } from '../../lib/countryNames';
import { pickRequestPhoneCountry } from '../../lib/requestForm';
import { isValidMobileNumber, isValidName } from '../../lib/validators';
import {
  ADDRESS_MAX, COMPANY_MAX, EMPLOYEES_MAX, EMPLOYEES_MIN, GENDERS, PROGRAMME_KEYS, codePointLength, companyProblem, corporateStep1Problems, corporateText, employeeCountProblem,
  isValidOfficeCountry, isValidServiceDate, officeAddressProblem, programmeName,
} from '../../lib/corporateMedical';
import { CountryPicker } from '../NationalityPhone';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader } from './fields';
import { HomeDateField } from './HomeDateField';
import { MultilineInput } from './MultilineInput';
import { Field, FieldLabel, Input, Text } from '../ui';
import { Select } from '../widgets';

// Step 1 of 3 for Corporate Medical Solutions: Company Name, No. of Employees, Name of Employee, Gender, Patient Contact, Programmes, Preferred Date, Office Address and Office
// Country (all required). Used by app/request/step1.js when the chosen service is "corporate"; every other service keeps its own Step 1. The rules are in lib/corporateMedical.js
// (the contract with the server). Patient Contact is the usual international number input (its country code is only a dialling helper), Preferred Date is Home Healthcare's date
// picker (today or later), and the Office Country is its OWN country choice: it never follows, and never changes, the phone's country code or any patient-country field.
export function CorporateStep1() {
  const { t, draft, updateDraft, serverErrors } = useApp();
  const text = (key, values) => corporateText(t, key, values);
  const serverError = (field) => (serverErrors ? serverErrors[field] : undefined);
  // Flips true the first time Continue is tapped while something required is still blank (no red borders on a form not yet started).
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(null); // 'phone' | 'country' | null
  const problems = corporateStep1Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = text('corp_required');

  const company = companyProblem(draft.corpCompany);
  const companyError = company === 'too_long' ? text('corp_err_company_long', { max: COMPANY_MAX })
    : company === 'characters' ? text('corp_err_company_chars')
      : attempted && company === 'required' ? required : serverError('companyName');
  const employees = employeeCountProblem(draft.corpEmployees);
  const employeesError = employees === 'invalid' ? text('corp_err_employees', { min: EMPLOYEES_MIN, max: EMPLOYEES_MAX })
    : attempted && employees === 'required' ? required : serverError('employeeCount');
  const address = officeAddressProblem(draft.corpOfficeAddress);
  const addressError = address === 'too_long' ? text('corp_err_address_long', { max: ADDRESS_MAX })
    : address === 'characters' ? text('corp_err_address_chars')
      : attempted && address === 'required' ? required : serverError('officeAddress');

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical"
    >
      <Text className="font-inter-black text-[17px] text-navy">{text('corp_heading')}</Text>

      <Anchor id="company">
        <Field
          required label={text('corp_company')} placeholder={text('corp_company_placeholder')} value={draft.corpCompany} onChangeText={(corpCompany) => updateDraft({ corpCompany })}
          error={companyError}
        />
      </Anchor>

      <Anchor id="employees">
        <Field
          required label={text('corp_employees')} placeholder={text('corp_employees_placeholder')} keyboardType="number-pad" maxLength={5}
          // digits only: a count has no decimal point, sign or letter
          value={draft.corpEmployees} onChangeText={(value) => updateDraft({ corpEmployees: value.replace(/[^0-9]/g, '') })}
          error={employeesError}
        />
      </Anchor>

      <Anchor id="name">
        <Field
          required label={text('corp_employee_name')} placeholder={text('corp_employee_name_placeholder')} value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidName(draft.name) ? text('corp_err_name') : serverError('patientName')}
        />
      </Anchor>

      <Anchor id="gender">
        <FieldLabel required>{t('field_gender')}</FieldLabel>
        <Select value={draft.gender} options={GENDERS} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} labels={genderLabels(t)} keepSize placeholder={t('gender_placeholder')} />
        {attempted && !draft.gender ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : serverError('patientGender') ? <Text className="mt-1 text-[12px] text-danger">{serverError('patientGender')}</Text> : null}
      </Anchor>

      <Anchor id="phone">
        <FieldLabel required>{text('corp_patient_contact')}</FieldLabel>
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
          ? <Text className="mt-1 text-[12px] text-danger">{draft.phone ? text('corp_err_contact') : required}</Text>
          : serverError('patientContact') ? <Text className="mt-1 text-[12px] text-danger">{serverError('patientContact')}</Text> : null}
      </Anchor>

      <Anchor id="programmes">
        <FieldHeader title={text('corp_programmes')} required hint={text('corp_programmes_hint')} />
        <ChoiceChips
          multiple columns={2} label={text('corp_programmes')} value={draft.corpProgrammes} onChange={(corpProgrammes) => updateDraft({ corpProgrammes })}
          options={PROGRAMME_KEYS.map((key) => ({ value: key, label: programmeName(key, t) }))}
        />
        <FieldError>{attempted && draft.corpProgrammes.length === 0 ? text('corp_err_programmes') : serverError('programmes')}</FieldError>
      </Anchor>

      <Anchor id="date">
        <HomeDateField
          required label={text('corp_preferred_date')} value={draft.date} onChange={(date) => updateDraft({ date })}
          error={(attempted || draft.date) && !isValidServiceDate(draft.date) ? (draft.date ? text('corp_err_date') : required) : serverError('preferredDate')}
        />
      </Anchor>

      <Anchor id="address">
        <FieldHeader title={text('corp_office_address')} required hint={`${codePointLength(draft.corpOfficeAddress)}/${ADDRESS_MAX}`} />
        <View className="min-h-[96px] flex-row gap-2.5 rounded-2xl border-[1.5px] border-field bg-white p-3.5">
          <View className="pt-0.5"><Building2 size={18} color="#97A4B8" strokeWidth={2} /></View>
          <MultilineInput
            multiline textAlignVertical="top" value={draft.corpOfficeAddress} onChangeText={(corpOfficeAddress) => updateDraft({ corpOfficeAddress })}
            accessibilityLabel={text('corp_office_address')} placeholder={text('corp_office_address_placeholder')} placeholderTextColor="#97A4B8"
            className="min-h-[72px] flex-1 p-0 font-inter text-[14px] leading-[21px] text-ink"
          />
        </View>
        <FieldError>{addressError}</FieldError>
      </Anchor>

      <Anchor id="country">
        <FieldLabel required>{text('corp_office_country')}</FieldLabel>
        <Pressable
          onPress={() => setPicking('country')} accessibilityRole="button"
          accessibilityLabel={`${text('corp_office_country')}, ${countryDisplay(draft.corpOfficeCountryIso, draft.corpOfficeCountry) || text('corp_office_country_placeholder')}`}
          className="min-h-[48px] flex-row items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3 active:opacity-80"
        >
          <Text className={`flex-1 text-[15px] ${draft.corpOfficeCountry ? '' : 'text-faint'}`} numberOfLines={1}>{countryDisplay(draft.corpOfficeCountryIso, draft.corpOfficeCountry) || text('corp_office_country_placeholder')}</Text>
          <ChevronDown size={16} color="#97A4B8" />
        </Pressable>
        {attempted && !isValidOfficeCountry(draft.corpOfficeCountryIso) ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : serverError('officeCountry') ? <Text className="mt-1 text-[12px] text-danger">{serverError('officeCountry')}</Text> : null}
      </Anchor>

      {/* The phone's code picker only changes the dialling code; the office country has its own picker and its own draft keys, so neither moves the other. */}
      <CountryPicker
        visible={picking === 'phone'} title={t('phone_country_code_label')} selected={draft.phoneCountry}
        onPick={(code) => { setPicking(null); updateDraft(pickRequestPhoneCountry(draft, code)); }} onClose={() => setPicking(null)}
      />
      <CountryPicker
        visible={picking === 'country'} title={text('corp_office_country')} selected={draft.corpOfficeCountryIso}
        onPick={(code) => { setPicking(null); updateDraft({ corpOfficeCountryIso: code, corpOfficeCountry: nameOf(code) }); }} onClose={() => setPicking(null)}
      />
    </RequestFrame>
  );
}
