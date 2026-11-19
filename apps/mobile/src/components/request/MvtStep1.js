import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { nameOf } from '../../lib/phoneCountry';
import { pickRequestCountry, pickRequestPhoneCountry } from '../../lib/requestForm';
import { isValidMobileNumber } from '../../lib/validators';
import {
  AGE_MAX, CITY_MAX, GENDERS, MVT_SCOPES, cityErrorMessage, cityProblems, defaultCountryIso, freeTextProblem, isValidMvtAge, isValidMvtName, mvtStep1Problems, mvtText,
  textErrorMessage,
} from '../../lib/medicalValueTravel';
import { CountryPicker } from '../NationalityPhone';
import CityField from './CityField';
import { Anchor, RequestFrame } from './RequestFrame';
import { Field, FieldLabel, Input, Text } from '../ui';
import { Select } from '../widgets';

// Step 1 of 3 for Medical Value Travel: the Treatment Scope (Domestic or International), the patient, the Country, the contact number and the Current and
// Destination Cities (suggestions from the verified list, or typed by hand when a city is not listed). The treatment itself (date, specialty, Medical
// History, reports) is Step 2. Used by app/request/step1.js when the chosen service is "medvalue"; every other service keeps its own Step 1.
// The rules are in lib/medicalValueTravel.js (the contract with the server). A typed city is sent exactly as typed and is never treated as verified.
export function MvtStep1() {
  const { t, draft, updateDraft, profile } = useApp();
  // Flips true the first time Continue is tapped while something required is still blank (no red borders on a form not yet started).
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(null); // 'country' | 'phone' | null
  const problems = mvtStep1Problems(draft);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = t('req_required');
  const places = cityProblems({ scope: draft.treatmentScope, countryIso: draft.countryIso, location: draft.location, originCity: draft.originCity, dest: draft.dest, destCity: draft.destCity });
  const scopeLabels = Object.fromEntries(MVT_SCOPES.map((scope) => [scope, mvtText(t, `mvt_scope_${scope}`)]));

  // The Country starts as the account's Nationality, else the country of its phone number; with neither it stays empty and the person picks one. Only
  // while nothing has been chosen: once a country is set (by default or by hand) it is never overwritten.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current) return;
    defaulted.current = true;
    if (draft.countryIso) return;
    const iso = defaultCountryIso(profile);
    if (iso) updateDraft(pickRequestCountry(draft, iso));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the default is applied once, when the form opens
  }, []);

  const cityTextError = (text) => textErrorMessage(freeTextProblem(text, { max: CITY_MAX, oneLine: true }), t, { max: CITY_MAX, attempted: false });

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical"
    >
      <Text className="font-inter-black text-[17px] text-navy">{t('step1_heading')}</Text>

      <Anchor id="scope">
        <FieldLabel required>{mvtText(t, 'mvt_scope')}</FieldLabel>
        <Select
          value={draft.treatmentScope} options={MVT_SCOPES} labels={scopeLabels} onChange={(treatmentScope) => updateDraft({ treatmentScope })}
          title={mvtText(t, 'mvt_scope')} placeholder={mvtText(t, 'mvt_scope_placeholder')}
        />
        {attempted && !draft.treatmentScope ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
      </Anchor>

      <Anchor id="name">
        <Field
          required label={t('field_patient_name')} placeholder="Enter patient's full name" value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidMvtName(draft.name) ? 'Enter a valid name.' : undefined}
        />
      </Anchor>

      <Anchor id="age">
        <View className="flex-row gap-2.5">
          <Field
            required className="flex-1" label={t('field_age')} placeholder="Age" keyboardType="number-pad" maxLength={3}
            value={draft.age} onChangeText={(age) => updateDraft({ age })}
            error={(attempted || draft.age) && !isValidMvtAge(draft.age) ? mvtText(t, 'mvt_err_age', { max: AGE_MAX }) : undefined}
          />
          <View className="flex-1">
            <FieldLabel required>{t('field_gender')}</FieldLabel>
            <Select value={draft.gender} options={GENDERS} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} placeholder="Select gender" />
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
        {attempted && !draft.countryIso ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
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

      <Anchor id="location">
        <CityField
          required label={mvtText(t, 'mvt_current_city')} testID="origin-city" structured={false}
          value={draft.location} city={draft.originCity}
          countryIso={draft.countryIso} countryName={draft.country} restrictToCountry
          onChangeText={(location) => updateDraft({ location, originCity: null })}
          onSelect={(city) => updateDraft({ originCity: city, location: city.label })}
          error={cityErrorMessage(places.location, 'location', t, { attempted, countryName: draft.country }) || cityTextError(draft.location)}
        />
      </Anchor>

      <Anchor id="dest">
        <CityField
          required label={mvtText(t, 'mvt_destination_city')} testID="destination-city" structured={false}
          value={draft.dest} city={draft.destCity}
          // A Domestic destination is held to the selected country (only its cities are suggested); an International one may be anywhere else.
          {...(draft.treatmentScope === 'domestic' ? { countryIso: draft.countryIso, countryName: draft.country, restrictToCountry: true } : {})}
          onChangeText={(dest) => updateDraft({ dest, destCity: null })}
          onSelect={(city) => updateDraft({ destCity: city, dest: city.label })}
          error={cityErrorMessage(places.dest, 'dest', t, { attempted, countryName: draft.country }) || cityTextError(draft.dest)}
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
