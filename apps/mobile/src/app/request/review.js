import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { needsCareLevel, useApp } from '../../state/AppContext';
import SERVICES from '../../data/services.json';
import { EQUIPMENT_OPTIONS, SOURCE_OTHER, isMortal, requestService } from '../../data/mock';
import { navReplace } from '../../lib/nav';
import { apiPost, apiUpload } from '../../lib/api';
import { goToStep, RequestFrame } from '../../components/request/RequestFrame';
import { InfoRow, SectionLabel, Text } from '../../components/ui';

// One block of the summary, with a link that goes back to where its answers were given.
function Section({ title, rows, onEdit, editLabel }) {
  const shown = rows.filter(([, value]) => value !== undefined);
  return (
    <View className="rounded-2xl border border-line bg-white px-3.5 pb-1.5 pt-3">
      <View className="flex-row items-center justify-between">
        <SectionLabel>{title}</SectionLabel>
        <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`${editLabel}: ${title}`} className="-mr-2 -mt-3 min-h-[44px] justify-center px-2 active:opacity-70">
          <Text className="font-inter-bold text-[13px] text-primary">{editLabel}</Text>
        </Pressable>
      </View>
      <View className="-mt-2">
        {shown.map(([label, value], i) => <InfoRow key={label} label={label} value={value || '—'} last={i === shown.length - 1} />)}
      </View>
    </View>
  );
}

// Step 3 of 3: check everything, then submit.
export default function RequestReview() {
  const { t, draft: d, updateDraft, toast } = useApp();
  const [busy, setBusy] = useState(false);
  // null while the files are not uploading; otherwise which file, out of how many, and how far.
  const [uploading, setUploading] = useState(null);
  const source = d.source === SOURCE_OTHER && d.sourceOther.trim() ? `${SOURCE_OTHER}: ${d.sourceOther.trim()}` : d.source;
  const { title: serviceTitle, key: serviceKey } = requestService(d, SERVICES);
  const mortal = isMortal(d.service);
  const transport = needsCareLevel(d.service);
  const onBoard = EQUIPMENT_OPTIONS.filter(([field]) => d[field]).map(([, , labelKey]) => t(labelKey)).join(', ');

  const changeService = () => {
    updateDraft({ changingService: true });
    router.push('/all-services');
  };

  const submit = async () => {
    setBusy(true);
    try {
      const { request } = await apiPost('/requests', {
        serviceType: serviceTitle,
        serviceKey,
        patientName: d.name,
        patientAge: d.age || undefined,
        patientGender: d.gender,
        patientLocation: d.location,
        patientContact: d.phone ? `${d.cc} ${d.phone}` : undefined,
        origin: d.location,
        destination: d.dest,
        country: d.country || undefined,
        preferredDate: d.date || undefined,
        careLevel: transport && d.care.length ? d.care.map(t).join(', ') : undefined,
        description: d.desc || undefined, // "Condition & diagnosis" (or the Mortal Remains details)
        additionalInfo: d.extra || undefined, // kept in our database only, not sent to Bitrix
        specialRequirements: d.special || undefined,
        // Only patient transport has these; the server refuses them for any other service.
        ...(transport ? {
          mobility: d.mobility,
          equipOxygen: d.equipOxygen,
          equipCardiacMonitor: d.equipCardiac,
          equipVentilator: d.equipVentilator,
        } : {}),
        urgency: d.urgency || undefined,
        ...(mortal ? { deceasedRelation: d.relation, placeOfDeath: d.deathPlace, dateOfDeath: d.deathDate } : {}),
        referralSource: source || undefined,
      });

      // The request is saved, so a file that fails to upload must not undo it: carry on with
      // the others and say how many did not go.
      let failed = 0;
      for (let i = 0; i < d.files.length; i += 1) {
        setUploading({ index: i + 1, total: d.files.length, progress: 0 });
        try {
          await apiUpload(`/requests/me/${request.id}/documents`, d.files[i], false, (progress) => setUploading({ index: i + 1, total: d.files.length, progress }));
        } catch {
          failed += 1;
        }
      }
      setUploading(null);
      if (failed) toast(t('req_upload_failed').replace('{n}', failed));

      navReplace({ pathname: '/request/submitted', params: { id: request.referenceNumber, requestId: request.id, service: serviceTitle } });
    } catch (err) {
      setUploading(null);
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const edit = t('req_edit');
  // While files upload the button itself says how far it is: nothing sits under the button.
  const label = uploading
    ? t('req_uploading').replace('{i}', uploading.index).replace('{n}', uploading.total).replace('{p}', Math.round(uploading.progress * 100))
    : undefined;

  return (
    <RequestFrame step={3} showService={false} onNext={submit} busy={busy} nextKey="req_submit" label={label}>
      <Text className="text-center text-[13.5px] text-muted">{t('review_sub')}</Text>
      <Section title={t('lbl_service')} onEdit={changeService} editLabel={t('req_change')} rows={[[t('lbl_service'), serviceTitle]]} />
      <Section
        title={t(mortal ? 'step1_heading_mortal' : 'step1_heading')} onEdit={() => goToStep(1)} editLabel={edit}
        rows={[
          [t(mortal ? 'lbl_deceased_name' : 'lbl_patient_name'), d.name],
          [t(mortal ? 'lbl_age_gender_plain' : 'lbl_age_gender'), `${d.age || '—'} Y / ${d.gender}`],
          ...(mortal ? [[t('lbl_relation'), d.relation], [t('field_place_of_death'), d.deathPlace], [t('field_date_of_death'), d.deathDate]] : []),
          [t('field_contact_number'), d.phone && `${d.cc} ${d.phone}`],
        ]}
      />
      <Section
        title={t('req_trip')} onEdit={() => goToStep(1)} editLabel={edit}
        rows={[
          [t('field_country'), d.country],
          [t('lbl_location'), d.location],
          [t('field_destination'), d.dest],
          [t(mortal ? 'field_transfer_date' : 'field_preferred_date'), d.date],
        ]}
      />
      <Section
        title={t('req_medical')} onEdit={() => goToStep(2)} editLabel={edit}
        rows={[
          [t(mortal ? 'req_details' : 'req_condition'), d.desc],
          ...(transport ? [
            [t('field_care_level'), d.care.map(t).join(', ')],
            [t('req_mobility'), d.mobility ? t(`mobility_${d.mobility}`) : ''],
            [t('req_on_board'), onBoard || t('req_none')],
          ] : []),
          [t('req_urgency'), d.urgency ? t(`urgency_${d.urgency}`) : ''],
        ]}
      />
      <Section
        title={t(mortal ? 'req_documents' : 'req_reports')} onEdit={() => goToStep(2)} editLabel={edit}
        rows={[[t(mortal ? 'lbl_death_certificate' : 'lbl_medical_report'), d.files.length ? d.files.map((f) => f.name).join(', ') : t('req_not_attached')]]}
      />
      {(d.extra || d.special || source) ? (
        <Section
          title={t('req_more_details')} onEdit={() => goToStep(2)} editLabel={edit}
          rows={[
            ...(d.extra ? [[t('lbl_extra_info'), d.extra]] : []),
            ...(d.special ? [[t('lbl_special_requirements'), d.special]] : []),
            ...(source ? [[t('lbl_heard_about_us'), source]] : []),
          ]}
        />
      ) : null}
    </RequestFrame>
  );
}
