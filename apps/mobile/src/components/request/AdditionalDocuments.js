import { useState } from 'react';
import { View } from 'react-native';
import { RefreshCw, Upload } from 'lucide-react-native';
import { COLORS } from '../../theme/colors';
import { useApp } from '../../state/AppContext';
import { errorText } from '../../lib/errorText';
import { apiGet, apiUpload } from '../../lib/api';
import { MAX_REPORT_FILES } from '../../data/mock';
import { pendingFiles } from '../../lib/requestUploads';
import { documentHistory, reviewState, uploadBlockReason, MAX_DOCUMENTS_PER_REQUEST } from '../../lib/requestDocuments';
import { recoverAdditionalDocuments, remainingSlots } from '../../lib/additionalUploads';
import { openDocumentRequests } from '../../lib/documentRequests';
import { formatDisplayDate } from '../../lib/requestShape';
import { stampUploadIds, uploadSummary } from '../../lib/uploadRecovery';
import { secureUuid } from '../../lib/secureRandom';
import { UploadStatusList } from './UploadStatusList';
import { usePendingUploads } from './PendingUploadsNotice';
import { uploadJournal } from '../../lib/uploadJournalDevice';
import { Button, Text } from '../ui';
import { Card, Section } from './DetailsParts';
import { ReportTiles } from './fields';

const BLOCKED_TEXT = (t) => ({ approved: t('ad_blocked_approved'), limit: t('ad_blocked_limit', { max: MAX_DOCUMENTS_PER_REQUEST }) });

