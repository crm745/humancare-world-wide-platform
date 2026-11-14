import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { needsCareLevel, useApp } from '../../state/AppContext';
import SERVICES from '../../data/services.json';
import { isMortal, requestService } from '../../data/mock';
import { navReplace } from '../../lib/nav';
import { apiPost, apiUpload } from '../../lib/api';
import { runSubmission } from '../../lib/requestUploads';
import {
  buildPrivateCharterPayload, fieldErrorsFromError, firstErrorLocation, isPrivateCharter, needsDocument, unplacedMessages,
} from '../../lib/privateCharter';
import { goToStep, RequestFrame } from '../../components/request/RequestFrame';
import { Card, FONT } from '../../components/request/DetailsParts';
import { DocumentRow, MedicalCard, PatientGrid, Trip } from '../../components/request/DetailsBlocks';
import { ReviewSection, ServiceCard } from '../../components/request/ReviewParts';
import { reviewView } from '../../lib/reviewView';

// Step 3 of 3: check everything, then submit.
export default function RequestReview() {
  const { t, draft: d, updateDraft, toast, setServerErrors } = useApp();
  const [busy, setBusy] = useState(false);
  // null while the files are not uploading; otherwise which file, out of how many, and how far.
  const [uploading, setUploading] = useState(null);
  const { title: serviceTitle, key: serviceKey } = requestService(d, SERVICES);
  const transport = needsCareLevel(d.service);
  const mortal = isMortal(d.service);

  const changeService = () => {
    updateDraft({ changingService: true });
    router.push('/all-services');
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (isPrivateCharter(d.service)) {
        // At least one document is required: nothing is sent (and no request is saved) without one.
        if (needsDocument(d)) {
          toast('Upload at least one document to submit this request.');
          goToStep(2);
          return;
        }
        // Private Charter is sent exactly as the server's validator expects it (see lib/privateCharter).
        // The request is saved once; a file that fails stays pending (the next screen says which and
        // offers a retry) and the answers and chosen files are kept (see lib/requestUploads).
        const result = await runSubmission({
          sentRequest: d.sentRequest, uploaded: d.uploaded, uploadErrors: d.uploadErrors, files: d.files,
          createRequest: async () => {
            const { request } = await apiPost('/requests', buildPrivateCharterPayload(d));
            return { id: request.id, referenceNumber: request.referenceNumber, title: serviceTitle };
          },
          upload: (file, onProgress, sent) => apiUpload(`/requests/me/${sent.id}/documents`, file, false, onProgress),
          onSent: updateDraft,
          onProgress: setUploading,
        });
        updateDraft(result);
        setUploading(null);
        navReplace({ pathname: '/request/submitted', params: { id: result.sentRequest.referenceNumber, requestId: result.sentRequest.id, service: serviceTitle } });
        return;
      }
      // Every other service keeps the body it has always sent.
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
        // Only patient transport has these; the server refuses them for any other service.
        ...(transport ? {
          mobility: d.mobility,
          equipOxygen: d.equipOxygen,
          equipCardiacMonitor: d.equipCardiac,
          equipVentilator: d.equipVentilator,
        } : {}),
        urgency: d.urgency || undefined,
        ...(mortal ? { deceasedRelation: d.relation, placeOfDeath: d.deathPlace, dateOfDeath: d.deathDate } : {}),
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
      // The server refused a field: the form is left exactly as it was, each message goes under its
      // field, and the person is taken to the first step that has one.
      const fields = fieldErrorsFromError(err);
      if (fields) {
        setServerErrors(fields);
        const { step } = firstErrorLocation(fields);
        const other = unplacedMessages(fields);
        toast(other.length ? other[0] : err.message);
        if (step) goToStep(step);
      } else {
        toast(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  // While files upload the button itself says how far it is: nothing sits under the button.
  const label = uploading
    ? t('req_uploading').replace('{i}', uploading.index).replace('{n}', uploading.total).replace('{p}', Math.round(uploading.progress * 100))
    : undefined;

  // What is shown: worked out in lib/reviewView.js (empty fields and empty sections are left out). Each Edit goes to the step that holds that
  // section, as before; Change picks another service from the form.
  const view = reviewView(d, { key: serviceKey, title: serviceTitle }, t);

  return (
    <RequestFrame step={3} showService={false} onNext={submit} busy={busy} nextKey="req_submit" label={label} buttonClassName="min-h-[52px] rounded-2xl">
      <Text style={{ fontFamily: FONT[400], fontSize: 13.5, lineHeight: 19, color: '#5B6B84' }}>{t('rv_intro')}</Text>
      <ServiceCard
        serviceKey={view.service.key} name={view.service.name} label={t('rv_selected_service')}
        changeLabel={t('req_change')} changeAccessibilityLabel={t('rv_change_service')} onChange={changeService}
      />
      {view.show.patient ? (
        <ReviewSection title={t(view.patient.titleKey)} editLabel={t('req_edit')} editAccessibilityLabel={t('rv_edit_patient')} onEdit={() => goToStep(1)}>
          <Card><PatientGrid fields={view.patient.fields} /></Card>
        </ReviewSection>
      ) : null}
      {view.show.trip ? (
        <ReviewSection title={t('rd_trip')} editLabel={t('req_edit')} editAccessibilityLabel={t('rv_edit_trip')} onEdit={() => goToStep(1)}>
          <Trip trip={view.trip} t={t} />
        </ReviewSection>
      ) : null}
      {view.show.medical ? (
        <ReviewSection title={t('rd_medical')} editLabel={t('req_edit')} editAccessibilityLabel={t('rv_edit_medical')} onEdit={() => goToStep(2)}>
          <MedicalCard medical={view.medical} t={t} pair />
        </ReviewSection>
      ) : null}
      {view.show.documents ? (
        <ReviewSection title={t('rd_documents_n', { n: view.documents.length })} editLabel={t('req_edit')} editAccessibilityLabel={t('rv_edit_documents')} onEdit={() => goToStep(2)}>
          <Card padding={0} style={{ overflow: 'hidden' }}>
            {view.documents.map((doc, i) => <DocumentRow key={doc.id} doc={doc} first={i === 0} t={t} />)}
          </Card>
        </ReviewSection>
      ) : null}
    </RequestFrame>
  );
}
