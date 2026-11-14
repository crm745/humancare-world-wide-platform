import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronDown, IdCard, Phone, ShieldCheck, User } from 'lucide-react-native';
import { initialsOf, useApp } from '../state/AppContext';
import { apiGet, apiPatch } from '../lib/api';
import { GENDER_OPTIONS } from '../data/mock';
import { nameOf } from '../lib/phoneCountry';
import { profileFromUser } from '../lib/profile';
import { buildPatch, formFrom, personalRows, validateForm, viewOf } from '../lib/personalDetails';
import { Body, Screen, TopBar } from '../components/layout';
import { Button, Card, Field, FieldLabel, InfoRow, Text } from '../components/ui';
import { Select } from '../components/widgets';
import { CountryPicker } from '../components/NationalityPhone';
import { useSkeletonGate } from '../components/skeleton/hooks';
import { FormSkeleton } from '../components/skeleton/screens';
import { COLORS } from '../theme/colors';

// Personal details (Profile → Personal details): the patient's own account, from GET /auth/me, in four sections:
// Personal Information (editable: name, gender, nationality, through PATCH /auth/me), Contact Information (email and
// mobile, each with a Change action into the existing code-to-the-new-value flow; never edited here), Verification
// Information and Account Information (both read-only). Nothing is shown for a detail the account does not have.

function StatusChip({ ok, t }) {
  return (
    <View className={`rounded-full px-2.5 py-1 ${ok ? 'bg-success-soft' : 'bg-warning-soft'}`}>
      <Text className={`font-inter-black text-[11.5px] uppercase tracking-wide ${ok ? 'text-success' : 'text-warning'}`}>{t(ok ? 'pd_verified' : 'pd_pending')}</Text>
    </View>
  );
}

function SectionCard({ Icon, title, action, children }) {
  return (
    <Card className="mb-5 p-[18px]">
      <View className="mb-1.5 flex-row items-center gap-2.5">
        <View className="h-8 w-8 items-center justify-center rounded-[10px] bg-primary-soft"><Icon size={16} color={COLORS.primary} /></View>
        <Text accessibilityRole="header" className="flex-1 font-inter-black text-[14.5px] text-navy">{title}</Text>
        {action}
      </View>
      {children}
    </Card>
  );
}

