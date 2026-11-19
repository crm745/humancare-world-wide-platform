import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmQuotation, createNewVersion, fetchQuotationFile, listCaseQuotations, publishQuotation, withdrawQuotation } from './api';
import { errorNotice, successText } from './quotationView.mjs';
import { saveBlob } from '../requests/saveBlob';

/**
 * Loads a Case's quotation versions and runs the Admin's actions on them.
 *  - `notFound`: the server says this Case has no quotations (not a Private Charter Case): the section is not shown.
 *  - `dialog`:   null, or { type: 'confirm' | 'publish' | 'withdraw' | 'newVersion', quotation } while a confirmation is open.
 *  - `notice`:   { tone, text } for the page; `dialogError` is shown inside the open dialog; `error` is a failed load.
 * One state-changing action runs at a time (the ref is checked synchronously, before React re-renders the disabled button), and every call names
 * the revision the Admin looked at. After any success, and after a 404/409 answer, the list is fetched again, so the screen shows what the server holds.
 */
export function useQuotations(caseId) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ data: null, loading: caseId != null, error: null, notFound: false });
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [fileBusyId, setFileBusyId] = useState(null);
  const saving = useRef(false);
  const filing = useRef(false);

  useEffect(() => {
    if (caseId == null) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));
    listCaseQuotations(caseId, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setState({ data, loading: false, error: null, notFound: false }); })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const notFound = err.status === 404;
        setState((prev) => ({ data: notFound ? null : prev.data, loading: false, error: notFound ? null : err.message || 'Could not load the quotations.', notFound }));
      });
    return () => controller.abort();
  }, [caseId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const openDialog = useCallback((type, quotation) => { setNotice(null); setDialogError(null); setDialog({ type, quotation }); }, []);
  const closeDialog = useCallback(() => { if (saving.current) return; setDialog(null); setDialogError(null); }, []);

  // `reason` is only used by Withdraw (validated by the dialog; the server checks it again).
  const submit = useCallback(async (reason) => {
    if (saving.current || !dialog) return;
    saving.current = true;
    setBusy(true);
    setDialogError(null);
    const { type, quotation: q } = dialog;
    const run = { confirm: () => confirmQuotation(q.id, q.revision), publish: () => publishQuotation(q.id, q.revision), withdraw: () => withdrawQuotation(q.id, q.revision, reason), newVersion: () => createNewVersion(q.id, q.revision) }[type];
    try {
      const result = await run();
      setDialog(null);
      setNotice({ tone: 'success', text: successText(type, result, q) });
      reload();
    } catch (err) {
      const info = errorNotice(err, 'The action');
      if (info.refresh) {
        setDialog(null);
        setNotice({ tone: info.tone, text: info.text });
        reload();
      } else {
        setDialogError(info.text); // network / 400 / server error: the dialog stays open so the Admin can retry
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [dialog, reload]);

  // View opens the PDF from a blob in a new tab; Download saves it. Both go through the same authenticated call, which the server audits.
  const openFile = useCallback(async (q, caseReference, mode) => {
    if (filing.current) return;
    filing.current = true;
    setFileBusyId(q.id);
    setNotice(null);
    try {
      const blob = await fetchQuotationFile(q.id, { inline: mode === 'view' });
      if (mode === 'view') {
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        saveBlob(blob, `${caseReference || 'case'}-quotation-v${q.versionNumber}.pdf`);
      }
    } catch (err) {
      const info = errorNotice(err, 'The PDF');
      setNotice({ tone: info.tone, text: info.text });
      if (info.refresh) reload();
    } finally {
      filing.current = false;
      setFileBusyId(null);
    }
  }, [reload]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return { ...state, reload, dialog, busy, dialogError, notice, fileBusyId, openDialog, closeDialog, submit, openFile, dismissNotice };
}
