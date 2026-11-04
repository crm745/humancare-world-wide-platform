import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar } from 'lucide-react-native';
import { useApp } from '../../state/AppContext';
import {
  AIRLINE_MODES, AIRLINE_MODE_LABELS, COUNTRY_CODES, COUNTRY_CODE_LABELS, COUNTRY_NAMES, DECEASED_RELATIONS, MORTAL_TRANSFERS, MORTAL_TRANSFER_LABELS,
  isMortal, needsAirlineMode,
} from '../../data/mock';
import { isValidAge, isValidDateString, isValidName, isValidPhoneForCountry } from '../../lib/validators';
import { Anchor, RequestFrame } from '../../components/request/RequestFrame';
import { Field, FieldLabel, Input, Text } from '../../components/ui';
import { Select, Sheet } from '../../components/widgets';

function dateStringToObj(value) {
  if (value && isValidDateString(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}
function dateObjToString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// A transfer can't be scheduled for a date that's already passed; a date of death
// (`past` fields) can't be in the future.
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const isNotFuture = (value) => isValidDateString(value) && value <= dateObjToString(new Date());

// Replaces free-typed "YYYY-MM-DD" (easy to fumble mid-emergency — "20/11/2026"
// trips the validator) with a native calendar. Android shows its own picker dialog
// on demand; iOS has no built-in dialog chrome for the spinner, so that one is
// wrapped in the existing Sheet component with a Done button.
// @react-native-community/datetimepicker is native-only (no web implementation at
// all), so on web its spinner silently renders nothing — just an empty sheet. The
// browser already has a perfectly good native date input, so we use that there
// instead of pulling in a whole separate calendar-widget dependency just for web.
function WebDateField({ label, required, value, onChange, error, past }) {
  return (
    <View>
      <FieldLabel required={required}>{label}</FieldLabel>
      {/* eslint-disable-next-line react/no-unknown-property -- plain DOM <input>, web-only branch */}
      <input
        type="date"
        required={required}
        value={value || ''}
        min={past ? undefined : dateObjToString(TODAY)}
        max={past ? dateObjToString(TODAY) : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          borderRadius: 10,
          border: '1.5px solid #E1E7F0',
          background: '#F7F9FC',
          padding: '12px',
          fontSize: 15,
          color: value ? '#17233D' : '#97A4B8',
          fontFamily: 'inherit',
        }}
      />
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}
    </View>
  );
}

function DateField({ label, required, value, onChange, error, past }) {
  const [open, setOpen] = useState(false);
  const limits = past ? { maximumDate: TODAY } : { minimumDate: TODAY };

  if (Platform.OS === 'web') {
    return <WebDateField label={label} required={required} value={value} onChange={onChange} error={error} past={past} />;
  }

  const handleAndroidChange = (event, selected) => {
    setOpen(false);
    if (event.type === 'dismissed' || !selected) return;
    onChange(dateObjToString(selected));
  };

  return (
    <View>
      <FieldLabel required={required}>{label}</FieldLabel>
      <Pressable
        onPress={() => setOpen(true)}
        className="flex-row items-center justify-between gap-1 rounded-[10px] border-[1.5px] border-field bg-input px-3 py-3"
      >
        <Text className={`text-[15px] ${value ? 'text-ink' : 'text-faint'}`}>{value || 'Select a date'}</Text>
        <Calendar size={16} color="#97A4B8" />
      </Pressable>
      {error ? <Text className="mt-1 text-[12px] text-danger">{error}</Text> : null}

      {Platform.OS === 'android' && open && (
        <DateTimePicker value={dateStringToObj(value)} mode="date" {...limits} onChange={handleAndroidChange} />
      )}

      {Platform.OS !== 'android' && (
        <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
          <DateTimePicker
            value={dateStringToObj(value)}
            mode="date"
            display="spinner"
            {...limits}
            onChange={(_event, selected) => selected && onChange(dateObjToString(selected))}
          />
          <Pressable onPress={() => setOpen(false)} className="mt-4 items-center rounded-xl bg-primary py-3.5">
            <Text className="font-inter-bold text-[15px] text-white">Done</Text>
          </Pressable>
        </Sheet>
      )}
    </View>
  );
}