// One contact detail with its action: the label, the value, and on the right "Change" (or "Add" when there is no value
// yet), a 44-point target.
function ContactRow({ label, value, onChange, last, t }) {
  return (
    <View className={`flex-row items-center gap-3 py-2.5 ${last ? '' : 'border-b border-divider'}`}>
      <View className="flex-1">
        <Text className="text-[12.5px] text-faint">{label}</Text>
        <Text className="mt-0.5 font-inter-bold text-[14px] text-ink" selectable>{value || '—'}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${t(value ? 'cta_change' : 'cta_add')} ${label}`} onPress={onChange} className="min-h-[44px] justify-center pl-3">
        <Text className="font-inter-bold text-[13.5px] text-primary">{t(value ? 'cta_change' : 'cta_add')}</Text>
      </Pressable>
    </View>
  );
}

export default function PersonalDetails() {
  const { t, toast, isCorporate, setProfile } = useApp();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // The form is not pulled to refresh (an edit in progress must never be lost); it loads with a skeleton and offers Try again.
  const gate = useSkeletonGate(loading);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [picker, setPicker] = useState(false);

  const fetchMe = useCallback(() => apiGet('/auth/me')
    .then(({ user: me }) => {
      if (!me) throw new Error('No personal details for this account.'); // a corporate account answers with corporateUser
      setUser(me);
    })
    .catch((err) => { setFailed(true); toast(err.message); })
    .finally(() => setLoading(false)), [toast]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  useEffect(() => { fetchMe(); }, []);

  const retry = () => {
    setLoading(true);
    setFailed(false);
    fetchMe();
  };

  const view = user ? viewOf(user) : null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const startEdit = () => {
    setForm(formFrom(view));
    setErrors({});
    setSaveError('');
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setPicker(false);
  };

  const save = async () => {
    if (saving) return; // a second tap while the first save is running does nothing
    const found = validateForm(view, form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const patch = buildPatch(view, form);
    if (!Object.keys(patch).length) {
      toast(t('pd_no_changes'));
      setEditing(false);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const { user: updated } = await apiPatch('/auth/me', patch);
      // The answer replaces what is shown, and the app's own copy of the profile (initials, name) follows it.
      setUser(updated);
      setProfile(profileFromUser(updated));
      setEditing(false);
      toast(t('pd_saved'));
    } catch (err) {
      // Nothing is lost: the form keeps what was typed and the account shown is still the saved one.
      setSaveError(err.message);
      toast(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Email and mobile change only through the existing flow: the new value, then a code sent to it. The same for every
  // account (password, Google, Apple); nothing is asked about the old one.
  const goChange = (kind) => router.push({ pathname: '/change-contact', params: { kind } });

  if (isCorporate) {
    return (
      <Screen>
        <TopBar title={t('prof_personal')} />
        <View className="items-center px-5 py-[50px]"><Text className="text-center text-[13px] text-faint">{t('prof_soon')}</Text></View>
      </Screen>
    );
  }

  const rows = view ? personalRows(view) : [];

  return (
    <Screen>
      <TopBar title={t('prof_personal')} />
      <Body contentClassName="px-[18px] py-4">
        {loading && gate.visible ? <FormSkeleton label={t('sk_loading_profile')} fields={6} /> : null}

        {!loading && failed ? (
          <View className="items-center px-5 py-[50px]">
            <Text className="text-center font-inter-bold text-[14px] text-navy">{t('pd_load_failed')}</Text>
            <Button title={t('pd_try_again')} onPress={retry} className="mt-4 min-h-[44px] px-6" />
          </View>
        ) : null}

        {view ? (
          <>
            <View className="mb-5 flex-row items-center gap-3.5">
              <View className="h-[68px] w-[68px] items-center justify-center rounded-[20px] bg-primary-soft">
                <Text className="font-inter-black text-[24px] text-primary-dark">{initialsOf(view.name)}</Text>
              </View>
              <View className="flex-1">
                <Text className="font-inter-black text-[21px] leading-[26px] text-navy">{view.name}</Text>
                <Text className="mt-1 text-[13.5px] text-muted">{t('pd_account_label')}</Text>
              </View>
            </View>

            {/* A. Personal Information */}
            <SectionCard
              Icon={User} title={t('pd_section_personal')}
              action={!editing ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t('pd_edit')} onPress={startEdit} className="min-h-[44px] justify-center pl-3">
                  <Text className="font-inter-bold text-[13.5px] text-primary">{t('pd_edit')}</Text>
                </Pressable>
              ) : null}
            >
              {!editing ? (
                rows.length ? rows.map((row, i) => (
                  <InfoRow
                    key={row.key} last={i === rows.length - 1} label={t(row.labelKey)}
                    value={row.valueKey ? t(row.valueKey) : row.nationality ? (nameOf(row.nationality) || row.nationality) : row.value}
                  />
                )) : <Text className="py-2 text-[13px] text-faint">{t('pd_nothing_yet')}</Text>
              ) : (
                <View className="mt-1.5 gap-4">
                  {view.usesParts ? (
                    <>
                      <Field label={t('field_first_name')} value={form.firstName} onChangeText={(v) => set({ firstName: v })} maxLength={50} autoCapitalize="words" error={errors.firstName ? t(errors.firstName) : undefined} />
                      <Field label={t('field_last_name')} value={form.lastName} onChangeText={(v) => set({ lastName: v })} maxLength={50} autoCapitalize="words" error={errors.lastName ? t(errors.lastName) : undefined} />
                    </>
                  ) : (
                    <Field label={t('field_full_name')} value={form.fullName} onChangeText={(v) => set({ fullName: v })} autoCapitalize="words" error={errors.fullName ? t(errors.fullName) : undefined} />
                  )}
                  <View>
                    <FieldLabel>{t('field_gender')}</FieldLabel>
                    <Select
                      value={form.gender ? t(`gender_${form.gender}`) : ''} options={GENDER_OPTIONS.map((g) => t(`gender_${g}`))} title={t('field_gender')} placeholder={t('gender_placeholder')}
                      onChange={(label) => set({ gender: GENDER_OPTIONS[GENDER_OPTIONS.map((g) => t(`gender_${g}`)).indexOf(label)] })}
                    />
                  </View>
                  <View>
                    <FieldLabel>{t('field_nationality')}</FieldLabel>
                    <Pressable
                      accessibilityRole="button" accessibilityLabel={t('field_nationality')} onPress={() => setPicker(true)}
                      className="min-h-[46px] flex-row items-center justify-between rounded-[10px] border-[1.5px] border-field bg-input px-3"
                    >
                      <Text className={`text-[15px] ${form.nationality ? 'text-ink' : 'text-faint'}`}>{form.nationality ? nameOf(form.nationality) || form.nationality : t('pd_select_nationality')}</Text>
                      <ChevronDown size={16} color="#97A4B8" />
                    </Pressable>
                  </View>
                  {saveError ? <Text className="text-[12.5px] text-danger">{saveError}</Text> : null}
                  <View className="flex-row gap-2.5">
                    <Button variant="ghost" title={t('pd_cancel')} onPress={cancel} disabled={saving} className="flex-1" />
                    <Button title={t('btn_save_changes')} onPress={save} loading={saving} className="flex-1" />
                  </View>
                </View>
              )}
            </SectionCard>

            {/* B. Contact Information */}
            <SectionCard Icon={Phone} title={t('pd_section_contact')}>
              <ContactRow label={t('field_email_address')} value={view.email} onChange={() => goChange('email')} t={t} />
              <ContactRow last label={t('field_mobile_number')} value={view.mobile.text} onChange={() => goChange('mobile')} t={t} />
            </SectionCard>

            {/* C. Verification Information */}
            <SectionCard Icon={ShieldCheck} title={t('pd_section_verify')}>
              <InfoRow label={t('pd_email_verification')} valueNode={<StatusChip ok={view.emailVerified} t={t} />} />
              {!view.emailVerified ? <Text className="pb-2 text-[12.5px] leading-[18px] text-muted">{t('pd_email_pending_note')}</Text> : null}
              <InfoRow last label={t('pd_account_verification')} valueNode={<StatusChip ok={view.accountVerified} t={t} />} />
            </SectionCard>

            {/* D. Account Information */}
            <SectionCard Icon={IdCard} title={t('pd_section_account')}>
              <InfoRow label={t('pd_account_type')} value={t('pd_patient')} last={!view.memberSince} />
              {view.memberSince ? <InfoRow last label={t('pd_member_since')} value={view.memberSince} /> : null}
            </SectionCard>
          </>
        ) : null}
      </Body>

      <CountryPicker
        visible={picker} title={t('field_nationality')} selected={form ? form.nationality : ''}
        onPick={(code) => { set({ nationality: code }); setPicker(false); }} onClose={() => setPicker(false)}
      />
    </Screen>
  );
}
