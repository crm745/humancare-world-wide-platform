import { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { apiUpload } from '../../lib/api';
import { MAX_REPORT_FILES } from '../../data/mock';
import { pendingFiles } from '../../lib/requestUploads';
import { documentHistory, reviewState, uploadBlockReason, MAX_DOCUMENTS_PER_REQUEST } from '../../lib/requestDocuments';
import { remainingSlots, sendAdditionalDocuments } from '../../lib/additionalUploads';
import { Button, Text } from '../ui';
import { Card, Section } from './DetailsParts';
import { ReportTiles } from './fields';

const BLOCKED_TEXT = {
  approved: 'This request has been approved. Please contact HumanCare to add more documents.',
  limit: `This request already holds the most documents it can (${MAX_DOCUMENTS_PER_REQUEST}). Please contact HumanCare to add more.`,
};

// Send more documents to a request that is in the review workflow, or replace a rejected one. The request
// and its REQ reference are never touched: every file goes to the request already open on the screen.
// Shown only for such requests (reviewStatus set); nothing is rendered for older requests and other services.
// `onUploaded` is called once each time an upload run finishes (all sent, or some failed) so the screen can reload.
export default function AdditionalDocuments({ request, onUploaded }) {
  const { t, toast } = useApp();
  const [panel, setPanel] = useState(null); // null, or { target: null | { id, name } } (target = the document being replaced)
  const [files, setFiles] = useState([]);
  const [uploaded, setUploaded] = useState([]); // uri of every file the server accepted in this panel
  const [errors, setErrors] = useState({}); // { uri: message } for the files that failed on the last run
  const [running, setRunning] = useState(null); // null, or { index, total, progress } while files upload

  if (reviewState(request) === null) return null;

  const documents = request.requestDocuments || [];
  const blocked = uploadBlockReason(request, documents);
  if (blocked) {
    return (
      <Section title="Add documents">
        <Card>
          <Text className="text-[13px] leading-5 text-muted">{BLOCKED_TEXT[blocked]}</Text>
        </Card>
      </Section>
    );
  }

  // Current documents that were rejected, could not be accepted or could not be checked; an earlier (replaced) version never qualifies.
  const replaceable = documentHistory(documents).filter((d) => d.canReplace);
  const busy = !!running;
  const pending = pendingFiles(files, uploaded);
  const failedCount = pending.filter((f) => errors[f.uri]).length;
  const replacing = panel?.target || null;

  const open = (target) => { setPanel({ target }); setFiles([]); setUploaded([]); setErrors({}); };
  const close = () => { setPanel(null); setFiles([]); setUploaded([]); setErrors({}); };

  // A file taken off the list is forgotten, so choosing it again sends it again.
  const changeFiles = (next) => {
    const keep = new Set(next.map((f) => f.uri));
    setFiles(next);
    setUploaded((u) => u.filter((uri) => keep.has(uri)));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([uri]) => keep.has(uri))));
  };

  const run = async () => {
    setRunning({ index: 1, total: pending.length, progress: 0 });
    let finished = false;
    try {
      const result = await sendAdditionalDocuments({
        requestId: request.id,
        target: replacing,
        files,
        uploaded,
        uploadErrors: errors,
        send: (path, file, onProgress, fields) => apiUpload(path, file, false, onProgress, fields),
        onProgress: setRunning,
      });
      setUploaded(result.uploaded);
      setErrors(result.uploadErrors);
      finished = !pendingFiles(files, result.uploaded).length;
      const failed = Object.keys(result.uploadErrors).length;
      if (finished) toast(replacing ? 'Replacement sent. We will review it shortly.' : 'Documents sent. We will review them shortly.');
      else toast(`${failed} file${failed > 1 ? 's' : ''} did not upload. You can retry below.`);
    } catch (err) {
      toast(err.message);
    } finally {
      setRunning(null);
    }
    if (finished) close();
    await onUploaded?.();
  };

  const current = running ? pending[running.index - 1] : null;
  const fileStatus = (file) => {
    if (uploaded.includes(file.uri)) return { text: 'Uploaded', className: 'text-success' };
    if (busy) {
      return file === current
        ? { text: `Uploading… ${Math.round(running.progress * 100)}%`, className: 'text-primary' }
        : { text: 'Waiting', className: 'text-faint' };
    }
    if (errors[file.uri]) return { text: errors[file.uri], className: 'text-danger' };
    return null;
  };

  const buttonLabel = busy
    ? t('req_uploading').replace('{i}', running.index).replace('{n}', running.total).replace('{p}', Math.round(running.progress * 100))
    : failedCount
      ? `Retry failed uploads (${failedCount})`
      : replacing ? 'Upload replacement' : pending.length ? `Upload ${pending.length} file${pending.length === 1 ? '' : 's'}` : 'Upload';

  if (panel) {
    return (
      <Section title={replacing ? 'Replace a document' : 'Add documents'}>
      <Card>
        {replacing ? <Text className="mb-3.5 font-inter-bold text-[14.5px] text-navy" numberOfLines={2}>{replacing.name}</Text> : null}
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
          <View className="mt-4 gap-2.5">
            {files.map((file) => {
              const status = fileStatus(file);
              return (
                <View key={file.uri}>
                  <Text className="font-inter-bold text-[13px] text-navy" numberOfLines={1}>{file.name}</Text>
                  {status && <Text className={`mt-0.5 text-[12.5px] ${status.className}`} accessibilityRole={errors[file.uri] && !busy ? 'alert' : undefined}>{status.text}</Text>}
                </View>
              );
            })}
          </View>
        )}

        <Button title={buttonLabel} onPress={run} loading={busy} disabled={!pending.length} className="mt-4 w-full" />
        {!busy && <Button variant="ghost" title="Cancel" onPress={close} className="mt-2.5 w-full" />}
      </Card>
      </Section>
    );
  }

  return (
    <Section title="Add documents">
    <Card>
      <Text className="text-[13px] leading-5 text-muted">Send more documents for this request. Your request and reference stay the same.</Text>
      {replaceable.map((doc) => (
        <View key={doc.id} className="mt-4 rounded-xl border border-danger-line p-3">
          <Text className="font-inter-bold text-[13.5px] text-navy" numberOfLines={2}>{doc.name}</Text>
          <Text className="mt-0.5 text-[12.5px] text-danger">{doc.rejectionReason || doc.guidance || doc.statusLabel}</Text>
          <Button variant="outline" title="Replace" onPress={() => open({ id: doc.id, name: doc.name })} className="mt-3" />
        </View>
      ))}
      <Button variant="outline" title="Add documents" onPress={() => open(null)} className="mt-4 w-full" />
    </Card>
    </Section>
  );
}