// After the approval nothing can be added on the patient's own: the only way is to answer a document request an Admin opened on
// the Case (shown as its own card, one "Send documents" button each; the upload carries that request's id).
// Send more documents to a request that is in the review workflow, or replace a rejected one. The request
// and its REQ reference are never touched: every file goes to the request already open on the screen.
// Shown only for such requests (reviewStatus set); nothing is rendered for older requests and other services.
// `onUploaded` is called once each time an upload run finishes (all sent, or some failed) so the screen can reload.
export default function AdditionalDocuments({ request, onUploaded, pendingUploads: shared = null }) {
  const { t, toast } = useApp();
  const [panel, setPanel] = useState(null); // null, or { target: null | { id, name }, documentRequest: null | { id, description } } (target = the document being replaced)
  const [files, setFiles] = useState([]);
  const [uploaded, setUploaded] = useState([]); // uri of every file the server accepted in this panel
  const [errors, setErrors] = useState({}); // { uri: message } for the files the server refused on the last run
  const [unknown, setUnknown] = useState({}); // { uri: message } for the files whose answer never arrived: the server may have them (Phase 5)
  const [running, setRunning] = useState(null); // null, or { index, total, progress } while files upload
  const [sendingUri, setSendingUri] = useState(null); // the file being sent right now
  // After a restart: uploads of this request whose outcome was never confirmed (lib/uploadJournal.js). Adding files waits until the person has checked them (`gated`).
  // (The screen shows the notice itself and passes the same state in, so the notice and this panel agree on whether the check has been done.)
  const own = usePendingUploads(shared ? null : request.id, { onChecked: onUploaded });
  const pendingUploads = shared || own;
  const gated = pendingUploads.gated;

  if (reviewState(request) === null) return null;

  const documents = request.requestDocuments || [];
  const blocked = uploadBlockReason(request, documents);
  const documentRequests = blocked === 'approved' && remainingSlots(documents) > 0 ? openDocumentRequests(request) : [];
  if (blocked && !(blocked === 'approved' && documentRequests.length)) {
    return (
      <Section title={t('ad_add_documents')}>
        <Card>
          <Text className="text-[13px] leading-5 text-muted">{BLOCKED_TEXT(t)[blocked]}</Text>
        </Card>
      </Section>
    );
  }

  // Current documents that were rejected, could not be accepted or could not be checked; an earlier (replaced) version never qualifies.
  const replaceable = documentHistory(documents).filter((d) => d.canReplace);
  const busy = !!running;
  const pending = pendingFiles(files, uploaded);
  const fetchRequest = (id) => apiGet(`/requests/me/${id}`);
  const replacing = panel?.target || null;
  const answering = panel?.documentRequest || null;

  const open = (target, documentRequest = null) => { setPanel({ target, documentRequest }); setFiles([]); setUploaded([]); setErrors({}); setUnknown({}); };
  const close = () => { setPanel(null); setFiles([]); setUploaded([]); setErrors({}); setUnknown({}); };

  // A file taken off the list is forgotten, so choosing it again sends it again.
  const changeFiles = (next) => {
    const keep = new Set(next.map((f) => f.uri));
    setFiles(next);
    setUploaded((u) => u.filter((uri) => keep.has(uri)));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([uri]) => keep.has(uri))));
    setUnknown((u) => Object.fromEntries(Object.entries(u).filter(([uri]) => keep.has(uri))));
  };

  // Sends the files that may be sent. Each carries its own upload id (made once, here, so every retry of the file sends the same one). A file still waiting to be checked is first looked
  // for on the server (by that id); only files confirmed missing, never sent, or refused are sent. A cancel before anything was sent is certain; after, the outcome is unknown.
  const run = async () => {
    // Re-attached files take the ids of earlier unconfirmed uploads first (the original, if it arrives late, is then recognised as the same upload and kept once).
    const stamped = stampUploadIds(files, secureUuid, pendingUploads.ids);
    if (stamped !== files) setFiles(stamped);
    setRunning({ index: 1, total: Math.max(1, uploadSummary(stamped, { uploaded, unknown, errors }).sendable.length), progress: 0 });
    let finished = false;
    try {
      const result = await recoverAdditionalDocuments({
        requestId: request.id,
        target: replacing,
        documentRequest: answering,
        files: stamped,
        uploaded,
        uploadErrors: errors,
        uploadUnknown: unknown,
        fetchRequest,
        generateId: secureUuid,
        adoptIds: pendingUploads.ids,
        journal: uploadJournal,
        send: (path, file, onProgress, fields) => apiUpload(path, file, false, onProgress, fields),
        onProgress: setRunning,
        onFile: (file) => setSendingUri(file ? file.uri : null),
      });
      setUploaded(result.uploaded);
      setErrors(result.uploadErrors);
      setUnknown(result.uploadUnknown);
      finished = !pendingFiles(stamped, result.uploaded).length;
      const failed = Object.keys(result.uploadErrors).length;
      const waiting = Object.keys(result.uploadUnknown).length;
      if (finished) toast(replacing ? t('ad_sent_replace') : t('ad_sent_docs'));
      else if (failed || waiting) toast(t('net_try_again'));
    } catch (err) {
      toast(errorText(err, t));
    } finally {
      setRunning(null);
      setSendingUri(null);
      pendingUploads.reload();
    }
    if (finished) close();
    await onUploaded?.();
  };

  const summary = uploadSummary(files, { uploaded, unknown, errors }, sendingUri);
  const hasHistory = Object.keys(errors).length > 0 || Object.keys(unknown).length > 0;
  const buttonLabel = busy
    ? t('req_uploading').replace('{i}', running.index).replace('{n}', running.total).replace('{p}', Math.round(running.progress * 100))
    : hasHistory
      ? t('sk_try_again')
      : replacing ? 'Upload replacement' : pending.length ? `Upload ${pending.length} file${pending.length === 1 ? '' : 's'}` : 'Upload';

  if (panel) {
    return (
      <Section title={replacing ? t('ad_replace_title') : answering ? 'Send requested documents' : 'Add documents'}>
      <Card>
        {replacing ? <Text className="mb-3.5 font-inter-bold text-[14.5px] text-navy" numberOfLines={2}>{replacing.name}</Text> : null}
        {!!answering && <Text className="mb-3.5 text-[13px] leading-5 text-muted">{answering.description}</Text>}
        <View pointerEvents={busy ? 'none' : 'auto'} style={{ opacity: busy ? 0.6 : 1 }}>
          <ReportTiles
            title={replacing ? 'New file' : 'Files'}
            files={files}
            onChange={changeFiles}
            multiple={!replacing}
            maxFiles={Math.min(MAX_REPORT_FILES, remainingSlots(documents))}
          />
        </View>

        {files.length > 0 && (
          <View className="mt-4">
            <UploadStatusList bare files={files} state={{ uploaded, unknown, errors }} sendingUri={sendingUri} progress={running ? running.progress : 0} />
          </View>
        )}

        <Button title={buttonLabel} onPress={run} loading={busy} disabled={!summary.canRetry || gated} needsNetwork className="mt-4 w-full" icon={hasHistory && !busy ? <RefreshCw size={18} color="#FFFFFF" strokeWidth={2.4} /> : undefined} />
        {!busy && <Button variant="ghost" title={t('sos_modal_cancel')} onPress={close} className="mt-2.5 w-full" />}
      </Card>
      </Section>
    );
  }

  if (blocked === 'approved') {
    return (
      <Section title={t('ad_requested_title')}>
      <Card>
        <Text className="text-[13px] leading-5 text-muted">Your request is approved. Please send the documents below; your request and reference stay the same.</Text>
        {documentRequests.map((item) => (
          <View key={item.id} className="mt-4 rounded-xl border border-line p-3">
            <Text className="font-inter-bold text-[13.5px] text-navy">{item.description}</Text>
            {!!item.reason && <Text className="mt-0.5 text-[12.5px] leading-[18px] text-muted">{item.reason}</Text>}
            {!!item.createdAt && <Text className="mt-0.5 text-[12px] text-faint">{`Requested ${formatDisplayDate(item.createdAt)}`}</Text>}
            <Button variant="outline" title={t('ad_send_documents')} onPress={() => open(null, { id: item.id, description: item.description })} className="mt-3" />
          </View>
        ))}
      </Card>
      </Section>
    );
  }

  return (
    <Section title={t('ad_add_documents')}>
    <Card>
      <Text className="text-[13px] leading-5 text-muted">{t('ad_send_more')}</Text>
      {replaceable.map((doc) => (
        <View key={doc.id} className="mt-4 rounded-xl border border-danger-line p-3">
          <Text className="font-inter-bold text-[13.5px] text-navy" numberOfLines={2}>{doc.name}</Text>
          <Text className="mt-0.5 text-[12.5px] text-danger">{doc.rejectionReason || doc.guidance || doc.statusLabel}</Text>
          <Button variant="outline" title={t('ad_replace')} onPress={() => open({ id: doc.id, name: doc.name })} className="mt-3" />
        </View>
      ))}
      <Button variant="outline" title={t('ad_add_documents')} onPress={() => open(null)} disabled={gated} icon={<Upload size={18} color={COLORS.primary} strokeWidth={2.2} />} className="mt-4 w-full" />
      {gated ? <Text className="mt-2 text-center text-[13px] text-muted">{t('up_available_after_check')}</Text> : null}
    </Card>
    </Section>
  );
}
