import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { needsCareLevel, useApp } from '../../state/AppContext';
import SERVICES from '../../data/services.json';
import { isMortal, requestService } from '../../data/mock';
import { errorText } from '../../lib/errorText';
import { navReplace } from '../../lib/nav';
import { apiGet, apiPost, apiUpload } from '../../lib/api';
import { submissionTracker } from '../../lib/pendingSubmissionStore';
import { afterFailure, afterSaved, postWithKey } from '../../lib/requestSubmission';
import { blockedError, checkBeforeSend, isBlocked } from '../../lib/submissionGate';
import { runSubmission } from '../../lib/requestUploads';
import { fieldsFor } from '../../lib/additionalUploads';
import { secureUuid } from '../../lib/secureRandom';
import { uploadJournal } from '../../lib/uploadJournalDevice';
import { asksEquipment, asksPatientMobility, needsOxygenRate, parseOxygenLpm, usesCriticalLevels } from '../../lib/requestForm';
import {
  buildPrivateCharterPayload, fieldErrorsFromError, firstErrorLocation, isPrivateCharter, mobilityList, needsDocument, singleChoice, toCityChoice, unplacedMessages,
} from '../../lib/privateCharter';
import { resolveCharterCities } from '../../lib/citySearch';
import { goToStep, RequestFrame } from '../../components/request/RequestFrame';
import { Card, FONT } from '../../components/request/DetailsParts';
import { DocumentRow, MedicalCard, PatientGrid, Trip } from '../../components/request/DetailsBlocks';
import { ReviewSection, ServiceCard } from '../../components/request/ReviewParts';
import { StatusNotice } from '../../components/network/StatusNotice';
import { COLORS } from '../../theme/colors';
import { reviewView } from '../../lib/reviewView';
import { buildTelePayload, isTeleService } from '../../lib/teleConsultation';
import { buildMortalPayload } from '../../lib/mortalRemains';
import { buildHomePayload, isHomeService } from '../../lib/homeHealthcare';
import { buildMvtPayload, isMvtService } from '../../lib/medicalValueTravel';
import { buildMarinePayload, isMarineService } from '../../lib/marineMedicalSafety';
import { buildCorporatePayload, isCorporateService } from '../../lib/corporateMedical';

