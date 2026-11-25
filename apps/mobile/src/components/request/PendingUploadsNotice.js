import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { apiGet } from '../../lib/api';
import { checkStoredUploads, storedCheckKey } from '../../lib/uploadRecovery';
import { uploadJournal } from '../../lib/uploadJournalDevice';
import { RefreshCw } from 'lucide-react-native';
import { Button } from '../ui';
import { StatusNotice } from '../network/StatusNotice';
import { COLORS } from '../../theme/colors';

// AFTER A RESTART (Phase 5, lib/uploadJournal.js). If the app was closed or killed while a file was being sent, the file is gone from the phone but the journal still holds the upload's
// random id. This reads the request's own document list and matches those ids (nothing is sent). Until it has been asked, adding more files to the request is switched off
// (`gated`), so a new attachment is never mistaken for a safe retry of an upload that may already have arrived. What a check finds is explained plainly, never as "failed":
//   found          the server has it: forgotten
//   missing        the server certainly does not have it (it keeps upload ids and gave the list): attach the file again; the id is kept, so a late arrival of the original is still recognised
//   cannot confirm an older server, or an incomplete answer: nothing is assumed; look at the documents listed and attach again only what is missing
//   unreachable    could not ask: nothing changes
export function usePendingUploads(requestId, { onChecked } = {}) {
  const [ids, setIds] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [key, setKey] = useState(null);
  const has = requestId !== null && requestId !== undefined && requestId !== '';

  const reload = useCallback(() => (has ? uploadJournal.idsFor(requestId).then(setIds, () => undefined) : Promise.resolve()), [has, requestId]);
  useEffect(() => {
    let alive = true;
    if (!has) return undefined;
    uploadJournal.idsFor(requestId).then((found) => { if (alive) { setIds(found); setChecked(false); setKey(null); } }, () => undefined);
    return () => { alive = false; };
  }, [has, requestId]);

  const check = async () => {
    if (checking || !ids.length) return;
    setChecking(true);
    try {
      const result = await checkStoredUploads({ requestId, ids, fetchRequest: (id) => apiGet(`/requests/me/${id}`) });
      if (result.result !== 'unreachable') {
        await uploadJournal.forget(requestId, result.found);
        setIds((previous) => previous.filter((id) => !result.found.includes(id)));
        setChecked(true);
        if (result.found.length) await onChecked?.();
      }
      setKey(storedCheckKey(result));
    } finally {
      setChecking(false);
    }
  };
  return { ids, checking, checked, key, check, reload, gated: ids.length > 0 && !checked };
}

// The notice for uploads that may not have finished (a warning card with its own Try again; after the check, if something is missing, an info card). Nothing in it sends anything: Try again only asks.
export function PendingUploadsNoticeView({ state }) {
  const { t } = useApp();
  if (!state.ids.length) return null; // nothing is waiting, or every earlier upload was found on the server
  if (state.checked) return <StatusNotice tone="info" icon="info" text={t('up_restart_missing')} />; // the server was asked and some earlier files are not there (or it cannot tell)
  return (
    <StatusNotice tone="warning" icon="alert" title={t('up_restart_simple')} text={t('up_restart_text')}>
      <View style={{ marginTop: 12 }}>
        <Button
          variant="outline" title={state.checking ? t('up_checking') : t('sk_try_again')} onPress={state.check} loading={state.checking} needsNetwork className="min-h-[44px] rounded-xl"
          icon={<RefreshCw size={18} color={COLORS.primary} strokeWidth={2.4} />}
        />
      </View>
    </StatusNotice>
  );
}

// For a request that has no Add documents panel (the original flow): the same notice on its own.
export function PendingUploadsNotice({ requestId, onChecked }) {
  const state = usePendingUploads(requestId, { onChecked });
  return <PendingUploadsNoticeView state={state} />;
}
