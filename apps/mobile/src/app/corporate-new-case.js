import { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { errorText } from '../lib/errorText';
import { navReplace } from '../lib/nav';
import { apiPost } from '../lib/api';
import { isValidName, isValidPhone } from '../lib/validators';
import { Body, Screen, TopBar } from '../components/layout';
import { COUNTRY_NAMES } from '../data/mock';
import { countryLabelsByEnglishName } from '../lib/countryNames';
import { Button, CareLevelGrid, Field, FieldLabel, Spacer, Text } from '../components/ui';
import { Select } from '../components/widgets';

const SERVICE_TYPES = ['Air Ambulance', 'Ground Ambulance', 'Hospitalization', 'Medical Escort', 'Mortal Remains', 'Home Healthcare', 'Teleconsultation', 'Corporate Medical'];
// What the person reads for each (the English name is what is sent).
const SERVICE_LABEL_KEYS = { 'Air Ambulance': 'svc_air', 'Ground Ambulance': 'svc_ground', Hospitalization: 'svc_hospital', 'Medical Escort': 'tb_chip_commercial', 'Mortal Remains': 'svc_mortal', 'Home Healthcare': 'svc_homecare', Teleconsultation: 'svc_tele', 'Corporate Medical': 'svc_corporate' };
// Care Level is only asked for patient transport.
const CARE_LEVEL_TYPES = ['Air Ambulance', 'Ground Ambulance'];

export default function CorporateNewCase() {
  const { t, toast, profile } = useApp();
  const [form, setForm] = useState({ name: '', phone: '', service: SERVICE_TYPES[0], origin: '', dest: '', country: '', policy: '', care: 'care_stable', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const ready = isValidName(form.name) && isValidPhone(form.phone);

  const submit = async () => {
    if (!ready) { toast(t('corp_err_case_fields')); return; }
    setBusy(true);
    try {
      const careNote = CARE_LEVEL_TYPES.includes(form.service) && form.care ? `Care level: ${t(form.care)}` : '';
      const notes = [careNote, form.notes].filter(Boolean).join('\n');
      await apiPost('/corporate/cases', {
        patientName: form.name,
        patientContact: form.phone,
        serviceType: form.service,
        origin: form.origin,
        destination: form.dest,
        country: form.country || undefined,
        policyReference: form.policy || undefined,
        notes: notes || undefined,
      });
      toast(t('corp_case_created'));
      navReplace('/corporate-dashboard');
    } catch (err) {
      toast(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <TopBar title={t('new_corporate_case_title')} />
      <Body contentClassName="p-[18px]">
        <Text className="mb-4 text-[13px] text-faint">
          {t('submitting_under_prefix')} <Text className="font-inter-bold text-primary">{profile.name}</Text>
        </Text>
        <View className="gap-3.5">
          <Field
            required label={t('field_patient_name')} placeholder={t('ph_full_legal_name')} value={form.name} onChangeText={(name) => set({ name })}
            error={form.name && !isValidName(form.name) ? t('pd_err_full') : undefined}
          />
          <Field
            required label={t('field_patient_contact_number')} placeholder="98765 43210" keyboardType="phone-pad" value={form.phone} onChangeText={(phone) => set({ phone })}
            error={form.phone && !isValidPhone(form.phone) ? t('err_contact_10') : undefined}
          />
          <View>
            <FieldLabel>{t('field_service_type')}</FieldLabel>
            <Select value={form.service} options={SERVICE_TYPES} labels={Object.fromEntries(SERVICE_TYPES.map((s) => [s, t(SERVICE_LABEL_KEYS[s])]))} keepSize onChange={(service) => set({ service })} title={t('field_service_type')} />
          </View>
          <View className="flex-row gap-2.5">
            <Field className="flex-1" label={t('field_origin')} placeholder={t('ph_city_airport')} value={form.origin} onChangeText={(origin) => set({ origin })} />
            <Field className="flex-1" label={t('field_destination')} placeholder={t('ph_city_hospital')} value={form.dest} onChangeText={(dest) => set({ dest })} />
          </View>
          <View>
            <FieldLabel>{t('field_country')}</FieldLabel>
            <Select value={form.country} options={COUNTRY_NAMES} labels={countryLabelsByEnglishName()} keepSize onChange={(country) => set({ country })} title={t('field_country')} placeholder={t('ph_select_country')} />
          </View>
          <Field label={t('field_policy_gop_ref')} placeholder={t('ph_policy_example')} autoCapitalize="characters" value={form.policy} onChangeText={(policy) => set({ policy })} />
          {CARE_LEVEL_TYPES.includes(form.service) && (
            <View>
              <FieldLabel>{t('field_care_level')}</FieldLabel>
              <Text className="mb-2 text-[11.5px] text-faint">{t('care_level_hint')}</Text>
              <CareLevelGrid value={form.care} onChange={(care) => set({ care })} />
            </View>
          )}
          <Field multiline label={t('field_case_notes')} placeholder={t('ph_case_notes')} value={form.notes} onChangeText={(notes) => set({ notes })} />
        </View>
        <Spacer />
        <Button title={t('btn_create_case')} dimmed={!ready || busy} needsNetwork onPress={submit} className="mt-6" />
      </Body>
    </Screen>
  );
}