// Step 3 of 3: check everything, then submit.
export default function RequestReview() {
  const { t, draft: d, updateDraft, toast, setServerErrors, discardDraft } = useApp();
  const [busy, setBusy] = useState(false);
  // null while the files are not uploading; otherwise which file, out of how many, and how far.
  const [uploading, setUploading] = useState(null);
  const [retryable, setRetryable] = useState(false); // the last send could not be confirmed: the same button now says "Try again"
  const [notice, setNotice] = useState(null); // what happened to the last send, shown above the button: 'lost' (could not be confirmed) | 'sent' (already sent) | null
  // Idempotent submission (lib/submissionKey.js, lib/requestSubmission.js): every send carries this submission's key, made on the first send and reused by every retry, so the server saves the
  // request once however many times it arrives. If the answer is lost the person sees ONE short message and presses the same Submit button again: nothing is sent by itself, and the retry sends
  // the original under the same key.
  const send = async (body) => {
    // A retry sends the ORIGINAL payload under the same key; a form changed since is refused here (nothing sent) and handled below.
    const out = await postWithKey(submissionTracker, apiPost, body, { service: serviceKey });
    await afterSaved(submissionTracker); // the server said it saved the request: this submission is finished
    discardDraft().catch(() => undefined); // and its saved draft (and key) is deleted: the request exists now
    return out;
  };
  const { title: serviceTitle, key: serviceKey } = requestService(d, SERVICES);
  // EVERY send of a request goes through here (lib/submissionGate.js). If an earlier submission of this account is unresolved (its answer was lost, or the app was closed while it was being
  // sent, even before a restart) the server is asked about it FIRST: it is never sent again if the server has it, the same key and original payload are used if it does not, and if the server
  // cannot be asked nothing is sent and the person presses the button again. A new key is never made while an earlier one for the same request is unresolved.
  const guardedSend = async (body) => {
    const gate = await checkBeforeSend({ tracker: submissionTracker, apiGet, service: serviceKey, body });
    if (gate.action === 'blocked') throw blockedError(gate.reason);
    if (gate.action === 'found') { discardDraft().catch(() => undefined); return { request: gate.request }; } // the earlier request is the result
    return send(body);
  };
  // Saves the request once (the Phase 4 key) and then sends its documents (Phase 5), one at a time, for EVERY service that takes documents. Each file carries its own upload id, so a retry
  // is recognised by the server; a file whose answer never arrived is kept (never sent again blindly) and the Submitted screen offers one "Try again".
  const sendWithDocuments = async (buildBody) => {
    try {
      const result = await runSubmission({
        sentRequest: d.sentRequest, uploaded: d.uploaded, uploadErrors: d.uploadErrors, uploadUnknown: d.uploadUnknown, files: d.files, generateId: secureUuid, journal: uploadJournal,
        createRequest: async () => {
          const { request } = await guardedSend(buildBody());
          return { id: request.id, referenceNumber: request.referenceNumber, title: serviceTitle };
        },
        upload: (file, onProgress, sent) => apiUpload(`/requests/me/${sent.id}/documents`, file, false, onProgress, fieldsFor(file)),
        onSent: updateDraft,
        onProgress: setUploading,
      });
      const { note: _note, ...state } = result; // the Submitted screen shows which files still need a "Try again"
      updateDraft(state);
      navReplace({ pathname: '/request/submitted', params: { id: result.sentRequest.referenceNumber, requestId: result.sentRequest.id, service: serviceTitle } });
    } finally {
      setUploading(null);
    }
  };
  const transport = needsCareLevel(d.service);
  const mortal = isMortal(d.service);

  const changeService = () => {
    updateDraft({ changingService: true });
    router.push('/all-services');
  };

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (isTeleService(d.service)) {
        // Teleconsultation: the structured request (lib/teleConsultation.js). The server derives the address fields and the description. It takes
        // no documents, so nothing is uploaded.
        const { request } = await guardedSend(buildTelePayload(d));
        navReplace({ pathname: '/request/submitted', params: { id: request.referenceNumber, requestId: request.id, service: serviceTitle } });
        return;
      }
      if (isCorporateService(d.service)) {
        // Corporate Medical Solutions: the structured request (lib/corporateMedical.js). The server stores each field in its own place and gives the request and its
        // Case a CASE- reference. It takes no documents, so nothing is uploaded.
        const { request } = await guardedSend(buildCorporatePayload(d));
        navReplace({ pathname: '/request/submitted', params: { id: request.referenceNumber, requestId: request.id, service: serviceTitle } });
        return;
      }
      if (isPrivateCharter(d.service)) {
        // At least one document is required: nothing is sent (and no request is saved) without one.
        if (needsDocument(d)) {
          toast(t('req_err_need_doc'));
          goToStep(2);
          return;
        }
        // Private Charter is sent exactly as the server's validator expects it (see lib/privateCharter).
        // The request is saved once; a file that is refused or not confirmed stays listed (the next screen says which and
        // offers Check status / Retry missing) and the answers and chosen files are kept (see lib/requestUploads).
        // A place typed while the phone was offline (step 1 only collects it) is matched to the verified city list now, online, before anything is sent. If it names no single city, nothing is sent
        // and the person is taken back to pick one.
        let charterDraft = d;
        if (!d.originCity || !d.destCity) {
          const patch = await resolveCharterCities(apiGet, d, toCityChoice);
          charterDraft = { ...d, ...patch };
          if (Object.keys(patch).length) updateDraft(patch);
          if (!charterDraft.originCity || !charterDraft.destCity) { toast(t('req_pick_city')); goToStep(1); return; }
        }
        await sendWithDocuments(() => buildPrivateCharterPayload(charterDraft));
        return;
      }
      // Every other service keeps the body it has always sent. Mortal Remains sends its own structured body (lib/mortalRemains.js); its files go up
      // one by one below, like the others.
      // Home Healthcare sends its own structured body too (lib/homeHealthcare.js); its reports go up one by one below, like the others.
      const buildBody = () => (mortal ? buildMortalPayload(d) : isHomeService(d.service) ? buildHomePayload(d) : isMvtService(d.service) ? buildMvtPayload(d) : isMarineService(d.service) ? buildMarinePayload(d) : {
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
        // Commercial Air and Ground send their care levels as keys ("crit_icu,crit_ecmo"); every other service sends the labels, as always.
        careLevel: transport && d.care.length ? (usesCriticalLevels(d.service) ? d.care.join(',') : d.care.map(t).join(', ')) : undefined,
        description: d.desc || undefined, // "Condition & diagnosis" (or the Mortal Remains details)
        // Only patient transport has these; the server refuses them for any other service.
        ...(transport ? {
          // Commercial Air and Ground do not ask Patient mobility (Commercial Air's Travel type is in the service key); Ground asks Oxygen only on board.
          // (The draft keeps mobility as a list of chosen keys: at most one is sent.)
          ...(asksPatientMobility(d.service) ? { mobility: singleChoice(mobilityList(d.mobility)) || undefined } : {}),
          equipOxygen: d.equipOxygen,
          // Commercial Air and Ground only, and only while Oxygen is on: the flow rate in LPM, as a number.
          ...(needsOxygenRate(d.service) && d.equipOxygen ? { equipOxygenLpm: parseOxygenLpm(d.oxygenLpm) } : {}),
          ...(asksEquipment(d.service, 'equipCardiac') ? { equipCardiacMonitor: d.equipCardiac } : {}),
          ...(asksEquipment(d.service, 'equipVentilator') ? { equipVentilator: d.equipVentilator } : {}),
        } : {}),
        urgency: d.urgency || undefined,
      });
      // The request is saved once, and then its documents go up one by one (every service that takes documents: Mortal Remains, Home Healthcare, Medical Value Travel, Marine, patient
      // transport). A file that is refused or not confirmed never undoes the request: the Submitted screen lists every file's state.
      await sendWithDocuments(buildBody);
    } catch (err) {
      setUploading(null);
      // The answer may simply never have arrived: the request MAY have been saved. That is not a failure the server confirmed, so it is not shown as one (no error toast, no
      // field errors): the person is asked to check, or to submit again with the SAME key (the server saves it once). Nothing is sent again by itself.
      // The earlier submission could not be checked (or was already sent): nothing was sent, and one short message says so. The same button is the retry.
      if (isBlocked(err)) { setRetryable(true); setNotice(err.reason === 'already_sent' ? 'sent' : 'lost'); return; }
      const outcome = await afterFailure(submissionTracker, err);
      // The form was changed after the first send and NOTHING was sent: the person is told the request was already sent (the original may exist), never silently given the original or
      // silently losing the changes. A lost answer, or a refusal of a later attempt while an earlier one is unknown, is one short message: pressing Submit again is the retry.
      if (outcome === 'edited') { setNotice('sent'); return; }
      if (outcome === 'unconfirmed' || submissionTracker.isUnconfirmed()) { setRetryable(true); setNotice('lost'); return; }
      // The server refused a field: the form is left exactly as it was, each message goes under its
      // field, and the person is taken to the first step that has one.
      const fields = fieldErrorsFromError(err, t);
      if (fields) {
        setServerErrors(fields);
        const { step } = firstErrorLocation(fields);
        const other = unplacedMessages(fields);
        toast(other.length ? other[0] : errorText(err, t));
        if (step) goToStep(step);
      } else {
        toast(errorText(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  // While files upload the button itself says how far it is: nothing sits under the button.
  const label = uploading
    ? t('req_uploading').replace('{i}', uploading.index).replace('{n}', uploading.total).replace('{p}', Math.round(uploading.progress * 100))
    : retryable ? t('sk_try_again') : undefined;
  // While files upload the button is the progress bar: the share of ALL the files sent so far (the finished ones, and how far the current one is).
  const progress = uploading ? Math.max(0, Math.min(1, ((uploading.index - 1) + uploading.progress) / Math.max(1, uploading.total))) : null;
  // The notice above the button replaces the old toasts: it stays until the next press, and says what happened in the person's words (lib/submissionGate.js decides which).
  const sendNotice = notice === 'lost' ? (
    <StatusNotice tone="warning" icon="alert" title={t('sub_lost_title')} text={t('sub_lost_text')} />
  ) : notice === 'sent' ? (
    <StatusNotice tone="info" icon="info" title={t('sub_sent_title')} text={t('sub_sent_text')}>
      <Pressable accessibilityRole="link" onPress={() => router.push('/my-requests')} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
        <Text className="font-inter-bold" style={{ fontSize: 14, color: COLORS.primary }}>{t('sub_open_requests')}</Text>
      </Pressable>
    </StatusNotice>
  ) : null;

  // What is shown: worked out in lib/reviewView.js (empty fields and empty sections are left out). Each Edit goes to the step that holds that
  // section, as before; Change picks another service from the form.
  const view = reviewView(d, { key: serviceKey, title: serviceTitle }, t);

  return (
    <RequestFrame step={3} showService={false} onNext={submit} busy={busy} needsNetwork nextKey="req_submit" label={label} notice={sendNotice} progress={progress} refreshIcon={retryable} buttonClassName="min-h-[52px] rounded-2xl">
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
