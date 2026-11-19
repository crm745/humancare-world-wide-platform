import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import { nameOf } from '../../lib/phoneCountry';
import { locationProblems } from '../../lib/locationRules';
import { pickRequestCountry, pickRequestPhoneCountry } from '../../lib/requestForm';
import { isValidMobileNumber, isValidName } from '../../lib/validators';
import { codePointLength } from '../../lib/teleConsultation';
import {
  AGE_MAX, MORTAL_GENDERS, MORTAL_MODES, MORTAL_MODE_LABEL_KEYS, MORTAL_RELATIONS, MORTAL_SCOPES, MORTAL_SCOPE_LABEL_KEYS, PLACE_MAX,
  isValidDeathDate, isValidMortalAge, isValidTransferDate, mortalStep1Problems,
} from '../../lib/mortalRemains';
import { CountryPicker } from '../NationalityPhone';
import CityField from './CityField';
import { Anchor, RequestFrame } from './RequestFrame';
import { ChoiceChips, FieldError, FieldHeader } from './fields';
import { MortalDateField } from './MortalDateField';
import { Field, FieldLabel, Input, Text } from '../ui';
import { Select } from '../widgets';

// Step 1 of 3 for Mortal Remains Transportation: the two separate choices (Transfer Scope and Transport Mode, six combinations, neither
// preselected), then the deceased person and the trip. Used by app/request/step1.js when the chosen service is "mortal"; every other service
// keeps its own Step 1. The rules are in lib/mortalRemains.js (the contract with the server).
export function MortalStep1() {
  const { t, draft, updateDraft } = useApp();
  // Flips true the first time Continue is tapped while something required is still blank (no red borders on a form not yet started).
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(null); // 'country' | 'phone' | null
  const problems = mortalStep1Problems(draft);
  const wrong = Object.fromEntries(problems);
  const firstError = () => problems.find(([, bad]) => bad)?.[0] || null;
  const required = t('req_required');
  const relationLabels = Object.fromEntries(MORTAL_RELATIONS.map((r) => [r, t(`rd_rel_${r.toLowerCase()}`)]));
  const places = locationProblems(draft, false);
  const tooLong = (text) => (codePointLength(String(text || '').trim()) > PLACE_MAX ? t('mortal_err_too_long', { max: PLACE_MAX }) : null);

  // Each location is judged on its own (lib/locationRules.js). A city from another country is said at once; the rest waits for a Continue tap.
  const locationError = (problem, text) => {
    if (problem === 'wrong_country') return `This city is not in ${draft.country}. Pick a city in ${draft.country}, or change the country.`;
    if (problem && !attempted) return undefined;
    if (problem === 'required') return required;
    return tooLong(text) || undefined;
  };

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical"
    >
      <Anchor id="scope">
        <FieldHeader title={t('field_mortal_scope')} required />
        <ChoiceChips
          columns={2} label={t('field_mortal_scope')} value={draft.transferScope} onChange={(transferScope) => updateDraft({ transferScope })}
          options={MORTAL_SCOPES.map((key) => ({ value: key, label: t(MORTAL_SCOPE_LABEL_KEYS[key]) }))}
        />
        <FieldError>{attempted && wrong.scope ? required : null}</FieldError>
      </Anchor>

      <Anchor id="mode">
        <FieldHeader title={t('field_mortal_mode')} required />
        <ChoiceChips
          columns={1} label={t('field_mortal_mode')} value={draft.transportMode} onChange={(transportMode) => updateDraft({ transportMode })}
          options={MORTAL_MODES.map((key) => ({ value: key, label: t(MORTAL_MODE_LABEL_KEYS[key]) }))}
        />
        <FieldError>{attempted && wrong.mode ? required : null}</FieldError>
      </Anchor>

      <Text className="font-inter-black text-[17px] text-navy">{t('step1_heading_mortal')}</Text>

      <Anchor id="name">
        <Field
          required label={t('field_deceased_name')} placeholder={t('field_deceased_name_placeholder')}
          value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidName(draft.name) ? 'Enter a valid name.' : undefined}
        />
      </Anchor>

      <Anchor id="age">
        <View className="flex-row gap-2.5">
          <Field
            required className="flex-1" label={t('field_deceased_age')} placeholder="Age" keyboardType="number-pad" maxLength={3}
            value={draft.age} onChangeText={(age) => updateDraft({ age })}
            error={(attempted || draft.age) && !isValidMortalAge(draft.age) ? t('mortal_err_age', { max: AGE_MAX }) : undefined}
          />
          <View className="flex-1">
            <FieldLabel required>{t('field_gender')}</FieldLabel>
            <Select value={draft.gender} options={MORTAL_GENDERS} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} placeholder="Select gender" />
            {attempted && !draft.gender ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
          </View>
        </View>
      </Anchor>

      <Anchor id="relation">
        <FieldLabel required>{t('field_relation')}</FieldLabel>
        <Select value={draft.relation} options={MORTAL_RELATIONS} labels={relationLabels} onChange={(relation) => updateDraft({ relation })} title={t('field_relation')} placeholder="Select relation" />
        {attempted && !draft.relation ? <Text className="mt-1 text-[12px] text-danger">{required}</Text> : null}
      </Anchor>

      <Anchor id="deathPlace">
        <Field
          required label={t('field_place_of_death')} placeholder="Hospital or place, City, Country" value={draft.deathPlace} onChangeText={(deathPlace) => updateDraft({ deathPlace })}
          error={attempted && !draft.deathPlace.trim() ? required : tooLong(draft.deathPlace) || undefined}
        />
      </Anchor>

      <Anchor id="deathDate">
        <MortalDateField
          required past label={t('field_date_of_death')} value={draft.deathDate} onChange={(deathDate) => updateDraft({ deathDate })}
          error={(attempted || draft.deathDate) && !isValidDeathDate(draft.deathDate) ? (draft.deathDate ? t('mortal_err_death_date') : required) : undefined}
        />
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

      <Anchor id="location">
        <CityField
          required label={t('field_location')} testID="origin-city" structured={false}
          value={draft.location} city={draft.originCity}
          countryIso={draft.countryIso} countryName={draft.country} restrictToCountry
          onChangeText={(location) => updateDraft({ location, originCity: null })}
          onSelect={(city) => updateDraft({ originCity: city, location: city.label })}
          error={locationError(places.location, draft.location)}
        />
      </Anchor>

      <Anchor id="dest">
        <CityField
          required label={t('field_destination')} testID="destination-city" structured={false}
          value={draft.dest} city={draft.destCity}
          onChangeText={(dest) => updateDraft({ dest, destCity: null })}
          onSelect={(city) => updateDraft({ destCity: city, dest: city.label })}
          error={locationError(places.dest, draft.dest)}
        />
      </Anchor>

      <Anchor id="date">
        <MortalDateField
          required label={t('field_transfer_date')} value={draft.date} onChange={(date) => updateDraft({ date })}
          error={(attempted || draft.date) && !isValidTransferDate(draft.date) ? (draft.date ? t('mortal_err_transfer_date') : required) : undefined}
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