function SectionHeading({ children, first }) {
  return <Text className={`font-inter-black text-[17px] text-navy ${first ? '' : 'mt-3'}`}>{children}</Text>;
}

// Step 1 of 3: the patient and the trip. For Mortal Remains the same page asks about the
// deceased instead, in calmer wording. What the person needs, and how to word it, comes on
// the next page.
export default function RequestStep1() {
  const { t, draft, updateDraft } = useApp();
  const mortal = isMortal(draft.service);
  // Flips true the first time Continue is tapped while something required is still blank;
  // before that, an untouched required field shows no error (nobody wants red borders on a
  // form they haven't started filling in yet).
  const [attempted, setAttempted] = useState(false);

  // What is wrong, in page order. The first one is where the page scrolls to.
  const problems = [
    ['name', !isValidName(draft.name)],
    ['age', draft.age.trim() === '' || !isValidAge(draft.age) || !draft.gender],
    ...(mortal ? [['relation', !draft.relation], ['deathPlace', !draft.deathPlace.trim()], ['deathDate', !isNotFuture(draft.deathDate)]] : []),
    ['location', !draft.location.trim()],
    ['country', !draft.country],
    ['dest', !draft.dest.trim()],
    ['phone', !isValidPhoneForCountry(draft.phone, draft.cc)],
    ['date', !isValidDateString(draft.date)],
    ...(needsAirlineMode(draft.service) ? [['airlineMode', !draft.airlineMode]] : []),
    ...(mortal ? [['mortalTransfer', !draft.mortalTransfer]] : []),
  ];
  const firstError = () => problems.find(([, wrong]) => wrong)?.[0] || null;

  return (
    <RequestFrame
      step={1} firstError={firstError} onInvalid={() => setAttempted(true)} onNext={() => router.push('/request/step2')}
      nextKey="req_next_medical" hintKey="req_hint_step1"
    >
      <SectionHeading first>{t(mortal ? 'step1_heading_mortal' : 'step1_heading')}</SectionHeading>
      <Anchor id="name">
        <Field
          required label={t(mortal ? 'field_deceased_name' : 'field_patient_name')} placeholder={mortal ? 'Full name of the deceased' : "Enter patient's full name"}
          value={draft.name} onChangeText={(name) => updateDraft({ name })}
          error={(attempted || draft.name) && !isValidName(draft.name) ? 'Enter a valid name.' : undefined}
        />
      </Anchor>
      <Anchor id="age">
        <View className="flex-row gap-2.5">
          <Field
            required className="flex-1" label={t(mortal ? 'field_deceased_age' : 'field_age')} placeholder="Age" keyboardType="number-pad" value={draft.age} onChangeText={(age) => updateDraft({ age })}
            error={(attempted || draft.age) && (!draft.age.trim() || !isValidAge(draft.age)) ? 'Enter a valid age.' : undefined}
          />
          <View className="flex-1">
            <FieldLabel required>{t('field_gender')}</FieldLabel>
            <Select value={draft.gender} options={['Male', 'Female', 'Other']} onChange={(gender) => updateDraft({ gender })} title={t('field_gender')} placeholder="Select gender" />
            {attempted && !draft.gender ? <Text className="mt-1 text-[12px] text-danger">This field is required.</Text> : null}
          </View>
        </View>
      </Anchor>
      {mortal && (
        <>
          <Anchor id="relation">
            <FieldLabel required>{t('field_relation')}</FieldLabel>
            <Select value={draft.relation} options={DECEASED_RELATIONS} onChange={(relation) => updateDraft({ relation })} title={t('field_relation')} placeholder="Select relation" />
            {attempted && !draft.relation ? <Text className="mt-1 text-[12px] text-danger">This field is required.</Text> : null}
          </Anchor>
          <Anchor id="deathPlace">
            <Field
              required label={t('field_place_of_death')} placeholder="Hospital or place, City, Country" value={draft.deathPlace} onChangeText={(deathPlace) => updateDraft({ deathPlace })}
              error={attempted && !draft.deathPlace.trim() ? 'This field is required.' : undefined}
            />
          </Anchor>
          <Anchor id="deathDate">
            <DateField
              required past label={t('field_date_of_death')} value={draft.deathDate} onChange={(deathDate) => updateDraft({ deathDate })}
              error={(attempted || draft.deathDate) && !isNotFuture(draft.deathDate) ? 'Enter a valid date.' : undefined}
            />
          </Anchor>
        </>
      )}
      <Anchor id="location">
        <Field
          required label={t('field_location')} placeholder="City, Country" value={draft.location} onChangeText={(location) => updateDraft({ location })}
          error={attempted && !draft.location.trim() ? 'This field is required.' : undefined}
        />
      </Anchor>
      <Anchor id="country">
        <FieldLabel required>{t('field_country')}</FieldLabel>
        <Select value={draft.country} options={COUNTRY_NAMES} onChange={(country) => updateDraft({ country })} title={t('field_country')} placeholder="Select country" />
        {attempted && !draft.country ? <Text className="mt-1 text-[12px] text-danger">This field is required.</Text> : null}
      </Anchor>
      <Anchor id="dest">
        <Field
          required label={t('field_destination')} placeholder="City, Country" value={draft.dest} onChangeText={(dest) => updateDraft({ dest })}
          error={attempted && !draft.dest.trim() ? 'This field is required.' : undefined}
        />
      </Anchor>
      <Anchor id="phone">
        <FieldLabel required>{t('field_contact_number')}</FieldLabel>
        <View className="flex-row gap-2">
          <Select value={draft.cc} options={COUNTRY_CODES} labels={COUNTRY_CODE_LABELS} onChange={(cc) => updateDraft({ cc })} title={t('field_contact_number')} className="w-28" />
          <Input className="flex-1" placeholder="Enter number" keyboardType="phone-pad" value={draft.phone} onChangeText={(phone) => updateDraft({ phone })} />
        </View>
        {(attempted || draft.phone) && !isValidPhoneForCountry(draft.phone, draft.cc) ? <Text className="mt-1 text-[12px] text-danger">{draft.phone ? 'Enter a valid number for the selected country.' : 'This field is required.'}</Text> : null}
      </Anchor>
      <Anchor id="date">
        <DateField
          required label={t(mortal ? 'field_transfer_date' : 'field_preferred_date')} value={draft.date} onChange={(date) => updateDraft({ date })}
          error={(attempted || draft.date) && !isValidDateString(draft.date) ? 'Enter a valid date.' : undefined}
        />
      </Anchor>
      {needsAirlineMode(draft.service) && (
        <Anchor id="airlineMode">
          <FieldLabel required>{t('field_airline_mode')}</FieldLabel>
          <Select
            value={draft.airlineMode} options={AIRLINE_MODES} labels={AIRLINE_MODE_LABELS}
            onChange={(airlineMode) => updateDraft({ airlineMode })} title={t('field_airline_mode')} placeholder="Stretcher or wheelchair"
          />
          {attempted && !draft.airlineMode ? <Text className="mt-1 text-[12px] text-danger">This field is required.</Text> : null}
        </Anchor>
      )}
      {mortal && (
        <Anchor id="mortalTransfer">
          <FieldLabel required>{t('field_mortal_transfer')}</FieldLabel>
          <Select
            value={draft.mortalTransfer} options={MORTAL_TRANSFERS} labels={MORTAL_TRANSFER_LABELS}
            onChange={(mortalTransfer) => updateDraft({ mortalTransfer })} title={t('field_mortal_transfer')} placeholder="Within India or International"
          />
          {attempted && !draft.mortalTransfer ? <Text className="mt-1 text-[12px] text-danger">This field is required.</Text> : null}
        </Anchor>
      )}
    </RequestFrame>
  );
}
